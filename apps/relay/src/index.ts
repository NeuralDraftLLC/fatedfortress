/**
 * apps/relay/src/index.ts — Worker entry + RelayDO (room-scoped WebRTC / Y.js signaling).
 *
 * Phase 4 — Automated DO orchestration:
 *   - Worker routes WebSocket to env.RELAY.idFromName(roomId) or `${roomId}-shard-${n}`.
 *   - SHARD_THRESHOLD: when the *parent* DO already holds this many peers, new *non-replacement*
 *     connections get { type: "REDIRECT", shardUrl } (reconnect with &shard=N).
 *   - Spectators (?spectator=1): offer / answer / ice-candidate are not routed (Y.js sync still flows).
 *   - POST /_relay/forward — push JSON payload to a connected peer on *this* DO.
 *   - POST /internal/register-shard-peer — shard tells parent peerId → shard index (O(1) map).
 *   - POST /internal/deliver — shard asks parent to route when the target is not local to shard.
 *
 * Global Lobby (Task 1):
 *   - RELAY_REGISTRY Durable Object tracks active rooms with metadata (name, category,
 *     participant count, spectator count, access, price) for the GET /rooms HTTP endpoint.
 *   - Rooms register on first participant join and deregister when the last participant leaves.
 *   - Seed rooms are pre-registered so the lobby is never empty.
 *
 * Demo Mode (Task 2):
 *   - GET /demo/check?ip=X — returns demo rate-limit status for an IP address.
 *     Limits: 10 requests/hour per IP, 200 tokens per session (tracked separately per ip).
 *   - Demo sessions can trigger generation but cannot fork rooms or sign receipts.
 *
 * TURN (Phase TURN-1):
 *   - GET /turn-credentials — returns short-lived Cloudflare TURN ICE server entry.
 *     TURN_KEY_ID and TURN_KEY_API_TOKEN stored as Wrangler secrets (never in source).
 *     WEB_ORIGIN in [vars] locks the CORS header to the SPA origin.
 *
 * Surface Verification (VERIFY-1):
 *   - POST /verify-submission — pre-review surface checks (MIME, size, PR existence, Figma URL).
 *     Runs before the Supabase Edge Function deep-spec gate. GITHUB_TOKEN wrangler secret.
 *
 * Invariants (#2, #9): JSON.parse guarded; reconnect replaces same peerId without leaking peerCount.
 */

import { handleVerifySubmission } from "./verify-submission.js";

export interface Env {
  RELAY: DurableObjectNamespace;
  RELAY_REGISTRY: DurableObjectNamespace;
  /** Wrangler secret — Cloudflare TURN key ID (not the API token) */
  TURN_KEY_ID: string;
  /** Wrangler secret — Cloudflare TURN API token. Never expose to the browser. */
  TURN_KEY_API_TOKEN: string;
  /** [vars] — SPA origin for CORS lock, e.g. "https://fatedfortress.com" */
  WEB_ORIGIN: string;
  /** Wrangler secret — GitHub token for PR-existence check in verify-submission. */
  GITHUB_TOKEN: string;
}

/** Stable relay URL used internally for shard registration and forward calls. */
const RELAY_STUB = "http://relay-internal";

/** Parent DO stops accepting new peers here; they receive REDIRECT (soft cap ~80 × (1 + MAX_SHARDS) peers/room). */
const SHARD_THRESHOLD = 80;
const MAX_SHARDS = 8;

const SIGNALING_TYPES = new Set(["offer", "answer", "ice-candidate"]);

// ── TURN credential handler ───────────────────────────────────────────────────

/**
 * Calls the Cloudflare TURN credential-generation API and returns a single
 * ICE server entry with short-lived username + credential.
 *
 * TTL is 86400 s (24 h) — covers the longest realistic session.
 * Credentials are generated server-side so TURN_KEY_API_TOKEN never reaches
 * the browser.
 */
