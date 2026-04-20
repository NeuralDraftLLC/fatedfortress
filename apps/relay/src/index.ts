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
 * Invariants (#2, #9): JSON.parse guarded; reconnect replaces same peerId without leaking peerCount.
 */

export interface Env {
  RELAY: DurableObjectNamespace<RelayDO>;
}

/** Parent DO stops accepting new peers here; they receive REDIRECT (soft cap ~80 × (1 + MAX_SHARDS) peers/room). */
const SHARD_THRESHOLD = 80;
const MAX_SHARDS = 8;

const SIGNALING_TYPES = new Set(["offer", "answer", "ice-candidate"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const roomId = url.searchParams.get("roomId") ?? "default";
    const shard = url.searchParams.get("shard");
    // Same RelayDO class, different durable name → isolated peer maps per room / shard.
    const name =
      shard !== null && shard !== ""
        ? `${roomId}-shard-${shard}`
        : roomId;
    const id = env.RELAY.idFromName(name);
    return env.RELAY.get(id).fetch(request);
  },
};

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

    // DO stub → deliver JSON to a peerId connected on *this* instance (HTTP because WS has no inbound from sibling DOs).
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
    const isShardConn =
      shardParam !== null && shardParam !== "";

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
      // Room-wide CRDT frames: no targetPeerId — spectators must still receive sync (only WebRTC is gated below).
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
      // HANDOFF / chat / etc. always route; SDP-like types skip if either side is spectating (zero WebRTC budget).
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

  private async notifyParentShardPlacement(
    roomId: string,
    peerId: string,
    shardIndex: number
  ): Promise<void> {
    const stub = this.env.RELAY.get(this.env.RELAY.idFromName(roomId));
    await stub.fetch(
      new Request("http://relay/internal/register-shard-peer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId, shardIndex }),
      })
    );
  }

  /** WS message routing: local delivery, parent forward map, or escalate shard → parent. */
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

    // Parent: deliver to shard stub if registered
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

    // Shard: escalate to parent for peers on parent or another shard
    await this.env.RELAY.get(this.env.RELAY.idFromName(rid)).fetch(
      new Request("http://relay/internal/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPeerId, fromPeerId, msg }),
      })
    );
  }

  /** Parent resolves /internal/deliver — local WS or forward to a shard DO. */
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