async function handleTurnCredentials(request: Request, env: Env): Promise<Response> {
  // Only allow GET from the SPA origin (OPTIONS handled below for pre-flight).
  const corsHeaders = {
    "Access-Control-Allow-Origin": env.WEB_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    // Graceful degradation: no TURN configured — caller falls back to STUN-only.
    return new Response(
      JSON.stringify({ iceServers: [] }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  let cfResponse: Response;
  try {
    cfResponse = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 86400 }),
      }
    );
  } catch (err) {
    console.error("[turn] Cloudflare TURN API fetch failed:", err);
    return new Response(
      JSON.stringify({ iceServers: [] }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  if (!cfResponse.ok) {
    console.error("[turn] Cloudflare TURN API returned", cfResponse.status);
    return new Response(
      JSON.stringify({ iceServers: [] }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  // Cloudflare returns: { iceServers: { urls: string[], username: string, credential: string } }
  // We return the inner iceServers object directly; the client wraps it in an array.
  let data: { iceServers: { urls: string[]; username: string; credential: string } };
  try {
    data = await cfResponse.json() as typeof data;
  } catch {
    return new Response(
      JSON.stringify({ iceServers: [] }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  return new Response(
    JSON.stringify({ iceServers: data.iceServers }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Never cache credentials — they are short-lived and per-session.
        "Cache-Control": "no-store, no-cache, must-revalidate",
        ...corsHeaders,
      },
    }
  );
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /turn-credentials — short-lived Cloudflare TURN credentials for the SPA.
    if (url.pathname === "/turn-credentials") {
      return handleTurnCredentials(request, env);
    }

    // POST /verify-submission — surface-level pre-review checks (MIME, size, PR, Figma).
    if (url.pathname === "/verify-submission") {
      return handleVerifySubmission(request, env);
    }

    // GET /rooms — HTTP endpoint returning live room metadata for the lobby grid.
    if (request.method === "GET" && url.pathname === "/rooms") {
      const registryId = env.RELAY_REGISTRY.idFromName("global-registry");
      return env.RELAY_REGISTRY.get(registryId).fetch(request);
    }

    // GET /demo/check?ip=X — demo rate-limit status (10 req/hr per IP, 200 tokens/session).
    if (request.method === "GET" && url.pathname === "/demo/check") {
      const registryId = env.RELAY_REGISTRY.idFromName("global-registry");
      return env.RELAY_REGISTRY.get(registryId).fetch(request);
    }

    const roomId = url.searchParams.get("roomId") ?? "default";
    const shard = url.searchParams.get("shard");
    const name =
      shard !== null && shard !== ""
        ? `${roomId}-shard-${shard}`
        : roomId;
    const id = env.RELAY.idFromName(name);
    return env.RELAY.get(id).fetch(request);
  },
};

// ── RelayRegistryDO — tracks active rooms for the lobby grid ──────────────────

interface RoomMeta {
  id: string;
  name: string;
  category: string;
  hostPubkey: string;
  access: "free" | "paid";
  price?: number;
  participantCount: number;
  spectatorCount: number;
  fuelFraction: number;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
  sessionTokens: number;
}

const DEMO_RATE_LIMIT_WINDOW_MS = 3_600_000;
const DEMO_RATE_LIMIT_MAX = 10;
const DEMO_SESSION_TOKEN_LIMIT = 15_000;

const SEED_ROOMS: RoomMeta[] = [
  {
    id: "rm_seed_animation",
    name: "AI Animation Jam",
    category: "animation",
    hostPubkey: "FatedFortress",
    access: "free",
    participantCount: 0,
    spectatorCount: 0,
    fuelFraction: 1.0,
  },
  {
    id: "rm_seed_code",
    name: "Code Review Room",
    category: "code",
    hostPubkey: "FatedFortress",
    access: "free",
    participantCount: 0,
    spectatorCount: 0,
    fuelFraction: 1.0,
  },
  {
    id: "rm_seed_showcase",
    name: "Paid Showcase",
    category: "showcase",
    hostPubkey: "FatedFortress",
    access: "paid",
    price: 2,
    participantCount: 0,
    spectatorCount: 0,
    fuelFraction: 1.0,
  },
];

export class RelayRegistryDO implements DurableObject {
  private rooms = new Map<string, RoomMeta>();
  private rateLimits = new Map<string, RateLimitEntry>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {
    for (const room of SEED_ROOMS) {
      this.rooms.set(room.id, { ...room });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/rooms") {
      const list = Array.from(this.rooms.values()).map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        hostPubkey: r.hostPubkey,
        access: r.access,
        price: r.price,
        participantCount: r.participantCount,
        spectatorCount: r.spectatorCount,
        fuelFraction: r.fuelFraction,
      }));
      return new Response(JSON.stringify({ rooms: list }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/demo/check") {
      const ip = url.searchParams.get("ip") ?? "unknown";
      const entry = this.rateLimits.get(ip) ?? {
        count: 0,
        windowStart: Date.now(),
        sessionTokens: 0,
      };
      return new Response(
        JSON.stringify({
          allowed: entry.count < DEMO_RATE_LIMIT_MAX,
          requestsRemaining: Math.max(0, DEMO_RATE_LIMIT_MAX - entry.count),
          sessionTokensUsed: entry.sessionTokens,
          sessionTokenLimit: DEMO_SESSION_TOKEN_LIMIT,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (request.method === "POST" && url.pathname === "/demo/consume") {
      let body: { ip?: unknown; tokens?: unknown };
      try {
        body = (await request.json()) as { ip?: unknown; tokens?: unknown };
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const ip = typeof body.ip === "string" ? body.ip : "unknown";
      const tokens = typeof body.tokens === "number" ? body.tokens : 1;
      const allowed = this.consumeDemoToken(ip, tokens);
      return new Response(JSON.stringify({ allowed }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "POST" && url.pathname === "/register") {
      let body: {
        roomId?: unknown;
        name?: unknown;
        category?: unknown;
        hostPubkey?: unknown;
        access?: unknown;
        price?: unknown;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (typeof body.roomId !== "string" || typeof body.name !== "string") {
        return new Response("bad fields", { status: 400 });
      }
      const existing = this.rooms.get(body.roomId);
      this.rooms.set(body.roomId, {
        id: body.roomId,
        name: body.name,
        category: typeof body.category === "string" ? body.category : "open",
        hostPubkey: typeof body.hostPubkey === "string" ? body.hostPubkey : "unknown",
        access: body.access === "paid" ? "paid" : "free",
        price: typeof body.price === "number" ? body.price : undefined,
        participantCount: existing?.participantCount ?? 0,
        spectatorCount: existing?.spectatorCount ?? 0,
        fuelFraction: existing?.fuelFraction ?? 1.0,
      });
      return new Response("ok");
    }

    if (request.method === "POST" && url.pathname === "/heartbeat") {
      let body: {
        roomId?: unknown;
        participantCount?: unknown;
        spectatorCount?: unknown;
        fuelFraction?: unknown;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (typeof body.roomId !== "string") {
        return new Response("bad fields", { status: 400 });
      }
      const existing = this.rooms.get(body.roomId);
      if (existing) {
        existing.participantCount =
          typeof body.participantCount === "number" ? body.participantCount : existing.participantCount;
        existing.spectatorCount =
          typeof body.spectatorCount === "number" ? body.spectatorCount : existing.spectatorCount;
        existing.fuelFraction =
          typeof body.fuelFraction === "number" ? body.fuelFraction : existing.fuelFraction;
      }
      return new Response("ok");
    }

    if (request.method === "POST" && url.pathname === "/deregister") {
      let body: { roomId?: unknown };
      try {
        body = (await request.json()) as { roomId?: unknown };
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (typeof body.roomId === "string") {
        this.rooms.delete(body.roomId);
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }

  private consumeDemoToken(ip: string, tokens: number): boolean {
    const now = Date.now();
    let entry = this.rateLimits.get(ip);
    if (!entry) {
      entry = { count: 0, windowStart: now, sessionTokens: 0 };
    }
    if (now - entry.windowStart > DEMO_RATE_LIMIT_WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
      entry.sessionTokens = 0;
    }
    if (entry.count >= DEMO_RATE_LIMIT_MAX) return false;
    if (entry.sessionTokens + tokens > DEMO_SESSION_TOKEN_LIMIT) return false;
    entry.count++;
    entry.sessionTokens += tokens;
    this.rateLimits.set(ip, entry);
    return true;
  }
}

// RelayDO class must also be exported for Wrangler DO binding.
export class RelayDO implements DurableObject {
  private peers = new Map<string, WebSocket>();
  /** Live distinct peerIds on this DO */
  private peerCount = 0;
  private spectatorPeers = new Set<string>();
  /** Parent DO only: peerId → shard index */
  private peerToShard = new Map<string, number>();
  private shardRoundRobin = 0;
  /** First request sets room id for this instance (constant for non-shard; shard uses same roomId query). */
  private roomId: string | null = null;
  /** Non-null when this stub is a shard (`roomId-shard-n` binding) */
  private shardIndex: number | null = null;
  private registeredRoom = false;

  /** Pillar 4: heartbeat alarm interval — 5 minutes, sliding (resets on each alarm fire) */
  private static readonly HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Called by shard DO after a peer lands there — parent records target for O(1) cross-shard forward.
    if (request.method === "POST" && url.pathname === "/internal/register-shard-peer") {
      let body: { peerId?: unknown; shardIndex?: unknown };
      try {
        body = (await request.json()) as { peerId?: unknown; shardIndex?: unknown };
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (typeof body.peerId !== "string" || typeof body.shardIndex !== "number") {
        return new Response("bad fields", { status: 400 });
      }
      this.peerToShard.set(body.peerId, body.shardIndex);
      return new Response("ok");
    }

    // DO stub → deliver JSON to a peerId connected on *this* instance.
    if (request.method === "POST" && url.pathname === "/_relay/forward") {
      let body: { targetPeerId?: unknown; payload?: unknown };
      try {
        body = (await request.json()) as { targetPeerId?: unknown; payload?: unknown };
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const targetPeerId = body.targetPeerId;
      const payload = body.payload;
      if (typeof targetPeerId !== "string" || typeof payload !== "object" || payload === null) {
        return new Response("bad fields", { status: 400 });
      }
      const target = this.peers.get(targetPeerId);
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify(payload));
        return new Response("delivered");
      }
      return new Response("not found", { status: 404 });
    }

    // Shard escalates here when target is not local; parentDeliver tries parent WS map then shard forward.
    if (request.method === "POST" && url.pathname === "/internal/deliver") {
      let body: { targetPeerId?: unknown; fromPeerId?: unknown; msg?: unknown };
      try {
        body = (await request.json()) as {
          targetPeerId?: unknown;
          fromPeerId?: unknown;
          msg?: unknown;
        };
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const targetPeerId = body.targetPeerId;
      const fromPeerId = body.fromPeerId;
      const msg = body.msg as Record<string, unknown> | undefined;
      if (typeof targetPeerId !== "string" || typeof fromPeerId !== "string" || !msg) {
        return new Response("bad fields", { status: 400 });
      }
      const rid = this.roomId ?? url.searchParams.get("roomId") ?? "default";
      const ok = await this.parentDeliver(rid, fromPeerId, targetPeerId, msg);
      return ok ? new Response("ok") : new Response("not found", { status: 404 });
    }

    const peerId = url.searchParams.get("peerId");
    if (!peerId) return new Response("Missing peerId", { status: 400 });

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const roomParam = url.searchParams.get("roomId") ?? "default";
    const shardParam = url.searchParams.get("shard");
    const isShardConn = shardParam !== null && shardParam !== "";

    if (!this.roomId) this.roomId = roomParam;
    if (isShardConn) {
      const parsed = parseInt(shardParam!, 10);
      if (Number.isFinite(parsed)) this.shardIndex = parsed;
    }

    const spectatorQ = url.searchParams.get("spectator");
    const isSpectator = spectatorQ === "1" || spectatorQ === "true";

    const existingSocket = this.peers.get(peerId);
    const isReplacement = !!existingSocket;

    // Overflow: ephemeral pair only — never insert into peers / peerCount (client reconnects with &shard).
    if (!isShardConn && !isReplacement && this.peerCount >= SHARD_THRESHOLD) {
      const shardIdx = this.pickShardIndex();
      const shardUrl = this.buildShardRedirectUrl(request.url, roomParam, shardIdx);
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      server.accept();
      try {
        server.send(JSON.stringify({ type: "REDIRECT", shardUrl }));
      } catch {
        /* ignore */
      }
      server.close(4001, "redirect to shard");
      return new Response(null, { status: 101, webSocket: client });
    }

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();

    if (existingSocket) {
      try {
        existingSocket.close(4000, "Replaced by new connection for same peerId");
      } catch {
        /* ignore */
      }
    } else {
      this.peerCount++;
    }

    this.peers.set(peerId, server);

    if (isSpectator) {
      this.spectatorPeers.add(peerId);
    }

    if (isShardConn && this.shardIndex !== null) {
      this.ctx.waitUntil(this.notifyParentShardPlacement(roomParam, peerId, this.shardIndex));
    }

    // Register room on first participant join (non-spectator, non-shard, non-replacement).
    if (!isSpectator && !isReplacement && !isShardConn) {
      this.ctx.waitUntil(this.ensureRegistered(roomParam));
    }

    if (!isShardConn && this.peerCount >= SHARD_THRESHOLD - 10) {
      console.warn(
        `[RelayDO] Room ${roomParam} parent peer load ${this.peerCount} (threshold ${SHARD_THRESHOLD}).`
      );
    }

    server.addEventListener("message", (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const targetPeerId = msg.targetPeerId;
      const tFirst = typeof msg.type === "string" ? msg.type : "";
      if (typeof targetPeerId !== "string" || targetPeerId.length === 0) {
        if (tFirst === "sync" || msg.broadcast === true) {
          const payload = JSON.stringify({ ...msg, fromPeerId: peerId });
          for (const [pid, sock] of this.peers) {
            if (pid === peerId) continue;
            if (sock.readyState === WebSocket.OPEN) sock.send(payload);
          }
        }
        return;
      }

      const t = typeof msg.type === "string" ? msg.type : "";
      if (SIGNALING_TYPES.has(t)) {
        if (this.spectatorPeers.has(peerId) || this.spectatorPeers.has(targetPeerId)) {
          return;
        }
      }

      void this.routeWsMessage(roomParam, peerId, targetPeerId, msg);
    });

    server.addEventListener("close", () => {
      if (this.peers.get(peerId) === server) {
        this.peers.delete(peerId);
        this.peerCount--;
      }
      this.spectatorPeers.delete(peerId);
      if (!isSpectator && this.peerCount === 0) {
        this.ctx.waitUntil(this.cleanupRoom(roomParam));
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private pickShardIndex(): number {
    const idx = this.shardRoundRobin % MAX_SHARDS;
    this.shardRoundRobin++;
    return idx;
  }

  private buildShardRedirectUrl(originalUrlString: string, roomId: string, shardIdx: number): string {
    const u = new URL(originalUrlString);
    u.searchParams.set("roomId", roomId);
    u.searchParams.set("shard", String(shardIdx));
    return u.toString();
  }

  private async notifyParentShardPlacement(roomId: string, peerId: string, shardIndex: number): Promise<void> {
    const stub = this.env.RELAY.get(this.env.RELAY.idFromName(roomId));
    await stub.fetch(
      new Request("http://relay/internal/register-shard-peer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId, shardIndex }),
      })
    );
  }

  private async ensureRegistered(roomId: string): Promise<void> {
    if (this.registeredRoom || this.shardIndex !== null) return;
    this.registeredRoom = true;
    this.roomId = roomId;
    const name = `Room ${roomId}`;
    const category = "open";
    const stub = this.env.RELAY_REGISTRY.get(this.env.RELAY_REGISTRY.idFromName("global-registry"));
    await stub.fetch("http://relay/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, name, category }),
    });
    // ── Pillar 4: set alarm-based heartbeat (survives DO eviction) ──
    await this.ctx.storage.setAlarm(Date.now() + RelayDO.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Pillar 4: alarm-based heartbeat (survives DO eviction).
   *
   * Cloudflare DurableObject Alarm API:
   *   - this.ctx.storage.setAlarm(Date.now() + timeoutMs) — schedules next alarm
   *   - alarm() is called automatically by the runtime when the alarm fires
   *
   * The heartbeat sends a /heartbeat ping to RELAY_REGISTRY so the lobby grid
   * stays in sync with actual peer counts. Without this, the DO could be evicted
   * and re-instantiated, losing the in-memory peer map and causing ghost rooms.
   */
  private async alarm(): Promise<void> {
    if (this.roomId === null || this.shardIndex !== null) return;
    const stub = this.env.RELAY_REGISTRY.get(this.env.RELAY_REGISTRY.idFromName("global-registry"));
    await stub
      .fetch("http://relay/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId: this.roomId,
          participantCount: this.peerCount - this.spectatorPeers.size,
          spectatorCount: this.spectatorPeers.size,
          fuelFraction: 1.0,
        }),
      })
      .catch(() => { /* ignore — non-fatal */ });
    // Reschedule the next alarm (sliding 5-minute window)
    await this.ctx.storage.setAlarm(Date.now() + RelayDO.HEARTBEAT_INTERVAL_MS);
  }

  private async cleanupRoom(roomId: string): Promise<void> {
    if (this.shardIndex !== null) return;
    // Cancel any pending alarm so a re-evicted DO doesn't fire after cleanup
    await this.ctx.storage.setAlarm(null);
    const stub = this.env.RELAY_REGISTRY.get(this.env.RELAY_REGISTRY.idFromName("global-registry"));
    await stub
      .fetch("http://relay/deregister", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId }),
      })
      .catch(() => { /* ignore */ });
    this.registeredRoom = false;
  }

  private async routeWsMessage(
    roomId: string,
    fromPeerId: string,
    targetPeerId: string,
    msg: Record<string, unknown>
  ): Promise<void> {
    const target = this.peers.get(targetPeerId);
    if (target && target.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify({ ...msg, fromPeerId }));
      return;
    }

    const rid = this.roomId ?? roomId;

    if (this.shardIndex === null) {
      const shardIdx = this.peerToShard.get(targetPeerId);
      if (shardIdx !== undefined) {
        const stub = this.env.RELAY.get(this.env.RELAY.idFromName(`${rid}-shard-${shardIdx}`));
        const res = await stub.fetch(
          new Request("http://relay/_relay/forward", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              targetPeerId,
              payload: { ...msg, fromPeerId },
            }),
          })
        );
        if (res.ok) return;
      }
      return;
    }

    await this.env.RELAY.get(this.env.RELAY.idFromName(rid)).fetch(
      new Request("http://relay/internal/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPeerId, fromPeerId, msg }),
      })
    );
  }

  private async parentDeliver(
    roomId: string,
    fromPeerId: string,
    targetPeerId: string,
    msg: Record<string, unknown>
  ): Promise<boolean> {
    const target = this.peers.get(targetPeerId);
    if (target && target.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify({ ...msg, fromPeerId }));
      return true;
    }

    const shardIdx = this.peerToShard.get(targetPeerId);
    if (shardIdx !== undefined) {
      const stub = this.env.RELAY.get(this.env.RELAY.idFromName(`${roomId}-shard-${shardIdx}`));
      const res = await stub.fetch(
        new Request("http://relay/_relay/forward", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetPeerId,
            payload: { ...msg, fromPeerId },
          }),
        })
      );
      return res.ok;
    }

    return false;
  }
}
