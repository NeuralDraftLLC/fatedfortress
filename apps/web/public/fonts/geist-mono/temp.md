update the plan further:
# Fated Fortress — Hardened Build Plan
## 21 Tasks · ~31h Human / ~3h at AI velocity

***

## ⚠️ Before You Start: Three Non-Negotiable Rules

**Rule 1 — Never skip a verification step.**
Every task has a "Verify" checkpoint. At 100 TPS it's tempting to chain
tasks without stopping. Don't. One wrong assumption in Task 7 (yield types)
propagates silently through Tasks 8, 9, 10, 13, and 14. The verify step
costs 30 seconds. The silent bug costs 3 hours.

**Rule 2 — Commit after every completed task.**
`git commit -m "task-N: <description>"` after each task. Not after each
phase — after each task. If Task 10's OutputPane migration goes sideways,
you want to `git stash` and return to Task 9's clean state, not Phase 2.

**Rule 3 — OPFS fallback must work before here.now is touched.**
Task 6 (archive.ts) must be written with the OPFS path fully functional and
tested before the here.now path is attempted. Task 16 may surprise you.
Task 6 must not.

***

## Phase 0 — Data Correctness

> **Why Phase 0 exists:** Y.js CRDT operations on raw JS objects are
> permanently broken in a way that gets worse over time. Every new joiner
> to a room with a broken spectatorChat receives stale data with no
> error. Fix this before any other chat work, and fix it before deploying
> anything else — you don't want real users accumulating corrupt history.

***

### Task 1 — Fix SpectatorChat Y.Array insertion
**File:** `apps/web/src/components/SpectatorChat.ts`
**Time:** 1h

**The bug:** `spectatorChat.push([rawObject])` stores a plain JS object
that is not observable. Y.js wraps it in its internal encoding once and
never again. You cannot call `.observe()` on it, cannot add reactions to
it, and cannot soft-delete it. New joiners who receive this entry see a
frozen snapshot — they can read it but it will never update.

**Replace insertion (lines ~40–48):**
```typescript
// BEFORE (broken):
const entry: SpectatorMessage = { id: crypto.randomUUID(), pubkey: myPubkey, ... };
this.doc.doc.transact(() => { this.doc.spectatorChat.push([entry]); });

// AFTER (correct):
const msgMap = new Y.Map<string, unknown>();
msgMap.set("id",          crypto.randomUUID());
msgMap.set("pubkey",      myPubkey as PublicKeyBase58);
msgMap.set("displayName", displayName);
msgMap.set("text",        text);
msgMap.set("ts",          Date.now());
// Optional future fields — set them now so schema is forward-compatible:
msgMap.set("type",        "text");           // ChatMessageType
msgMap.set("isDeleted",   false);
msgMap.set("reactions",   {} as Record<string, string[]>);
this.doc.doc.transact(() => { this.doc.spectatorChat.push([msgMap]); });
```

> ⚠️ **Set all fields inside the same transact() block.** If you set
> fields outside the transaction and the tab crashes between sets, you
> get a partially-written Y.Map that passes `instanceof Y.Map` but has
> missing keys. Observers then throw on `.get("text")` returning
> undefined. One transact, all fields, always.

**Update subscribe() reader (lines ~58–60):**
```typescript
const messages = this.doc.spectatorChat.toArray().map(m => {
  if (m instanceof Y.Map) {
    return {
      id:          m.get("id")          as string,
      pubkey:      m.get("pubkey")      as PublicKeyBase58,
      displayName: m.get("displayName") as string,
      text:        m.get("text")        as string,
      ts:          m.get("ts")          as number,
      type:        (m.get("type") ?? "text") as ChatMessageType,
      isDeleted:   (m.get("isDeleted") ?? false) as boolean,
    } satisfies SpectatorMessage;
  }
  // Legacy raw-object fallback — read-only, never write this shape again
  return m as SpectatorMessage;
});
```

> **Why keep the legacy fallback?** Any room created before this fix has
> raw objects in its spectatorChat Y.Array. Those objects are permanent —
> Y.js cannot remove them from CRDT history. The `m instanceof Y.Map`
> guard lets both coexist. Do NOT attempt to "migrate" old entries by
> deleting and re-inserting — a delete+insert is two CRDT operations that
> peers can receive out of order, resulting in a message appearing,
> disappearing, and reappearing in random order for different peers.

**✅ Verify:**
```typescript
// In browser console after fix:
const chat = doc.spectatorChat;
chat.push([new Y.Map()]);                    // correct insert (test)
console.log(chat.get(chat.length - 1) instanceof Y.Map); // must be true
chat.observe(e => console.log("observable")); // must fire on next push
```
Send a message and confirm the observer fires. If it does, Task 1 is done.

***

## Phase 1 — Presence Infrastructure

> **Why before multimodal:** Presence touches `ydoc.ts`, `signaling.ts`,
> and `room.ts` — the three most-imported files in the codebase. If you
> build image rooms first and then retrofit presence, you'll modify files
> that have already been modified by 8 other tasks. Do presence now while
> those files are clean.

***

### Task 2 — Extend PresenceEntry interface
**File:** `apps/web/src/state/ydoc.ts` (lines ~69)
**Time:** 0.5h

```typescript
export interface PresenceEntry {
  pubkey:        PublicKeyBase58;
  name:          string;
  lastSeenAt:    number;
  state: "active" | "idle" | "away" | "generating" | "spectating" | "offline";
  currentAction?: {
    type:     "generating" | "typing" | "viewing";
    modelId?: string;       // only when type === "generating"
    startedAt: number;
  };
  avatarSeed:   string;     // pubkey → deterministic hue, no external requests
  isHost:       boolean;
  role:         "host" | "participant" | "spectator";
  connectedVia: "p2p" | "relay";
}
```

> **avatarSeed note:** Compute as a hex string from the first 4 bytes of
> SHA-256(pubkey). This gives 16^4 = 65536 unique hues without any
> network call. The PresenceBar uses this to pick an HSL color. Never
> use an external avatar service — that leaks pubkeys to a third party.

```typescript
// Suggested helper (add to identity.ts or ydoc.ts):
export function pubkeyToAvatarSeed(pubkey: string): string {
  // Simple deterministic hash — no crypto needed, just visual diversity
  let h = 0;
  for (let i = 0; i < pubkey.length; i++) {
    h = (Math.imul(31, h) + pubkey.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
// Usage: avatarColor = `hsl(${parseInt(seed, 16) % 360}, 70%, 55%)`
```

**✅ Verify:** TypeScript builds with zero errors after interface change.
`tsc --noEmit` from `apps/web/`.

***

### Task 3 — Ephemeral typing broadcast
**File:** `apps/web/src/net/signaling.ts`
**Time:** 1h

> **Why WebSocket, not Y.js:** A Y.js write is permanent. It syncs to
> every peer including those who join 10 minutes later. A "typing"
> indicator from 10 minutes ago is nonsense. Relay WS broadcast is
> fire-and-forget — if a peer misses it, they just don't see the
> indicator flicker. That's acceptable. A stale CRDT entry is not.

**Add to signaling.ts:**
```typescript
let typingDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function broadcastTyping(roomId: string, isTyping: boolean): void {
  if (!wsOpen()) return;
  ws.send(JSON.stringify({
    type:   isTyping ? "TYPING_START" : "TYPING_STOP",
    peerId: getMyPubkey(),
    roomId,
  }));
}

// Debounced version for use in chat input keydown handler:
export function notifyTyping(roomId: string): void {
  broadcastTyping(roomId, true);
  if (typingDebounceTimer) clearTimeout(typingDebounceTimer);
  // Auto-stop after 3s of no keystrokes
  typingDebounceTimer = setTimeout(() => broadcastTyping(roomId, false), 3_000);
}
```

**In the relay WS message switch (existing switch in signaling.ts):**
```typescript
case "TYPING_START":
case "TYPING_STOP": {
  // Emit to UI — do NOT write to Y.js
  const isTyping = msg.type === "TYPING_START";
  typingIndicatorEmitter.emit(msg.peerId, isTyping);
  break;
}
```

> **RelayDO also needs to broadcast these.** Add to RelayDO's
> handleWebSocket: if msg.type is TYPING_START or TYPING_STOP, broadcast
> to all peers in room EXCEPT the sender. No persistence, no logging.
> These are the cheapest messages in the system — treat them as such.

**✅ Verify:** Open two browser tabs on the same room. Type in tab A's
chat input. Tab B should see a typing indicator within 1s. Stop typing —
indicator should clear within 3s.

***

### Task 4 — Presence heartbeat
**File:** `apps/web/src/pages/room.ts`
**Time:** 1h

**Add to both `mountRoom` and `mountSpectatorRoom`:**
```typescript
// Track last user interaction
let lastInteraction = Date.now();
const onInteract = () => { lastInteraction = Date.now(); };
document.addEventListener("mousemove",  onInteract, { passive: true });
document.addEventListener("keydown",    onInteract, { passive: true });
document.addEventListener("touchstart", onInteract, { passive: true });

const presenceInterval = setInterval(() => {
  const idleMs  = Date.now() - lastInteraction;
  let state: PresenceEntry["state"] = "active";
  if (document.hidden) state = "away";
  else if (idleMs > 5 * 60_000) state = "away";
  else if (idleMs > 30_000)     state = "idle";

  const existing = doc.presence.get(myPubkey) as PresenceEntry | undefined;
  // Don't overwrite "generating" state from heartbeat — generation handler owns that
  if (existing?.state === "generating") return;

  upsertPresence(doc, {
    ...existing,
    pubkey:      myPubkey,
    name:        getMyDisplayName(),
    lastSeenAt:  Date.now(),
    state,
    avatarSeed:  pubkeyToAvatarSeed(myPubkey),
    isHost:      doc.meta.get("activeHostPubkey") === myPubkey,
    role:        isSpectator ? "spectator" : "participant",
    connectedVia: getConnectionType(), // from signaling.ts
  });
}, 15_000);

// Cleanup on unmount — critical, or intervals stack across navigations
return () => {
  clearInterval(presenceInterval);
  document.removeEventListener("mousemove",  onInteract);
  document.removeEventListener("keydown",    onInteract);
  document.removeEventListener("touchstart", onInteract);
};
```

> ⚠️ **The cleanup return is mandatory.** Fated Fortress is a SPA —
> `mountRoom` may be called multiple times if the user navigates between
> rooms. Without cleanup, you accumulate one interval per navigation.
> After 5 room visits you have 5 heartbeat loops all writing to presence
> simultaneously, causing Y.js transact storms and flickering presence UI.
> Always return a teardown function. Always call it on unmount.

**✅ Verify:** Open DevTools Performance tab. Navigate between two rooms
three times. Confirm there is only ever ONE presence update firing every
15s, not 3 or 6.

***

### Task 5 — PresenceBar component
**File:** `apps/web/src/components/PresenceBar.ts` (new)
**Time:** 2h

```typescript
export class PresenceBar {
  private container: HTMLElement;
  private unsubscribe: (() => void) | null = null;

  constructor(private doc: FortressRoomDoc) {
    this.container = document.createElement("div");
    this.container.className = "ff-presence-bar";
    this.container.setAttribute("role", "list");
    this.container.setAttribute("aria-label", "Room participants");
  }

  mount(target: HTMLElement): void {
    target.appendChild(this.container);
    // Subscribe to presence Y.Map changes
    const handler = () => this.render();
    this.doc.presence.observe(handler);
    this.unsubscribe = () => this.doc.presence.unobserve(handler);
    this.render();
  }

  unmount(): void {
    this.unsubscribe?.();
    this.container.remove();
  }

  private render(): void {
    const entries = Array.from(this.doc.presence.values()) as PresenceEntry[];
    // Sort: host first, then participants by lastSeenAt desc, then spectators
    entries.sort((a, b) => {
      if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
      if (a.role === "spectator" && b.role !== "spectator") return 1;
      if (b.role === "spectator" && a.role !== "spectator") return -1;
      return b.lastSeenAt - a.lastSeenAt;
    });

    this.container.innerHTML = entries.map(e => this.renderEntry(e)).join("");
    // Spectator count pill
    const spectators = entries.filter(e => e.role === "spectator").length;
    if (spectators > 0) {
      this.container.insertAdjacentHTML("beforeend",
        `<span class="ff-presence-spectators" aria-label="${spectators} spectators">
           👁 ${spectators}
         </span>`);
    }
  }

  private renderEntry(e: PresenceEntry): string {
    const hue   = parseInt(e.avatarSeed, 16) % 360;
    const color = `hsl(${hue}, 70%, 55%)`;
    const dot   = STATE_DOT[e.state] ?? "#9ca3af";
    const label = `${e.name}${e.isHost ? " (host)" : ""}`;
    const action = e.currentAction?.type === "generating"
      ? ` · generating ${e.currentAction.modelId ?? "…"}`
      : "";
    const since  = this.relativeTime(e.lastSeenAt);

    return `
      <div class="ff-presence-entry" role="listitem"
           data-pubkey="${e.pubkey}"
           aria-label="${label}${action}">
        <div class="ff-presence-avatar" style="background:${color}" aria-hidden="true">
          ${e.name.slice(0, 1).toUpperCase()}
        </div>
        <span class="ff-presence-dot" style="background:${dot}"
              aria-label="Status: ${e.state}"></span>
        <div class="ff-presence-tooltip">
          <strong>${label}</strong>
          <span>${e.role} · ${e.connectedVia}</span>
          <span>Last seen ${since}</span>
          ${action ? `<span>${action}</span>` : ""}
        </div>
      </div>`;
  }

  private relativeTime(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 10)  return "just now";
    if (s < 60)  return `${s}s ago`;
    if (s < 120) return "1 min ago";
    return `${Math.floor(s / 60)} min ago`;
  }

  destroy(): void { this.unmount(); }
}

const STATE_DOT: Record<PresenceEntry["state"], string> = {
  active:     "#22c55e", // green
  idle:       "#eab308", // yellow
  away:       "#9ca3af", // gray
  generating: "#0d9488", // teal
  spectating: "#6b7280", // faint gray
  offline:    "#ef4444", // red
};
```

**✅ Verify:** Open a room with two tabs. Both tabs show each other's
avatar in the presence bar. Idle one tab for 30s — its dot turns yellow.
Close a tab — the other tab's presence bar removes that entry within 60s.

***

## Phase 2 — Multimodal Infrastructure

> **The critical path for image rooms:** Task 6 (archive.ts) and Task 7
> (yield types) are the foundations. Do NOT start Task 8 or Task 9
> without Task 7 merged. The yield union type is imported by adapters,
> generate.ts, OutputPane, and the bridge — getting it wrong means 5
> files need a simultaneous fix instead of 1.

***

### Task 6 — archive.ts
**File:** `apps/web/src/state/archive.ts` (new)
**Time:** 0.5h

```typescript
import { uploadBlobToHereNow } from "../net/herenow.js";

const OPFS_DIR = "ff-output-archive";

export async function archiveOutput(
  receiptId: string,
  temporaryUrl: string,
  modality: "image" | "audio" | "video",
): Promise<string> {
  let blob: Blob;
  try {
    const res = await fetch(temporaryUrl);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    blob = await res.blob();
  } catch (err) {
    console.error("[archive] Failed to fetch temporary URL:", err);
    throw err; // Caller decides whether to save the raw (expiring) URL as a fallback
  }

  // Try here.now first — permanent + shareable
  try {
    const permanentUrl = await uploadBlobToHereNow(blob, { receiptId, modality });
    return permanentUrl;
  } catch (hereNowErr) {
    console.warn("[archive] here.now upload failed, falling back to OPFS:", hereNowErr);
  }

  // OPFS fallback — local only, not shareable, but permanent on this device
  return await storeInOPFS(receiptId, blob, modality);
}

async function storeInOPFS(
  receiptId: string,
  blob: Blob,
  modality: string,
): Promise<string> {
  const root = await navigator.storage.getDirectory();
  const dir  = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  const ext  = modality === "image" ? "webp" : modality === "audio" ? "mp3" : "mp4";
  const fh   = await dir.getFileHandle(`${receiptId}.${ext}`, { create: true });
  const writable = await fh.createWritable();
  await writable.write(blob);
  await writable.close();
  // Return an opaque identifier — caller stores this, not a real URL
  return `opfs://${OPFS_DIR}/${receiptId}.${ext}`;
}

// Call this to resolve an opfs:// identifier back to an object URL for display
export async function resolveOpfsUrl(opfsId: string): Promise<string> {
  const [, , dir, filename] = opfsId.split("/");
  const root = await navigator.storage.getDirectory();
  const dirHandle  = await root.getDirectoryHandle(dir);
  const fileHandle = await dirHandle.getFileHandle(filename);
  const file = await fileHandle.getFile();
  return URL.createObjectURL(file); // revoke after use
}
```

> **Why `opfs://` pseudo-URL instead of a real object URL?** Object URLs
> (`blob:` scheme) are revoked when the page unloads. If you store a
> `blob:` URL in a receipt, it works in the current session and breaks
> on reload. The `opfs://` identifier is permanent — it points to a file
> in the Origin Private File System which persists across sessions. Call
> `resolveOpfsUrl()` at display time to get a short-lived object URL.

**✅ Verify:**
```typescript
// In console, after a generation with a real image URL:
const url = await archiveOutput("test-123", "https://...real-provider-url...", "image");
console.log(url); // should be either a here.now URL or "opfs://ff-output-archive/test-123.webp"
// If OPFS path:
const displayUrl = await resolveOpfsUrl(url);
const img = document.createElement("img");
img.src = displayUrl;
document.body.appendChild(img); // should show the image
```

***

### Task 7 — AdapterYield union type
**File:** `packages/protocol/src/types.ts`
**Time:** 0.5h

```typescript
export type AdapterYield =
  | { type: "text_delta";  delta: string }
  | { type: "image_url";   url: string; index: number }
  | { type: "audio_url";   url: string; format: "mp3" | "wav" | "ogg" }
  | { type: "audio_chunk"; chunk: ArrayBuffer }
  | { type: "job_id";      jobId: string; pollUrl: string; estimatedMs: number }
  | { type: "progress";    percent: number; message?: string }
  | { type: "done";        metadata?: Record<string, unknown> };

// Also add modality to GenerateRequest so the worker knows what it's generating:
export interface GenerateRequest {
  // existing fields...
  modality: "text" | "image" | "audio" | "video"; // NEW
}
```

> ⚠️ **This is the most import-heavy change in the plan.** Every adapter
> file currently returns `AsyncGenerator<string>`. After this task, they
> return `AsyncGenerator<AdapterYield>`. Do a global search for
> `: AsyncGenerator<string>` and `: AsyncIterable<string>` before moving
> to Task 9 — those are the locations that need updating.
>
> The `modality` field on `GenerateRequest` is needed by the worker's
> budget branch (Task 11) and the roomType lock check (Task 12). Add it
> now or you'll need to retrofit it in two separate tasks.

**✅ Verify:** `tsc --noEmit` from workspace root. Zero new errors. If
existing adapters error on return type mismatch, that's expected — fix
their signatures in Task 9, not here.

***

### Task 8 — async-jobs.ts
**File:** `apps/worker/src/async-jobs.ts` (new)
**Time:** 3h

> **The single most complex new file in this plan.** The polling loop
> runs inside the worker sandbox, outlives individual generate requests,
> and must handle: network failures during poll (retry), key removal
> after job registration (safe — key captured at registration), user
> abort (cancel), timeout (5 min default), and out-of-order completion
> (rare, but a job can complete before its first poll fires).

```typescript
import { getRawKey }   from "./keystore.js";
import { sendProgress, sendError, sendDone } from "./router-primitives.js";

interface TrackedJob {
  requestId:     string;
  jobId:         string;
  pollUrl:       string;
  apiKey:        string;    // CAPTURED AT REGISTRATION — not at poll time
  provider:      string;
  startedAt:     number;
  timeoutMs:     number;    // default: 300_000 (5 min)
  pollIntervalMs: number;   // default: 5_000
  attempts:      number;
  outputType:    "image_url" | "audio_url" | "video_url";
}

const jobs = new Map<string, TrackedJob>();

export async function registerAsyncJob(
  job: Omit<TrackedJob, "attempts" | "startedAt" | "apiKey">
): Promise<void> {
  // Capture key NOW — if user removes key while job is polling, we still succeed
  const apiKey = await getRawKey(job.provider);
  if (!apiKey) {
    sendError(job.requestId, {
      code: "NO_KEY_AT_REGISTRATION",
      message: `No key for ${job.provider} — cannot submit async job`,
    });
    return;
  }
  jobs.set(job.jobId, { ...job, apiKey, startedAt: Date.now(), attempts: 0 });
  scheduleNextPoll(job.jobId);
}

export function cancelAsyncJobsForRequest(requestId: string): void {
  for (const [jobId, job] of jobs) {
    if (job.requestId === requestId) {
      jobs.delete(jobId);
      console.debug(`[async-jobs] cancelled job ${jobId} for request ${requestId}`);
    }
  }
}

function scheduleNextPoll(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return; // already cancelled

  setTimeout(async () => {
    const j = jobs.get(jobId);
    if (!j) return; // cancelled during wait

    j.attempts++;
    const elapsed = Date.now() - j.startedAt;

    if (elapsed > j.timeoutMs) {
      jobs.delete(jobId);
      sendError(j.requestId, {
        code: "JOB_TIMEOUT",
        message: `Job ${jobId} timed out after ${j.timeoutMs / 1000}s (${j.attempts} polls)`,
      });
      return;
    }

    try {
      const result = await pollOnce(j);

      if (result.status === "completed") {
        jobs.delete(jobId);
        // Send the output before done — OutputPane needs the URL before finalising
        sendOutput(j.requestId, j.outputType, result.outputUrl!);
        sendDone(j.requestId, { durationMs: elapsed, attempts: j.attempts });

      } else if (result.status === "failed") {
        jobs.delete(jobId);
        sendError(j.requestId, {
          code: "JOB_FAILED",
          message: result.error ?? `Job ${jobId} failed after ${j.attempts} polls`,
        });

      } else {
        // Still pending — report progress and reschedule
        const pct = result.progress ?? Math.min(90, (elapsed / j.timeoutMs) * 100);
        sendProgress(j.requestId, pct, result.message ?? "Processing…");
        scheduleNextPoll(jobId);
      }

    } catch (pollErr) {
      // Network error during poll — log and retry unless timed out
      console.warn(`[async-jobs] poll error for ${jobId} (attempt ${j.attempts}):`, pollErr);
      scheduleNextPoll(jobId); // retry — timeout will eventually catch runaway retries
    }

  }, job.pollIntervalMs);
}

async function pollOnce(job: TrackedJob): Promise<{
  status: "pending" | "completed" | "failed";
  outputUrl?: string;
  progress?: number;
  message?: string;
  error?: string;
}> {
  const res = await fetch(job.pollUrl, {
    headers: { Authorization: `Bearer ${job.apiKey}` },
  });
  if (!res.ok) throw new Error(`Poll HTTP ${res.status}`);
  return res.json();
}

function sendOutput(requestId: string, type: TrackedJob["outputType"], url: string): void {
  // Reuse existing send infrastructure from router-primitives
  const msgType = type === "image_url" ? "IMAGE_URL"
                : type === "audio_url" ? "AUDIO_URL"
                : "VIDEO_URL";
  self.postMessage({ type: msgType, requestId, url });
}
```

> **Two edge cases to handle explicitly:**
>
> 1. **The job completes before the first poll fires** (rare but possible
>    with fast providers). Your `setTimeout` with `pollIntervalMs` delay
>    means the first poll fires 5s after registration. If the job is done
>    in 2s, the `completed` status will be returned on attempt 1 and
>    everything is fine. No special handling needed — just don't add an
>    "is this the first poll?" guard that skips the completion check.
>
> 2. **Duplicate completion** (provider sometimes returns `completed`
>    twice due to retry logic on their side). The `jobs.delete(jobId)`
>    call before `sendDone` prevents double-sending — the second poll
>    will find `jobs.get(jobId) === undefined` and return early.

**✅ Verify:** Unit test the polling loop with a mock `pollOnce`:
```typescript
// Test: job completes on attempt 2
// Test: job times out after maxAttempts equivalent
// Test: cancelAsyncJobsForRequest stops the loop
// Test: network error during poll retries instead of failing
```

***

### Task 8.5 — Wire ABORT_GENERATE to cancel polls
**File:** `apps/worker/src/router.ts`
**Time:** 15 min

```typescript
import { cancelAsyncJobsForRequest } from "./async-jobs.js";

// In the ABORT_GENERATE case — add cancelAsyncJobsForRequest BEFORE abort():
case "ABORT_GENERATE": {
  cancelAsyncJobsForRequest(payload.requestId); // cancel polling loop
  abortControllerMap.get(payload.requestId)?.abort(); // cancel streaming
  abortControllerMap.delete(payload.requestId);
  break;
}
```

> This is the easiest task in the plan and the one most likely to be
> forgotten. It has no output of its own — it's a two-line addition to
> an existing case. Add it immediately after Task 8 while async-jobs.ts
> is fresh in context.

**✅ Verify:** Submit a video generation. While the progress indicator is
visible, click Abort. Confirm no further POLL requests appear in the
DevTools Network tab after abort.

***

### Task 9 — Extend generate.ts yield loop
**File:** `apps/worker/src/generate.ts`
**Time:** 2h

**Update adapter interface:**
```typescript
// Change every adapter from:
export async function* generate(...): AsyncGenerator<string>

// To:
export async function* generate(...): AsyncGenerator<AdapterYield>

// Text adapters: wrap existing string yields
// BEFORE: yield chunk;
// AFTER:  yield { type: "text_delta", delta: chunk };
```

**Extend the yield handler in handleGenerate:**
```typescript
for await (const chunk of adapter.generate(opts)) {
  switch (chunk.type) {
    case "text_delta":
      appendToOutput(doc, requestId, chunk.delta); // existing path
      sendChunk(requestId, chunk.delta);
      break;

    case "image_url":
      sendOutput("IMAGE_URL", requestId, chunk.url, chunk.index);
      break;

    case "audio_url":
    case "audio_chunk":
      sendOutput("AUDIO_URL", requestId, "url" in chunk ? chunk.url : "");
      break;

    case "job_id":
      // Hand off to async polling — generate() returns after this
      await registerAsyncJob({
        requestId,
        jobId:         chunk.jobId,
        pollUrl:       chunk.pollUrl,
        provider:      opts.provider,
        timeoutMs:     300_000,
        pollIntervalMs: 5_000,
        outputType:    opts.modality === "audio" ? "audio_url"
                     : opts.modality === "video" ? "video_url"
                     : "image_url",
      });
      return; // Exit generate loop — async-jobs.ts takes over

    case "progress":
      sendProgress(requestId, chunk.percent, chunk.message);
      break;

    case "done":
      finaliseQuota(requestId);
      sendDone(requestId, chunk.metadata);
      return;
  }
}
```

> ⚠️ **The `return` after `registerAsyncJob` is critical.** When a
> video adapter yields a `job_id`, the generate loop must exit — the
> async polling loop in async-jobs.ts takes over from here. If you
> `break` instead of `return`, the `for await` loop continues on the
> next yield from the adapter, which (for video adapters) is nothing,
> and the function falls through to `finaliseQuota` early — double-
> finalising the quota and breaking the budget accounting.

**✅ Verify:** Run a text generation and confirm `text_delta` chunks
still stream correctly. Run an image generation and confirm `IMAGE_URL`
message arrives at the main thread. Check budget accounting is unchanged
for text.

***

### Task 10 — Migrate OutputPane from Y.Text to Y.Array\<Y.Map\>
**File:** `apps/web/src/components/OutputPane.ts`
**Time:** 4–5h

> **Highest-risk task in the plan.** You are changing a live data layer
> that existing rooms depend on. The migration strategy is:
> 1. Add `outputItems` Y.Array to the doc schema (additive — does not
>    break existing rooms)
> 2. New generations write to `outputItems` only
> 3. OutputPane reads `outputItems` first; if empty, falls back to
>    `doc.output.toString()` (legacy text)
> 4. Old rooms continue to display correctly via the fallback
> 5. Never backfill old `doc.output` text into `outputItems` — that
>    would create duplicate display and confuse the receipt system

**Add to ydoc.ts schema:**
```typescript
// In FortressRoomDoc (additive, does NOT change existing rooms):
get outputItems(): Y.Array<Y.Map<string, unknown>> {
  return this.doc.getArray("outputItems");
}

// OutputItem helper:
export function createOutputItem(fields: Partial<OutputItem> & {
  id: string; receiptId: string; modality: OutputItem["modality"];
}): Y.Map<string, unknown> {
  const m = new Y.Map<string, unknown>();
  Object.entries(fields).forEach(([k, v]) => m.set(k, v));
  m.set("createdAt", Date.now());
  m.set("status", fields.status ?? "streaming");
  return m;
}
```

**OutputPane render logic:**
```typescript
private render(): void {
  const items = this.doc.outputItems.toArray() as Y.Map<string, unknown>[];

  if (items.length === 0) {
    // Legacy fallback: render doc.output Y.Text
    const text = this.doc.output.toString();
    if (text) {
      this.container.innerHTML = this.renderMarkdown(text);
      return;
    }
    this.renderEmpty();
    return;
  }

  this.container.innerHTML = items.map(item => {
    const modality = item.get("modality") as OutputItem["modality"];
    switch (modality) {
      case "text":  return this.renderTextItem(item);
      case "image": return this.renderImageItem(item);
      case "audio": return this.renderAudioItem(item);
      case "video": return this.renderVideoItem(item);
      default:      return "";
    }
  }).join("");
}
```

**For streaming text — append to Y.Map instead of Y.Text:**
```typescript
// In ControlPane (or wherever generation output is appended):
// BEFORE: doc.output.insert(doc.output.length, delta);
// AFTER:
const currentItem = getStreamingOutputItem(doc); // get or create the active item
doc.doc.transact(() => {
  const existing = (currentItem.get("text") as string) ?? "";
  currentItem.set("text", existing + delta);
  currentItem.set("status", "streaming");
});
```

> **Important: Y.Text vs Y.Map for streaming text.** Y.Text has
> built-in CRDT merge semantics for concurrent edits (character-level
> merging). Y.Map with a string value does NOT — the last write wins.
> For the current single-host-generates model, last-write-wins is
> acceptable since only one peer writes to the output stream at a time.
> If you ever add concurrent multi-host generation, you'll need to
> switch the text field back to a nested Y.Text. Document this decision
> in a comment in the code.

**✅ Verify:** 
- Open an old room — confirms legacy text still displays
- Generate new text in a new room — confirms it writes to outputItems and renders
- Generate an image (after Tasks 12-14) — confirms image grid renders
- Reload the page mid-generation — confirms partial output is preserved in Y.Map

***

### Task 11 — Budget token multimodal updates
**File:** `packages/protocol/src/types.ts` + `apps/worker/src/budget.ts`
**Time:** 1h

```typescript
// types.ts — extend BudgetTokenClaims:
export interface BudgetTokenClaims {
  maxTokens:        number;        // existing
  maxImages?:       number;        // per-generation cap for image rooms
  maxAudioSeconds?: number;
  maxVideoSeconds?: number;
  allowedModalities: Array<"text" | "image" | "audio" | "video">;
}

// budget.ts — branch reserveQuota on modality:
export async function reserveQuota(
  requestId: string,
  claims: BudgetTokenClaims,
  modality: "text" | "image" | "audio" | "video",
  amount: number, // tokens, images, seconds depending on modality
): Promise<void> {
  switch (modality) {
    case "text":
      if (claims.maxTokens < amount)
        throw new BudgetError("QUOTA_EXCEEDED", "Token budget exceeded");
      // existing token reservation logic
      break;
    case "image":
      if (!claims.maxImages || claims.maxImages < amount)
        throw new BudgetError("QUOTA_EXCEEDED", "Image budget exceeded");
      // decrement maxImages
      break;
    case "audio":
      if (!claims.maxAudioSeconds || claims.maxAudioSeconds < amount)
        throw new BudgetError("QUOTA_EXCEEDED", "Audio budget exceeded");
      break;
    case "video":
      if (!claims.maxVideoSeconds || claims.maxVideoSeconds < amount)
        throw new BudgetError("QUOTA_EXCEEDED", "Video budget exceeded");
      break;
  }
}
```

> **FuelGauge update needed:** The FuelGauge component currently shows
> "X tokens remaining." For image rooms it should show "X images
> remaining" and for video rooms "Xs of video remaining." Read
> `doc.meta.get("roomType")` in FuelGauge to determine which unit to
> display. This is a cosmetic change but impacts perceived trust — a
> token counter on an image room confuses users.

**✅ Verify:** Mint a budget token with `allowedModalities: ["image"]`
and `maxImages: 2`. Attempt 3 image generations. Third must fail with
QUOTA_EXCEEDED. Text generation must fail with MODALITY_NOT_ALLOWED.

***

## Phase 3 — Image Room Type

> **Prerequisite checklist before starting Phase 3:**
> - [ ] Task 6 (archive.ts) committed and OPFS path tested
> - [ ] Task 7 (AdapterYield) merged — adapters updated to new return type
> - [ ] Task 10 (OutputPane migration) rendering both legacy and new outputItems
> - [ ] Task 11 (budget) branching on modality in reserveQuota
>
> If any of these are not done, stop. Phase 3 depends on all four.

***

### Task 12 — Room type in meta Y.Map + enforcement
**File:** `apps/web/src/state/ydoc.ts`
**Time:** 1h (includes both enforcement points)

```typescript
// In RoomMeta interface:
export interface RoomMeta {
  // existing fields...
  roomType:    "text" | "image" | "audio" | "video" | "multimodal";
  roomSubMode: "speech" | "music" | "sfx" | undefined; // audio only
}

// In createRoomDoc — default to "text" for all existing rooms:
meta.set("roomType",    opts.roomType    ?? "text");
meta.set("roomSubMode", opts.roomSubMode ?? undefined);
```

**Enforcement Point 1 — UI layer (apps/web/src/pages/room.ts handleIntent):**
```typescript
// Before generating, check roomType is set and matches modality:
const roomType = doc.meta.get("roomType") as string ?? "text";
if (roomType === "text" && msg.modality !== "text") {
  showError("This is a text room. Create an image or multimodal room to generate images.");
  return;
}
// Lock roomType after first generation:
if (!doc.meta.get("firstGenerationAt")) {
  doc.doc.transact(() => {
    doc.meta.set("firstGenerationAt", Date.now());
    // roomType is now locked — any future attempt to change it is ignored
  });
}
```

**Enforcement Point 2 — Cryptographic layer (apps/worker/src/generate.ts):**
```typescript
// After verifyAndConsumeToken, before reserveQuota:
const allowed = claims.allowedModalities ?? ["text"];
if (!allowed.includes(msg.modality)) {
  return sendError(requestId, {
    code: "MODALITY_NOT_ALLOWED",
    message: `Budget token does not permit ${msg.modality} generation in this room`,
  });
}
```

> **Why two enforcement points?** The UI layer gives instant user
> feedback and prevents unnecessary round-trips to the worker. The
> worker layer is the trust boundary — a malicious client could bypass
> the UI check and post directly to the worker's message bus. The worker
> check cannot be bypassed. Never rely on only the UI check for anything
> that has budget or security implications.

**✅ Verify:** Create a text room. Attempt to POST a `GENERATE` message
with `modality: "image"` directly to the worker (bypassing the UI).
Confirm the worker returns `MODALITY_NOT_ALLOWED`. The UI should also
prevent the attempt before it reaches the worker.

***

### Task 13 — Image ControlPane extras
**File:** `apps/web/src/components/ControlPane.ts`
**Time:** 2h

```typescript
// In mount(), after existing controls — show/hide based on roomType:
const roomType = this.doc.meta.get("roomType") as string ?? "text";

if (roomType === "image" || roomType === "multimodal") {
  this.container.insertAdjacentHTML("beforeend", `
    <div class="ff-image-controls">
      <div class="ff-aspect-ratio">
        <label>Aspect ratio</label>
        <div class="ff-chip-group" role="radiogroup" aria-label="Aspect ratio">
          ${["1:1","16:9","9:16","4:3","3:2"].map(r => `
            <button class="ff-chip ${r === "1:1" ? "active" : ""}"
                    role="radio" aria-checked="${r === "1:1"}"
                    data-value="${r}">${r}</button>
          `).join("")}
        </div>
      </div>
      <div class="ff-style-presets">
        <label>Style</label>
        <div class="ff-chip-group" role="radiogroup" aria-label="Style preset">
          ${["none","photorealistic","illustration","anime","pixel art","concept"].map(s => `
            <button class="ff-chip ${s === "none" ? "active" : ""}"
                    role="radio" aria-checked="${s === "none"}"
                    data-value="${s}">${s}</button>
          `).join("")}
        </div>
      </div>
      <div class="ff-field">
        <label for="ff-negative-prompt">Negative prompt</label>
        <input id="ff-negative-prompt" type="text"
               placeholder="blurry, low quality, watermark…"
               class="ff-input" />
      </div>
      <div class="ff-field">
        <label for="ff-seed">Seed <span class="ff-text-muted">(optional)</span></label>
        <input id="ff-seed" type="number" placeholder="random"
               min="0" max="4294967295" class="ff-input ff-seed-input" />
      </div>
    </div>
  `);

  // Chip group toggle logic
  this.container.querySelectorAll(".ff-chip-group").forEach(group => {
    group.addEventListener("click", e => {
      const btn = (e.target as HTMLElement).closest(".ff-chip") as HTMLButtonElement;
      if (!btn) return;
      group.querySelectorAll(".ff-chip").forEach(c => {
        c.classList.remove("active");
        c.setAttribute("aria-checked", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-checked", "true");
    });
  });
}
```

> **Accessibility note:** Style preset chips and aspect ratio chips use
> `role="radio"` and `aria-checked`. A screen reader user should be able
> to navigate and select presets without a mouse. Test with VoiceOver
> or NVDA before shipping — this is one of the most common a11y failures
> in "chip group" UIs.

**✅ Verify:** Create an image room. Image controls appear. Switch to a
text room — image controls are hidden. Chip selection toggles correctly.
Selected values are accessible to the generate handler via DOM query or
state.

***

### Task 14 — Image OutputPane renderer
**File:** `apps/web/src/components/OutputPane.ts`
**Time:** 3h

```typescript
private renderImageItem(item: Y.Map<string, unknown>): string {
  const urls     = (item.get("imageUrls") as string[] | undefined) ?? [];
  const status   = item.get("status") as string;
  const progress = item.get("progress") as number | undefined;
  const receiptId = item.get("receiptId") as string;

  if (status === "streaming" || status === "pending") {
    const pct = progress ?? 0;
    return `
      <div class="ff-image-loading" data-receipt="${receiptId}">
        <div class="ff-progress-bar">
          <div class="ff-progress-fill" style="width:${pct}%"></div>
        </div>
        <p class="ff-text-muted">Generating… ${pct > 0 ? `${Math.round(pct)}%` : ""}</p>
      </div>`;
  }

  if (status === "error") {
    return `<div class="ff-image-error">Generation failed</div>`;
  }

  // Completed — render grid
  return `
    <div class="ff-image-grid" data-receipt="${receiptId}"
         data-count="${urls.length}">
      ${urls.map((url, i) => `
        <figure class="ff-image-figure">
          <img src="${escapeAttr(url)}" alt="Generated image ${i + 1} of ${urls.length}"
               loading="lazy" width="512" height="512"
               onerror="this.parentElement.classList.add('ff-img-error')" />
          <figcaption class="ff-image-actions">
            <a href="${escapeAttr(url)}" download="ff-${receiptId}-${i}.webp"
               class="ff-btn-ghost" aria-label="Download image ${i + 1}">↓ Download</a>
            <button class="ff-btn-ghost ff-use-as-ref"
                    data-url="${escapeAttr(url)}"
                    data-receipt="${receiptId}"
                    aria-label="Use image ${i + 1} as reference for next generation">
              Use as reference
            </button>
          </figcaption>
        </figure>
      `).join("")}
    </div>`;
}
```

**Archive on completion — call archiveOutput before saving receipt:**
```typescript
// In handleGenerationComplete (wherever generation done is handled in room.ts or ControlPane):
if (modality === "image" && outputUrls.length > 0) {
  const archivedUrls = await Promise.all(
    outputUrls.map(url => archiveOutput(receiptId, url, "image"))
  );
  // Store archivedUrls in receipt — NOT the ephemeral provider URLs
  saveImageReceipt({ ...receipt, outputUrls: archivedUrls });
} else {
  saveImageReceipt({ ...receipt, outputUrls });
}
```

> ⚠️ **Promise.all on archive calls.** If you have 4 images and one
> archive call fails (e.g., here.now rate-limits you), `Promise.all`
> rejects entirely and you lose all 4 URLs. Use `Promise.allSettled`
> instead and archive each URL independently, falling back to OPFS for
> any that fail:
> ```typescript
> const results = await Promise.allSettled(
>   outputUrls.map(url => archiveOutput(receiptId, url, "image"))
> );
> const archivedUrls = results.map((r, i) =>
>   r.status === "fulfilled" ? r.value : outputUrls[i] // keep expiring URL as last resort
> );
> ```

**✅ Verify:** Generate an image. Confirm grid renders with correct count.
Click "Use as reference" — confirm the URL is stored in component state
for next generate call. Click download — confirm a file downloads.
Check the receipt: outputUrls must be `here.now://` or `opfs://` URIs,
never the raw provider URL.

***

### Task 15 — Image receipt schema
**File:** `apps/web/src/state/ydoc.ts` (or `packages/protocol/src/types.ts`)
**Time:** 1h

```typescript
export interface ImageReceipt {
  type:               "image";
  id:                 string;
  roomId:             string;
  createdAt:          number;
  signerPubkey:       string;
  prompt:             string;
  negativePrompt?:    string;
  modelId:            string;
  aspectRatio:        string;
  stylePreset?:       string;
  seed?:              number;
  referenceImageHash?: string;   // SHA-256 of reference — never the image itself
  outputUrls:         string[];  // permanent archived URLs (here.now or opfs://)
  outputCount:        number;
  tokenCost?:         number;    // images consumed from budget
}

// Save to vault on generation complete:
export async function saveImageReceipt(receipt: ImageReceipt): Promise<void> {
  await saveReceipt(receipt); // existing vault function — union type on Receipt
}
```

> **referenceImageHash instead of referenceImageUrl:** Storing the hash
> rather than the image or URL serves two purposes: (1) privacy — the
> reference image may be a user's unpublished work and should not be
> stored anywhere; (2) linkage — if the same reference image is used
> in multiple generations, the hash links them together in the fork
> graph without duplicating any data.

**✅ Verify:** Generate an image, complete the generation. Open the
vault (me page). Confirm an ImageReceipt appears with `type: "image"`,
non-empty `outputUrls` pointing to archived (not provider) URLs, and
correct `modelId` and `aspectRatio` fields.

***

## Phase 4 — MVS Features

***

### Task 16 — here.now uploadBlob upgrade
**File:** `apps/web/src/net/herenow.ts`
**Time:** 2–3h ⚠️

> **Treat this task as an investigation before an implementation.** The
> stub currently triggers a manual CLI script. Before writing a single
> line of upload code, determine:
> 1. What is the here.now upload endpoint URL?
> 2. What auth method does it use (OAuth bearer token, API key header,
>    session cookie)?
> 3. Does it accept multipart/form-data, raw binary, or base64?
> 4. What does the success response look like? (permanent URL format?)
> 5. Is there a file size limit? (video files can be 50MB+)
>
> If you can't answer all 5 in 30 minutes, implement the OPFS path first
> and ship with that. here.now upload becomes a "progressive enhancement"
> in a follow-up PR. The rest of the plan does not block on this task —
> archive.ts's OPFS fallback handles everything.

```typescript
// herenow.ts — upgrade uploadBlobToHereNow from stub:
export async function uploadBlobToHereNow(
  blob: Blob,
  metadata: { receiptId: string; modality: string },
): Promise<string> {
  const token = safeStorage.getItem(KEY_HERENOW_TOKEN);
  if (!token) throw new Error("Not authenticated with here.now");

  // TODO: confirm actual endpoint and auth after investigating API
  const form = new FormData();
  form.append("file",       blob, `${metadata.receiptId}.${extForModality(metadata.modality)}`);
  form.append("receiptId",  metadata.receiptId);
  form.append("modality",   metadata.modality);

  const res = await fetch("https://api.here.now/v1/upload", {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}` },
    body:    form,
  });

  if (res.status === 401) throw new Error("here.now token expired — re-authenticate");
  if (!res.ok) throw new Error(`here.now upload failed: ${res.status}`);

  const data = await res.json() as { url: string };
  return data.url; // permanent URL
}

function extForModality(m: string): string {
  return m === "image" ? "webp" : m === "audio" ? "mp3" : "mp4";
}
```

**✅ Verify:** Authenticate with here.now via the existing OAuth flow.
Upload a real image blob. Confirm the returned URL is accessible from
a different browser without auth (permanent + public). Confirm it's
still accessible after 24h (ephemeral URL test).

***

### Task 17 — One-click publish buttons
**Files:** `ReceiptCard.ts`, room header
**Time:** 1.5h

```typescript
// In ReceiptCard — add publish button alongside fork button:
export function attachPublishAction(
  card: HTMLElement,
  receipt: ImageReceipt | TextReceipt,
): void {
  const btn = document.createElement("button");
  btn.className = "ff-receipt-publish";
  btn.type = "button";
  btn.textContent = "Publish →";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Publishing…";
    try {
      // For image receipts: re-archive if still on OPFS
      if (receipt.type === "image") {
        const urls = await Promise.allSettled(
          receipt.outputUrls.map(async url => {
            if (url.startsWith("opfs://")) {
              const blob = await opfsUrlToBlob(url);
              return uploadBlobToHereNow(blob, { receiptId: receipt.id, modality: "image" });
            }
            return url; // already here.now URL
          })
        );
        // Update receipt with new permanent URLs
        const permanentUrls = urls.map((r, i) =>
          r.status === "fulfilled" ? r.value : receipt.outputUrls[i]);
        await saveReceipt({ ...receipt, outputUrls: permanentUrls });
      }
      // Copy link to clipboard
      const shareUrl = `https://fatedfortress.com/receipt/${receipt.id}`;
      await navigator.clipboard.writeText(shareUrl);
      btn.textContent = "Link copied ✓";
      setTimeout(() => { btn.textContent = "Publish →"; btn.disabled = false; }, 3_000);
    } catch (err) {
      btn.textContent = "Failed — retry";
      btn.disabled = false;
    }
  });
  card.appendChild(btn);
}
```

**✅ Verify:** Generate an image. Click "Publish →". Confirm button shows
"Publishing…" then "Link copied ✓". Paste the URL in an incognito window.
Confirm the receipt page loads and the image is visible without auth.

***

### Task 18 — Room templates
**Files:** `apps/web/src/state/ydoc.ts` (templates Y.Array), room creation UI
**Time:** 2h

```typescript
export interface RoomTemplate {
  id:             string;
  name:           string;
  roomType:       RoomType;
  systemPrompt?:  string;
  defaultModel:   string;
  defaultTemp?:   number;
  stylePresets?:  string[];
  aspectRatio?:   string;
  createdBy:      string;  // pubkey
  createdAt:      number;
  isPublic:       boolean;
}

// Save template (host only):
export function saveRoomTemplate(doc: FortressRoomDoc, template: RoomTemplate): void {
  const templates = doc.doc.getArray("templates");
  doc.doc.transact(() => { templates.push([template]); });
}

// In the lobby table page — seed public templates if templates array is empty:
const SEEDED_TEMPLATES: RoomTemplate[] = [
  {
    id: "tmpl-writing",
    name: "Writing Studio",
    roomType: "text",
    systemPrompt: "You are a skilled creative writing collaborator. ...",
    defaultModel: "gpt-4o",
    isPublic: true,
    createdBy: "ff-platform",
    createdAt: 0,
  },
  {
    id: "tmpl-concept-art",
    name: "Concept Art Brief",
    roomType: "image",
    defaultModel: "dall-e-3",
    aspectRatio: "16:9",
    stylePreset: "concept",
    isPublic: true,
    createdBy: "ff-platform",
    createdAt: 0,
  },
];
```

**✅ Verify:** Open the lobby. "Start from template" chips appear.
Click "Concept Art Brief" — a new image room opens with the correct
model, aspect ratio, and style preset pre-filled. Save a custom template
from inside a room — confirm it appears in the lobby for the creating user.

***

### Task 19 — Fork tree visualization
**File:** `apps/web/src/pages/me.ts` (new "Receipt Map" tab)
**Time:** 2h

```typescript
// Build the DAG from flat receipt list:
function buildReceiptGraph(receipts: Receipt[]): {
  nodes: Receipt[];
  edges: Array<{ from: string; to: string }>;
} {
  const edges: Array<{ from: string; to: string }> = [];
  const byId = new Map(receipts.map(r => [r.id, r]));

  receipts.forEach(r => {
    if ("forkOf" in r && r.forkOf && byId.has(r.forkOf)) {
      edges.push({ from: r.forkOf, to: r.id });
    }
  });

  return { nodes: receipts, edges };
}

// Simple tree renderer — CSS grid, no external dep for MVS:
function renderReceiptTree(graph: ReturnType<typeof buildReceiptGraph>): string {
  // Build depth map (BFS from roots)
  const depth = new Map<string, number>();
  const children = new Map<string, string[]>();
  graph.edges.forEach(e => {
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
  });
  const roots = graph.nodes
    .filter(n => !graph.edges.find(e => e.to === n.id))
    .map(n => n.id);

  const queue = roots.map(r => ({ id: r, d: 0 }));
  while (queue.length) {
    const { id, d } = queue.shift()!;
    depth.set(id, d);
    (children.get(id) ?? []).forEach(c => queue.push({ id: c, d: d + 1 }));
  }

  return graph.nodes
    .sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0))
    .map(r => `
      <div class="ff-tree-node" style="--depth:${depth.get(r.id) ?? 0}"
           data-id="${r.id}"
           role="button" tabindex="0"
           aria-label="Receipt ${r.id.slice(0, 8)} — click to fork"
           onclick="window.location.hash='#/room?seed=${r.id}'">
        ${r.type === "image"
          ? `<img src="${(r as ImageReceipt).outputUrls[0]}" alt="" width="80" height="80" loading="lazy" />`
          : `<p class="ff-tree-preview">${("prompt" in r ? r.prompt : "").slice(0, 60)}…</p>`}
        <span class="ff-tree-model">${r.modelId ?? ""}</span>
      </div>
    `).join("");
}
```

**✅ Verify:** The Receipt Map tab renders. Forked receipts appear
indented under their parent. Clicking a node navigates to the fork room.
Deep trees (4+ levels) render without overflow or horizontal scroll.

***

### Task 20 — Host settings panel
**File:** `apps/web/src/components/RoomSettingsPanel.ts` (new)
**Time:** 1h

```typescript
export class RoomSettingsPanel {
  private el: HTMLElement;
  private isHost: boolean;

  constructor(private doc: FortressRoomDoc, private myPubkey: string) {
    this.isHost = doc.meta.get("activeHostPubkey") === myPubkey;
    this.el = document.createElement("aside");
    this.el.className = "ff-settings-panel";
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", "Room settings");
    this.el.hidden = true;
  }

  toggle(): void { this.el.hidden = !this.el.hidden; }

  render(): void {
    const meta = this.doc.meta;
    const locked = !!meta.get("firstGenerationAt");

    this.el.innerHTML = `
      <div class="ff-settings-header">
        <h2>Room settings</h2>
        <button class="ff-settings-close" aria-label="Close settings">×</button>
      </div>
      <div class="ff-settings-body">
        ${this.field("Room name", "roomName", meta.get("roomName") ?? "", false)}
        ${this.field("Description", "description", meta.get("description") ?? "", false)}
        ${this.select("Category", "category",
            ["animation","code","paid","open"], meta.get("category") ?? "open", false)}
        ${this.select("Room type", "roomType",
            ["text","image","audio","video","multimodal"],
            meta.get("roomType") ?? "text",
            locked /* locked after first generation */)}
        ${this.toggle("Public room", "isPublic", meta.get("isPublic") ?? true, false)}
        ${this.toggle("Community keys", "allowCommunityKeys",
            meta.get("allowCommunityKeys") ?? false,
            false,
            "Allow participants to contribute their own API keys")}
      </div>
    `;

    // Wire save
    this.el.querySelectorAll("[data-field]").forEach(el => {
      el.addEventListener("change", e => {
        const target = e.target as HTMLInputElement | HTMLSelectElement;
        const key    = target.dataset.field!;
        const value  = target.type === "checkbox"
          ? (target as HTMLInputElement).checked
          : target.value;
        if (this.isHost) {
          this.doc.doc.transact(() => { meta.set(key, value); });
        }
      });
    });

    this.el.querySelector(".ff-settings-close")
      ?.addEventListener("click", () => this.toggle());
  }

  // ...field/select/toggle helper methods
}
```

> **Host-only enforcement:** The `if (this.isHost)` guard on the change
> handler is the app-layer gate — non-hosts physically cannot write to
> the meta Y.Map via this component. The cryptographic gate (worker
> budget token policy) is the trust boundary for generation-related
> settings. Settings like room name and description have no cryptographic
> gate — they're cosmetic and the risk of a participant changing them is
> low. For production hardening, add a CRDT guard in ydoc.ts that checks
> the pubkey attempting the write.

**✅ Verify:** As host: change room name → confirm change syncs to
second browser tab within 2s. Toggle community keys → confirm consent
modal appears for a participant on next page load. As participant: confirm
all fields are read-only.

***

### Task 21 — Onboarding upgrade
**File:** `apps/web/src/components/OnboardingModal.ts` (new)
**Time:** 1.5h

```typescript
type CraftType = "writing" | "illustration" | "game-dev" | "music" | "other";

const CRAFT_DEMOS: Record<CraftType, { prompt: string; roomType: RoomType; model: string }> = {
  "writing":       { prompt: "Continue: 'The letter arrived on a Tuesday...'", roomType: "text",  model: "gpt-4o" },
  "illustration":  { prompt: "concept art of a weathered lighthouse at dusk, moody atmosphere", roomType: "image", model: "dall-e-3" },
  "game-dev":      { prompt: "Write dialogue for a gruff blacksmith NPC in a fantasy RPG", roomType: "text",  model: "claude-3-5-sonnet" },
  "music":         { prompt: "Write lyrics for a melancholy lo-fi track about late nights", roomType: "text",  model: "gpt-4o" },
  "other":         { prompt: "What can you help me create today?", roomType: "text", model: "gpt-4o" },
};

export class OnboardingModal {
  private step = 1;
  private craft: CraftType = "writing";

  // Step 1: craft picker
  // Step 2: 5-second auto-play demo generation (call bridge.requestGenerate with demo key)
  // Step 3: "Try it" — pre-filled prompt, CTA to "Start creating"

  private renderStep1(): string {
    return `
      <h2>What do you create?</h2>
      <div class="ff-craft-grid" role="radiogroup">
        ${(["writing","illustration","game-dev","music","other"] as CraftType[]).map(c => `
          <button class="ff-craft-option ${c === this.craft ? "selected" : ""}"
                  data-craft="${c}" role="radio" aria-checked="${c === this.craft}">
            ${CRAFT_ICONS[c]}
            <span>${CRAFT_LABELS[c]}</span>
          </button>
        `).join("")}
      </div>
      <button class="ff-btn-primary ff-onboard-next">Continue →</button>
    `;
  }

  private async renderStep2(): Promise<string> {
    const demo = CRAFT_DEMOS[this.craft];
    // Trigger a demo generation — result streams into a mini OutputPane
    // Uses demo key from Priority 1 patches (already wired in room.ts)
    return `
      <h2>Watch it work</h2>
      <div class="ff-onboard-demo" id="onboard-output">
        <p class="ff-text-muted">Generating a ${this.craft} example…</p>
      </div>
      <button class="ff-btn-primary ff-onboard-next" style="margin-top:var(--space-4)">
        Looks good →
      </button>
    `;
  }

  private renderStep3(): string {
    const demo = CRAFT_DEMOS[this.craft];
    return `
      <h2>Your turn</h2>
      <p class="ff-text-muted">
        You have a demo key ready. Try typing a prompt below — no account needed.
      </p>
      <textarea class="ff-input ff-onboard-prompt" rows="3"
                placeholder="${demo.prompt}"></textarea>
      <button class="ff-btn-primary ff-onboard-start">Start creating →</button>
    `;
  }
}
```

> **Demo key integration note:** Step 2's auto-play generation uses the
> demo key from the Priority 1 patches (already shipped). Make sure
> `consumeDemoToken()` is called with the onboarding room's `roomId`
> before Step 2 renders. If the demo key is rate-limited, skip Step 2
> and go straight to Step 3 with a message: "Demo key unavailable —
> add your own key to get started."

**✅ Verify:** First visit in incognito: onboarding modal appears.
Select "illustration" → Step 2 auto-generates a brief image prompt result
in the mini OutputPane. Step 3 has the illustration prompt pre-filled.
Click "Start creating" — modal closes, craft type is stored in identity
metadata, lobby shows illustration-relevant seeded rooms.

***

## Final Verification Checklist

Run these after all 21 tasks are complete and before any public sharing:

**Data integrity:**
- [ ] Open an old room — legacy text still displays in OutputPane
- [ ] SpectatorChat Y.Map fix: send a message, confirm observer fires
- [ ] Image receipt outputUrls contain `here.now://` or `opfs://`, never raw provider URLs

**Security:**
- [ ] POST `GENERATE` with `modality: "image"` to a text room's worker — must get MODALITY_NOT_ALLOWED
- [ ] Remove API key mid-video-generation — job must still complete (key captured at registration)
- [ ] Non-host attempt to write `allowCommunityKeys` — must be silently ignored by Y.js guard

**Reliability:**
- [ ] Abort a video generation mid-poll — no orphaned polling in Network tab
- [ ] Navigate between rooms 5 times — only 1 presence heartbeat interval fires
- [ ] Image generation with 3 images — archive failure on 1 does not fail the other 2

**UX:**
- [ ] Presence bar shows correct state dots (active, idle, generating)
- [ ] Typing indicator appears in tab B when typing in tab A, clears within 3s
- [ ] Onboarding completes in all 5 craft types without errors
- [ ] Host settings panel is read-only for non-host participants

**Build:**
- [ ] `tsc --noEmit` zero errors across all three apps
- [ ] `vite build` clean for apps/web and apps/worker
- [ ] `wrangler deploy --dry-run` clean for apps/relay


# Fated Fortress — Hardened Build Plan
## 21 Tasks · ~31h Human / ~3h at AI velocity

***

## ⚠️ Before You Start: Three Non-Negotiable Rules

**Rule 1 — Never skip a verification step.**
Every task has a "Verify" checkpoint. At 100 TPS it's tempting to chain
tasks without stopping. Don't. One wrong assumption in Task 7 (yield types)
propagates silently through Tasks 8, 9, 10, 13, and 14. The verify step
costs 30 seconds. The silent bug costs 3 hours.

**Rule 2 — Commit after every completed task.**
`git commit -m "task-N: <description>"` after each task. Not after each
phase — after each task. If Task 10's OutputPane migration goes sideways,
you want to `git stash` and return to Task 9's clean state, not Phase 2.

**Rule 3 — OPFS fallback must work before here.now is touched.**
Task 6 (archive.ts) must be written with the OPFS path fully functional and
tested before the here.now path is attempted. Task 16 may surprise you.
Task 6 must not.

***

## Phase 0 — Data Correctness

> **Why Phase 0 exists:** Y.js CRDT operations on raw JS objects are
> permanently broken in a way that gets worse over time. Every new joiner
> to a room with a broken spectatorChat receives stale data with no
> error. Fix this before any other chat work, and fix it before deploying
> anything else — you don't want real users accumulating corrupt history.

***

### Task 1 — Fix SpectatorChat Y.Array insertion
**File:** `apps/web/src/components/SpectatorChat.ts`
**Time:** 1h

**The bug:** `spectatorChat.push([rawObject])` stores a plain JS object
that is not observable. Y.js wraps it in its internal encoding once and
never again. You cannot call `.observe()` on it, cannot add reactions to
it, and cannot soft-delete it. New joiners who receive this entry see a
frozen snapshot — they can read it but it will never update.

**Replace insertion (lines ~40–48):**
```typescript
// BEFORE (broken):
const entry: SpectatorMessage = { id: crypto.randomUUID(), pubkey: myPubkey, ... };
this.doc.doc.transact(() => { this.doc.spectatorChat.push([entry]); });

// AFTER (correct):
const msgMap = new Y.Map<string, unknown>();
msgMap.set("id",          crypto.randomUUID());
msgMap.set("pubkey",      myPubkey as PublicKeyBase58);
msgMap.set("displayName", displayName);
msgMap.set("text",        text);
msgMap.set("ts",          Date.now());
// Optional future fields — set them now so schema is forward-compatible:
msgMap.set("type",        "text");           // ChatMessageType
msgMap.set("isDeleted",   false);
msgMap.set("reactions",   {} as Record<string, string[]>);
this.doc.doc.transact(() => { this.doc.spectatorChat.push([msgMap]); });
```

> ⚠️ **Set all fields inside the same transact() block.** If you set
> fields outside the transaction and the tab crashes between sets, you
> get a partially-written Y.Map that passes `instanceof Y.Map` but has
> missing keys. Observers then throw on `.get("text")` returning
> undefined. One transact, all fields, always.

**Update subscribe() reader (lines ~58–60):**
```typescript
const messages = this.doc.spectatorChat.toArray().map(m => {
  if (m instanceof Y.Map) {
    return {
      id:          m.get("id")          as string,
      pubkey:      m.get("pubkey")      as PublicKeyBase58,
      displayName: m.get("displayName") as string,
      text:        m.get("text")        as string,
      ts:          m.get("ts")          as number,
      type:        (m.get("type") ?? "text") as ChatMessageType,
      isDeleted:   (m.get("isDeleted") ?? false) as boolean,
    } satisfies SpectatorMessage;
  }
  // Legacy raw-object fallback — read-only, never write this shape again
  return m as SpectatorMessage;
});
```

> **Why keep the legacy fallback?** Any room created before this fix has
> raw objects in its spectatorChat Y.Array. Those objects are permanent —
> Y.js cannot remove them from CRDT history. The `m instanceof Y.Map`
> guard lets both coexist. Do NOT attempt to "migrate" old entries by
> deleting and re-inserting — a delete+insert is two CRDT operations that
> peers can receive out of order, resulting in a message appearing,
> disappearing, and reappearing in random order for different peers.

**✅ Verify:**
```typescript
// In browser console after fix:
const chat = doc.spectatorChat;
chat.push([new Y.Map()]);                    // correct insert (test)
console.log(chat.get(chat.length - 1) instanceof Y.Map); // must be true
chat.observe(e => console.log("observable")); // must fire on next push
```
Send a message and confirm the observer fires. If it does, Task 1 is done.

***

## Phase 1 — Presence Infrastructure

> **Why before multimodal:** Presence touches `ydoc.ts`, `signaling.ts`,
> and `room.ts` — the three most-imported files in the codebase. If you
> build image rooms first and then retrofit presence, you'll modify files
> that have already been modified by 8 other tasks. Do presence now while
> those files are clean.

***

### Task 2 — Extend PresenceEntry interface
**File:** `apps/web/src/state/ydoc.ts` (lines ~69)
**Time:** 0.5h

```typescript
export interface PresenceEntry {
  pubkey:        PublicKeyBase58;
  name:          string;
  lastSeenAt:    number;
  state: "active" | "idle" | "away" | "generating" | "spectating" | "offline";
  currentAction?: {
    type:     "generating" | "typing" | "viewing";
    modelId?: string;       // only when type === "generating"
    startedAt: number;
  };
  avatarSeed:   string;     // pubkey → deterministic hue, no external requests
  isHost:       boolean;
  role:         "host" | "participant" | "spectator";
  connectedVia: "p2p" | "relay";
}
```

> **avatarSeed note:** Compute as a hex string from the first 4 bytes of
> SHA-256(pubkey). This gives 16^4 = 65536 unique hues without any
> network call. The PresenceBar uses this to pick an HSL color. Never
> use an external avatar service — that leaks pubkeys to a third party.

```typescript
// Suggested helper (add to identity.ts or ydoc.ts):
export function pubkeyToAvatarSeed(pubkey: string): string {
  // Simple deterministic hash — no crypto needed, just visual diversity
  let h = 0;
  for (let i = 0; i < pubkey.length; i++) {
    h = (Math.imul(31, h) + pubkey.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
// Usage: avatarColor = `hsl(${parseInt(seed, 16) % 360}, 70%, 55%)`
```

**✅ Verify:** TypeScript builds with zero errors after interface change.
`tsc --noEmit` from `apps/web/`.

***

### Task 3 — Ephemeral typing broadcast
**File:** `apps/web/src/net/signaling.ts`
**Time:** 1h

> **Why WebSocket, not Y.js:** A Y.js write is permanent. It syncs to
> every peer including those who join 10 minutes later. A "typing"
> indicator from 10 minutes ago is nonsense. Relay WS broadcast is
> fire-and-forget — if a peer misses it, they just don't see the
> indicator flicker. That's acceptable. A stale CRDT entry is not.

**Add to signaling.ts:**
```typescript
let typingDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function broadcastTyping(roomId: string, isTyping: boolean): void {
  if (!wsOpen()) return;
  ws.send(JSON.stringify({
    type:   isTyping ? "TYPING_START" : "TYPING_STOP",
    peerId: getMyPubkey(),
    roomId,
  }));
}

// Debounced version for use in chat input keydown handler:
export function notifyTyping(roomId: string): void {
  broadcastTyping(roomId, true);
  if (typingDebounceTimer) clearTimeout(typingDebounceTimer);
  // Auto-stop after 3s of no keystrokes
  typingDebounceTimer = setTimeout(() => broadcastTyping(roomId, false), 3_000);
}
```

**In the relay WS message switch (existing switch in signaling.ts):**
```typescript
case "TYPING_START":
case "TYPING_STOP": {
  // Emit to UI — do NOT write to Y.js
  const isTyping = msg.type === "TYPING_START";
  typingIndicatorEmitter.emit(msg.peerId, isTyping);
  break;
}
```

> **RelayDO also needs to broadcast these.** Add to RelayDO's
> handleWebSocket: if msg.type is TYPING_START or TYPING_STOP, broadcast
> to all peers in room EXCEPT the sender. No persistence, no logging.
> These are the cheapest messages in the system — treat them as such.

**✅ Verify:** Open two browser tabs on the same room. Type in tab A's
chat input. Tab B should see a typing indicator within 1s. Stop typing —
indicator should clear within 3s.

***

### Task 4 — Presence heartbeat
**File:** `apps/web/src/pages/room.ts`
**Time:** 1h

**Add to both `mountRoom` and `mountSpectatorRoom`:**
```typescript
// Track last user interaction
let lastInteraction = Date.now();
const onInteract = () => { lastInteraction = Date.now(); };
document.addEventListener("mousemove",  onInteract, { passive: true });
document.addEventListener("keydown",    onInteract, { passive: true });
document.addEventListener("touchstart", onInteract, { passive: true });

const presenceInterval = setInterval(() => {
  const idleMs  = Date.now() - lastInteraction;
  let state: PresenceEntry["state"] = "active";
  if (document.hidden) state = "away";
  else if (idleMs > 5 * 60_000) state = "away";
  else if (idleMs > 30_000)     state = "idle";

  const existing = doc.presence.get(myPubkey) as PresenceEntry | undefined;
  // Don't overwrite "generating" state from heartbeat — generation handler owns that
  if (existing?.state === "generating") return;

  upsertPresence(doc, {
    ...existing,
    pubkey:      myPubkey,
    name:        getMyDisplayName(),
    lastSeenAt:  Date.now(),
    state,
    avatarSeed:  pubkeyToAvatarSeed(myPubkey),
    isHost:      doc.meta.get("activeHostPubkey") === myPubkey,
    role:        isSpectator ? "spectator" : "participant",
    connectedVia: getConnectionType(), // from signaling.ts
  });
}, 15_000);

// Cleanup on unmount — critical, or intervals stack across navigations
return () => {
  clearInterval(presenceInterval);
  document.removeEventListener("mousemove",  onInteract);
  document.removeEventListener("keydown",    onInteract);
  document.removeEventListener("touchstart", onInteract);
};
```

> ⚠️ **The cleanup return is mandatory.** Fated Fortress is a SPA —
> `mountRoom` may be called multiple times if the user navigates between
> rooms. Without cleanup, you accumulate one interval per navigation.
> After 5 room visits you have 5 heartbeat loops all writing to presence
> simultaneously, causing Y.js transact storms and flickering presence UI.
> Always return a teardown function. Always call it on unmount.

**✅ Verify:** Open DevTools Performance tab. Navigate between two rooms
three times. Confirm there is only ever ONE presence update firing every
15s, not 3 or 6.

***

### Task 5 — PresenceBar component
**File:** `apps/web/src/components/PresenceBar.ts` (new)
**Time:** 2h

```typescript
export class PresenceBar {
  private container: HTMLElement;
  private unsubscribe: (() => void) | null = null;

  constructor(private doc: FortressRoomDoc) {
    this.container = document.createElement("div");
    this.container.className = "ff-presence-bar";
    this.container.setAttribute("role", "list");
    this.container.setAttribute("aria-label", "Room participants");
  }

  mount(target: HTMLElement): void {
    target.appendChild(this.container);
    // Subscribe to presence Y.Map changes
    const handler = () => this.render();
    this.doc.presence.observe(handler);
    this.unsubscribe = () => this.doc.presence.unobserve(handler);
    this.render();
  }

  unmount(): void {
    this.unsubscribe?.();
    this.container.remove();
  }

  private render(): void {
    const entries = Array.from(this.doc.presence.values()) as PresenceEntry[];
    // Sort: host first, then participants by lastSeenAt desc, then spectators
    entries.sort((a, b) => {
      if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
      if (a.role === "spectator" && b.role !== "spectator") return 1;
      if (b.role === "spectator" && a.role !== "spectator") return -1;
      return b.lastSeenAt - a.lastSeenAt;
    });

    this.container.innerHTML = entries.map(e => this.renderEntry(e)).join("");
    // Spectator count pill
    const spectators = entries.filter(e => e.role === "spectator").length;
    if (spectators > 0) {
      this.container.insertAdjacentHTML("beforeend",
        `<span class="ff-presence-spectators" aria-label="${spectators} spectators">
           👁 ${spectators}
         </span>`);
    }
  }

  private renderEntry(e: PresenceEntry): string {
    const hue   = parseInt(e.avatarSeed, 16) % 360;
    const color = `hsl(${hue}, 70%, 55%)`;
    const dot   = STATE_DOT[e.state] ?? "#9ca3af";
    const label = `${e.name}${e.isHost ? " (host)" : ""}`;
    const action = e.currentAction?.type === "generating"
      ? ` · generating ${e.currentAction.modelId ?? "…"}`
      : "";
    const since  = this.relativeTime(e.lastSeenAt);

    return `
      <div class="ff-presence-entry" role="listitem"
           data-pubkey="${e.pubkey}"
           aria-label="${label}${action}">
        <div class="ff-presence-avatar" style="background:${color}" aria-hidden="true">
          ${e.name.slice(0, 1).toUpperCase()}
        </div>
        <span class="ff-presence-dot" style="background:${dot}"
              aria-label="Status: ${e.state}"></span>
        <div class="ff-presence-tooltip">
          <strong>${label}</strong>
          <span>${e.role} · ${e.connectedVia}</span>
          <span>Last seen ${since}</span>
          ${action ? `<span>${action}</span>` : ""}
        </div>
      </div>`;
  }

  private relativeTime(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 10)  return "just now";
    if (s < 60)  return `${s}s ago`;
    if (s < 120) return "1 min ago";
    return `${Math.floor(s / 60)} min ago`;
  }

  destroy(): void { this.unmount(); }
}

const STATE_DOT: Record<PresenceEntry["state"], string> = {
  active:     "#22c55e", // green
  idle:       "#eab308", // yellow
  away:       "#9ca3af", // gray
  generating: "#0d9488", // teal
  spectating: "#6b7280", // faint gray
  offline:    "#ef4444", // red
};
```

**✅ Verify:** Open a room with two tabs. Both tabs show each other's
avatar in the presence bar. Idle one tab for 30s — its dot turns yellow.
Close a tab — the other tab's presence bar removes that entry within 60s.

***

## Phase 2 — Multimodal Infrastructure

> **The critical path for image rooms:** Task 6 (archive.ts) and Task 7
> (yield types) are the foundations. Do NOT start Task 8 or Task 9
> without Task 7 merged. The yield union type is imported by adapters,
> generate.ts, OutputPane, and the bridge — getting it wrong means 5
> files need a simultaneous fix instead of 1.

***

### Task 6 — archive.ts
**File:** `apps/web/src/state/archive.ts` (new)
**Time:** 0.5h

```typescript
import { uploadBlobToHereNow } from "../net/herenow.js";

const OPFS_DIR = "ff-output-archive";

export async function archiveOutput(
  receiptId: string,
  temporaryUrl: string,
  modality: "image" | "audio" | "video",
): Promise<string> {
  let blob: Blob;
  try {
    const res = await fetch(temporaryUrl);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    blob = await res.blob();
  } catch (err) {
    console.error("[archive] Failed to fetch temporary URL:", err);
    throw err; // Caller decides whether to save the raw (expiring) URL as a fallback
  }

  // Try here.now first — permanent + shareable
  try {
    const permanentUrl = await uploadBlobToHereNow(blob, { receiptId, modality });
    return permanentUrl;
  } catch (hereNowErr) {
    console.warn("[archive] here.now upload failed, falling back to OPFS:", hereNowErr);
  }

  // OPFS fallback — local only, not shareable, but permanent on this device
  return await storeInOPFS(receiptId, blob, modality);
}

async function storeInOPFS(
  receiptId: string,
  blob: Blob,
  modality: string,
): Promise<string> {
  const root = await navigator.storage.getDirectory();
  const dir  = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  const ext  = modality === "image" ? "webp" : modality === "audio" ? "mp3" : "mp4";
  const fh   = await dir.getFileHandle(`${receiptId}.${ext}`, { create: true });
  const writable = await fh.createWritable();
  await writable.write(blob);
  await writable.close();
  // Return an opaque identifier — caller stores this, not a real URL
  return `opfs://${OPFS_DIR}/${receiptId}.${ext}`;
}

// Call this to resolve an opfs:// identifier back to an object URL for display
export async function resolveOpfsUrl(opfsId: string): Promise<string> {
  const [, , dir, filename] = opfsId.split("/");
  const root = await navigator.storage.getDirectory();
  const dirHandle  = await root.getDirectoryHandle(dir);
  const fileHandle = await dirHandle.getFileHandle(filename);
  const file = await fileHandle.getFile();
  return URL.createObjectURL(file); // revoke after use
}
```

> **Why `opfs://` pseudo-URL instead of a real object URL?** Object URLs
> (`blob:` scheme) are revoked when the page unloads. If you store a
> `blob:` URL in a receipt, it works in the current session and breaks
> on reload. The `opfs://` identifier is permanent — it points to a file
> in the Origin Private File System which persists across sessions. Call
> `resolveOpfsUrl()` at display time to get a short-lived object URL.

**✅ Verify:**
```typescript
// In console, after a generation with a real image URL:
const url = await archiveOutput("test-123", "https://...real-provider-url...", "image");
console.log(url); // should be either a here.now URL or "opfs://ff-output-archive/test-123.webp"
// If OPFS path:
const displayUrl = await resolveOpfsUrl(url);
const img = document.createElement("img");
img.src = displayUrl;
document.body.appendChild(img); // should show the image
```

***

### Task 7 — AdapterYield union type
**File:** `packages/protocol/src/types.ts`
**Time:** 0.5h

```typescript
export type AdapterYield =
  | { type: "text_delta";  delta: string }
  | { type: "image_url";   url: string; index: number }
  | { type: "audio_url";   url: string; format: "mp3" | "wav" | "ogg" }
  | { type: "audio_chunk"; chunk: ArrayBuffer }
  | { type: "job_id";      jobId: string; pollUrl: string; estimatedMs: number }
  | { type: "progress";    percent: number; message?: string }
  | { type: "done";        metadata?: Record<string, unknown> };

// Also add modality to GenerateRequest so the worker knows what it's generating:
export interface GenerateRequest {
  // existing fields...
  modality: "text" | "image" | "audio" | "video"; // NEW
}
```

> ⚠️ **This is the most import-heavy change in the plan.** Every adapter
> file currently returns `AsyncGenerator<string>`. After this task, they
> return `AsyncGenerator<AdapterYield>`. Do a global search for
> `: AsyncGenerator<string>` and `: AsyncIterable<string>` before moving
> to Task 9 — those are the locations that need updating.
>
> The `modality` field on `GenerateRequest` is needed by the worker's
> budget branch (Task 11) and the roomType lock check (Task 12). Add it
> now or you'll need to retrofit it in two separate tasks.

**✅ Verify:** `tsc --noEmit` from workspace root. Zero new errors. If
existing adapters error on return type mismatch, that's expected — fix
their signatures in Task 9, not here.

***

### Task 8 — async-jobs.ts
**File:** `apps/worker/src/async-jobs.ts` (new)
**Time:** 3h

> **The single most complex new file in this plan.** The polling loop
> runs inside the worker sandbox, outlives individual generate requests,
> and must handle: network failures during poll (retry), key removal
> after job registration (safe — key captured at registration), user
> abort (cancel), timeout (5 min default), and out-of-order completion
> (rare, but a job can complete before its first poll fires).

```typescript
import { getRawKey }   from "./keystore.js";
import { sendProgress, sendError, sendDone } from "./router-primitives.js";

interface TrackedJob {
  requestId:     string;
  jobId:         string;
  pollUrl:       string;
  apiKey:        string;    // CAPTURED AT REGISTRATION — not at poll time
  provider:      string;
  startedAt:     number;
  timeoutMs:     number;    // default: 300_000 (5 min)
  pollIntervalMs: number;   // default: 5_000
  attempts:      number;
  outputType:    "image_url" | "audio_url" | "video_url";
}

const jobs = new Map<string, TrackedJob>();

export async function registerAsyncJob(
  job: Omit<TrackedJob, "attempts" | "startedAt" | "apiKey">
): Promise<void> {
  // Capture key NOW — if user removes key while job is polling, we still succeed
  const apiKey = await getRawKey(job.provider);
  if (!apiKey) {
    sendError(job.requestId, {
      code: "NO_KEY_AT_REGISTRATION",
      message: `No key for ${job.provider} — cannot submit async job`,
    });
    return;
  }
  jobs.set(job.jobId, { ...job, apiKey, startedAt: Date.now(), attempts: 0 });
  scheduleNextPoll(job.jobId);
}

export function cancelAsyncJobsForRequest(requestId: string): void {
  for (const [jobId, job] of jobs) {
    if (job.requestId === requestId) {
      jobs.delete(jobId);
      console.debug(`[async-jobs] cancelled job ${jobId} for request ${requestId}`);
    }
  }
}

function scheduleNextPoll(jobId: string): void {
  const job = jobs.get(jobId);
  if (!job) return; // already cancelled

  setTimeout(async () => {
    const j = jobs.get(jobId);
    if (!j) return; // cancelled during wait

    j.attempts++;
    const elapsed = Date.now() - j.startedAt;

    if (elapsed > j.timeoutMs) {
      jobs.delete(jobId);
      sendError(j.requestId, {
        code: "JOB_TIMEOUT",
        message: `Job ${jobId} timed out after ${j.timeoutMs / 1000}s (${j.attempts} polls)`,
      });
      return;
    }

    try {
      const result = await pollOnce(j);

      if (result.status === "completed") {
        jobs.delete(jobId);
        // Send the output before done — OutputPane needs the URL before finalising
        sendOutput(j.requestId, j.outputType, result.outputUrl!);
        sendDone(j.requestId, { durationMs: elapsed, attempts: j.attempts });

      } else if (result.status === "failed") {
        jobs.delete(jobId);
        sendError(j.requestId, {
          code: "JOB_FAILED",
          message: result.error ?? `Job ${jobId} failed after ${j.attempts} polls`,
        });

      } else {
        // Still pending — report progress and reschedule
        const pct = result.progress ?? Math.min(90, (elapsed / j.timeoutMs) * 100);
        sendProgress(j.requestId, pct, result.message ?? "Processing…");
        scheduleNextPoll(jobId);
      }

    } catch (pollErr) {
      // Network error during poll — log and retry unless timed out
      console.warn(`[async-jobs] poll error for ${jobId} (attempt ${j.attempts}):`, pollErr);
      scheduleNextPoll(jobId); // retry — timeout will eventually catch runaway retries
    }

  }, job.pollIntervalMs);
}

async function pollOnce(job: TrackedJob): Promise<{
  status: "pending" | "completed" | "failed";
  outputUrl?: string;
  progress?: number;
  message?: string;
  error?: string;
}> {
  const res = await fetch(job.pollUrl, {
    headers: { Authorization: `Bearer ${job.apiKey}` },
  });
  if (!res.ok) throw new Error(`Poll HTTP ${res.status}`);
  return res.json();
}

function sendOutput(requestId: string, type: TrackedJob["outputType"], url: string): void {
  // Reuse existing send infrastructure from router-primitives
  const msgType = type === "image_url" ? "IMAGE_URL"
                : type === "audio_url" ? "AUDIO_URL"
                : "VIDEO_URL";
  self.postMessage({ type: msgType, requestId, url });
}
```

> **Two edge cases to handle explicitly:**
>
> 1. **The job completes before the first poll fires** (rare but possible
>    with fast providers). Your `setTimeout` with `pollIntervalMs` delay
>    means the first poll fires 5s after registration. If the job is done
>    in 2s, the `completed` status will be returned on attempt 1 and
>    everything is fine. No special handling needed — just don't add an
>    "is this the first poll?" guard that skips the completion check.
>
> 2. **Duplicate completion** (provider sometimes returns `completed`
>    twice due to retry logic on their side). The `jobs.delete(jobId)`
>    call before `sendDone` prevents double-sending — the second poll
>    will find `jobs.get(jobId) === undefined` and return early.

**✅ Verify:** Unit test the polling loop with a mock `pollOnce`:
```typescript
// Test: job completes on attempt 2
// Test: job times out after maxAttempts equivalent
// Test: cancelAsyncJobsForRequest stops the loop
// Test: network error during poll retries instead of failing
```

***

### Task 8.5 — Wire ABORT_GENERATE to cancel polls
**File:** `apps/worker/src/router.ts`
**Time:** 15 min

```typescript
import { cancelAsyncJobsForRequest } from "./async-jobs.js";

// In the ABORT_GENERATE case — add cancelAsyncJobsForRequest BEFORE abort():
case "ABORT_GENERATE": {
  cancelAsyncJobsForRequest(payload.requestId); // cancel polling loop
  abortControllerMap.get(payload.requestId)?.abort(); // cancel streaming
  abortControllerMap.delete(payload.requestId);
  break;
}
```

> This is the easiest task in the plan and the one most likely to be
> forgotten. It has no output of its own — it's a two-line addition to
> an existing case. Add it immediately after Task 8 while async-jobs.ts
> is fresh in context.

**✅ Verify:** Submit a video generation. While the progress indicator is
visible, click Abort. Confirm no further POLL requests appear in the
DevTools Network tab after abort.

***

### Task 9 — Extend generate.ts yield loop
**File:** `apps/worker/src/generate.ts`
**Time:** 2h

**Update adapter interface:**
```typescript
// Change every adapter from:
export async function* generate(...): AsyncGenerator<string>

// To:
export async function* generate(...): AsyncGenerator<AdapterYield>

// Text adapters: wrap existing string yields
// BEFORE: yield chunk;
// AFTER:  yield { type: "text_delta", delta: chunk };
```

**Extend the yield handler in handleGenerate:**
```typescript
for await (const chunk of adapter.generate(opts)) {
  switch (chunk.type) {
    case "text_delta":
      appendToOutput(doc, requestId, chunk.delta); // existing path
      sendChunk(requestId, chunk.delta);
      break;

    case "image_url":
      sendOutput("IMAGE_URL", requestId, chunk.url, chunk.index);
      break;

    case "audio_url":
    case "audio_chunk":
      sendOutput("AUDIO_URL", requestId, "url" in chunk ? chunk.url : "");
      break;

    case "job_id":
      // Hand off to async polling — generate() returns after this
      await registerAsyncJob({
        requestId,
        jobId:         chunk.jobId,
        pollUrl:       chunk.pollUrl,
        provider:      opts.provider,
        timeoutMs:     300_000,
        pollIntervalMs: 5_000,
        outputType:    opts.modality === "audio" ? "audio_url"
                     : opts.modality === "video" ? "video_url"
                     : "image_url",
      });
      return; // Exit generate loop — async-jobs.ts takes over

    case "progress":
      sendProgress(requestId, chunk.percent, chunk.message);
      break;

    case "done":
      finaliseQuota(requestId);
      sendDone(requestId, chunk.metadata);
      return;
  }
}
```

> ⚠️ **The `return` after `registerAsyncJob` is critical.** When a
> video adapter yields a `job_id`, the generate loop must exit — the
> async polling loop in async-jobs.ts takes over from here. If you
> `break` instead of `return`, the `for await` loop continues on the
> next yield from the adapter, which (for video adapters) is nothing,
> and the function falls through to `finaliseQuota` early — double-
> finalising the quota and breaking the budget accounting.

**✅ Verify:** Run a text generation and confirm `text_delta` chunks
still stream correctly. Run an image generation and confirm `IMAGE_URL`
message arrives at the main thread. Check budget accounting is unchanged
for text.

***

### Task 10 — Migrate OutputPane from Y.Text to Y.Array\<Y.Map\>
**File:** `apps/web/src/components/OutputPane.ts`
**Time:** 4–5h

> **Highest-risk task in the plan.** You are changing a live data layer
> that existing rooms depend on. The migration strategy is:
> 1. Add `outputItems` Y.Array to the doc schema (additive — does not
>    break existing rooms)
> 2. New generations write to `outputItems` only
> 3. OutputPane reads `outputItems` first; if empty, falls back to
>    `doc.output.toString()` (legacy text)
> 4. Old rooms continue to display correctly via the fallback
> 5. Never backfill old `doc.output` text into `outputItems` — that
>    would create duplicate display and confuse the receipt system

**Add to ydoc.ts schema:**
```typescript
// In FortressRoomDoc (additive, does NOT change existing rooms):
get outputItems(): Y.Array<Y.Map<string, unknown>> {
  return this.doc.getArray("outputItems");
}

// OutputItem helper:
export function createOutputItem(fields: Partial<OutputItem> & {
  id: string; receiptId: string; modality: OutputItem["modality"];
}): Y.Map<string, unknown> {
  const m = new Y.Map<string, unknown>();
  Object.entries(fields).forEach(([k, v]) => m.set(k, v));
  m.set("createdAt", Date.now());
  m.set("status", fields.status ?? "streaming");
  return m;
}
```

**OutputPane render logic:**
```typescript
private render(): void {
  const items = this.doc.outputItems.toArray() as Y.Map<string, unknown>[];

  if (items.length === 0) {
    // Legacy fallback: render doc.output Y.Text
    const text = this.doc.output.toString();
    if (text) {
      this.container.innerHTML = this.renderMarkdown(text);
      return;
    }
    this.renderEmpty();
    return;
  }

  this.container.innerHTML = items.map(item => {
    const modality = item.get("modality") as OutputItem["modality"];
    switch (modality) {
      case "text":  return this.renderTextItem(item);
      case "image": return this.renderImageItem(item);
      case "audio": return this.renderAudioItem(item);
      case "video": return this.renderVideoItem(item);
      default:      return "";
    }
  }).join("");
}
```

**For streaming text — append to Y.Map instead of Y.Text:**
```typescript
// In ControlPane (or wherever generation output is appended):
// BEFORE: doc.output.insert(doc.output.length, delta);
// AFTER:
const currentItem = getStreamingOutputItem(doc); // get or create the active item
doc.doc.transact(() => {
  const existing = (currentItem.get("text") as string) ?? "";
  currentItem.set("text", existing + delta);
  currentItem.set("status", "streaming");
});
```

> **Important: Y.Text vs Y.Map for streaming text.** Y.Text has
> built-in CRDT merge semantics for concurrent edits (character-level
> merging). Y.Map with a string value does NOT — the last write wins.
> For the current single-host-generates model, last-write-wins is
> acceptable since only one peer writes to the output stream at a time.
> If you ever add concurrent multi-host generation, you'll need to
> switch the text field back to a nested Y.Text. Document this decision
> in a comment in the code.

**✅ Verify:** 
- Open an old room — confirms legacy text still displays
- Generate new text in a new room — confirms it writes to outputItems and renders
- Generate an image (after Tasks 12-14) — confirms image grid renders
- Reload the page mid-generation — confirms partial output is preserved in Y.Map

***

### Task 11 — Budget token multimodal updates
**File:** `packages/protocol/src/types.ts` + `apps/worker/src/budget.ts`
**Time:** 1h

```typescript
// types.ts — extend BudgetTokenClaims:
export interface BudgetTokenClaims {
  maxTokens:        number;        // existing
  maxImages?:       number;        // per-generation cap for image rooms
  maxAudioSeconds?: number;
  maxVideoSeconds?: number;
  allowedModalities: Array<"text" | "image" | "audio" | "video">;
}

// budget.ts — branch reserveQuota on modality:
export async function reserveQuota(
  requestId: string,
  claims: BudgetTokenClaims,
  modality: "text" | "image" | "audio" | "video",
  amount: number, // tokens, images, seconds depending on modality
): Promise<void> {
  switch (modality) {
    case "text":
      if (claims.maxTokens < amount)
        throw new BudgetError("QUOTA_EXCEEDED", "Token budget exceeded");
      // existing token reservation logic
      break;
    case "image":
      if (!claims.maxImages || claims.maxImages < amount)
        throw new BudgetError("QUOTA_EXCEEDED", "Image budget exceeded");
      // decrement maxImages
      break;
    case "audio":
      if (!claims.maxAudioSeconds || claims.maxAudioSeconds < amount)
        throw new BudgetError("QUOTA_EXCEEDED", "Audio budget exceeded");
      break;
    case "video":
      if (!claims.maxVideoSeconds || claims.maxVideoSeconds < amount)
        throw new BudgetError("QUOTA_EXCEEDED", "Video budget exceeded");
      break;
  }
}
```

> **FuelGauge update needed:** The FuelGauge component currently shows
> "X tokens remaining." For image rooms it should show "X images
> remaining" and for video rooms "Xs of video remaining." Read
> `doc.meta.get("roomType")` in FuelGauge to determine which unit to
> display. This is a cosmetic change but impacts perceived trust — a
> token counter on an image room confuses users.

**✅ Verify:** Mint a budget token with `allowedModalities: ["image"]`
and `maxImages: 2`. Attempt 3 image generations. Third must fail with
QUOTA_EXCEEDED. Text generation must fail with MODALITY_NOT_ALLOWED.

***

## Phase 3 — Image Room Type

> **Prerequisite checklist before starting Phase 3:**
> - [ ] Task 6 (archive.ts) committed and OPFS path tested
> - [ ] Task 7 (AdapterYield) merged — adapters updated to new return type
> - [ ] Task 10 (OutputPane migration) rendering both legacy and new outputItems
> - [ ] Task 11 (budget) branching on modality in reserveQuota
>
> If any of these are not done, stop. Phase 3 depends on all four.

***

### Task 12 — Room type in meta Y.Map + enforcement
**File:** `apps/web/src/state/ydoc.ts`
**Time:** 1h (includes both enforcement points)

```typescript
// In RoomMeta interface:
export interface RoomMeta {
  // existing fields...
  roomType:    "text" | "image" | "audio" | "video" | "multimodal";
  roomSubMode: "speech" | "music" | "sfx" | undefined; // audio only
}

// In createRoomDoc — default to "text" for all existing rooms:
meta.set("roomType",    opts.roomType    ?? "text");
meta.set("roomSubMode", opts.roomSubMode ?? undefined);
```

**Enforcement Point 1 — UI layer (apps/web/src/pages/room.ts handleIntent):**
```typescript
// Before generating, check roomType is set and matches modality:
const roomType = doc.meta.get("roomType") as string ?? "text";
if (roomType === "text" && msg.modality !== "text") {
  showError("This is a text room. Create an image or multimodal room to generate images.");
  return;
}
// Lock roomType after first generation:
if (!doc.meta.get("firstGenerationAt")) {
  doc.doc.transact(() => {
    doc.meta.set("firstGenerationAt", Date.now());
    // roomType is now locked — any future attempt to change it is ignored
  });
}
```

**Enforcement Point 2 — Cryptographic layer (apps/worker/src/generate.ts):**
```typescript
// After verifyAndConsumeToken, before reserveQuota:
const allowed = claims.allowedModalities ?? ["text"];
if (!allowed.includes(msg.modality)) {
  return sendError(requestId, {
    code: "MODALITY_NOT_ALLOWED",
    message: `Budget token does not permit ${msg.modality} generation in this room`,
  });
}
```

> **Why two enforcement points?** The UI layer gives instant user
> feedback and prevents unnecessary round-trips to the worker. The
> worker layer is the trust boundary — a malicious client could bypass
> the UI check and post directly to the worker's message bus. The worker
> check cannot be bypassed. Never rely on only the UI check for anything
> that has budget or security implications.

**✅ Verify:** Create a text room. Attempt to POST a `GENERATE` message
with `modality: "image"` directly to the worker (bypassing the UI).
Confirm the worker returns `MODALITY_NOT_ALLOWED`. The UI should also
prevent the attempt before it reaches the worker.

***

### Task 13 — Image ControlPane extras
**File:** `apps/web/src/components/ControlPane.ts`
**Time:** 2h

```typescript
// In mount(), after existing controls — show/hide based on roomType:
const roomType = this.doc.meta.get("roomType") as string ?? "text";

if (roomType === "image" || roomType === "multimodal") {
  this.container.insertAdjacentHTML("beforeend", `
    <div class="ff-image-controls">
      <div class="ff-aspect-ratio">
        <label>Aspect ratio</label>
        <div class="ff-chip-group" role="radiogroup" aria-label="Aspect ratio">
          ${["1:1","16:9","9:16","4:3","3:2"].map(r => `
            <button class="ff-chip ${r === "1:1" ? "active" : ""}"
                    role="radio" aria-checked="${r === "1:1"}"
                    data-value="${r}">${r}</button>
          `).join("")}
        </div>
      </div>
      <div class="ff-style-presets">
        <label>Style</label>
        <div class="ff-chip-group" role="radiogroup" aria-label="Style preset">
          ${["none","photorealistic","illustration","anime","pixel art","concept"].map(s => `
            <button class="ff-chip ${s === "none" ? "active" : ""}"
                    role="radio" aria-checked="${s === "none"}"
                    data-value="${s}">${s}</button>
          `).join("")}
        </div>
      </div>
      <div class="ff-field">
        <label for="ff-negative-prompt">Negative prompt</label>
        <input id="ff-negative-prompt" type="text"
               placeholder="blurry, low quality, watermark…"
               class="ff-input" />
      </div>
      <div class="ff-field">
        <label for="ff-seed">Seed <span class="ff-text-muted">(optional)</span></label>
        <input id="ff-seed" type="number" placeholder="random"
               min="0" max="4294967295" class="ff-input ff-seed-input" />
      </div>
    </div>
  `);

  // Chip group toggle logic
  this.container.querySelectorAll(".ff-chip-group").forEach(group => {
    group.addEventListener("click", e => {
      const btn = (e.target as HTMLElement).closest(".ff-chip") as HTMLButtonElement;
      if (!btn) return;
      group.querySelectorAll(".ff-chip").forEach(c => {
        c.classList.remove("active");
        c.setAttribute("aria-checked", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-checked", "true");
    });
  });
}
```

> **Accessibility note:** Style preset chips and aspect ratio chips use
> `role="radio"` and `aria-checked`. A screen reader user should be able
> to navigate and select presets without a mouse. Test with VoiceOver
> or NVDA before shipping — this is one of the most common a11y failures
> in "chip group" UIs.

**✅ Verify:** Create an image room. Image controls appear. Switch to a
text room — image controls are hidden. Chip selection toggles correctly.
Selected values are accessible to the generate handler via DOM query or
state.

***

### Task 14 — Image OutputPane renderer
**File:** `apps/web/src/components/OutputPane.ts`
**Time:** 3h

```typescript
private renderImageItem(item: Y.Map<string, unknown>): string {
  const urls     = (item.get("imageUrls") as string[] | undefined) ?? [];
  const status   = item.get("status") as string;
  const progress = item.get("progress") as number | undefined;
  const receiptId = item.get("receiptId") as string;

  if (status === "streaming" || status === "pending") {
    const pct = progress ?? 0;
    return `
      <div class="ff-image-loading" data-receipt="${receiptId}">
        <div class="ff-progress-bar">
          <div class="ff-progress-fill" style="width:${pct}%"></div>
        </div>
        <p class="ff-text-muted">Generating… ${pct > 0 ? `${Math.round(pct)}%` : ""}</p>
      </div>`;
  }

  if (status === "error") {
    return `<div class="ff-image-error">Generation failed</div>`;
  }

  // Completed — render grid
  return `
    <div class="ff-image-grid" data-receipt="${receiptId}"
         data-count="${urls.length}">
      ${urls.map((url, i) => `
        <figure class="ff-image-figure">
          <img src="${escapeAttr(url)}" alt="Generated image ${i + 1} of ${urls.length}"
               loading="lazy" width="512" height="512"
               onerror="this.parentElement.classList.add('ff-img-error')" />
          <figcaption class="ff-image-actions">
            <a href="${escapeAttr(url)}" download="ff-${receiptId}-${i}.webp"
               class="ff-btn-ghost" aria-label="Download image ${i + 1}">↓ Download</a>
            <button class="ff-btn-ghost ff-use-as-ref"
                    data-url="${escapeAttr(url)}"
                    data-receipt="${receiptId}"
                    aria-label="Use image ${i + 1} as reference for next generation">
              Use as reference
            </button>
          </figcaption>
        </figure>
      `).join("")}
    </div>`;
}
```

**Archive on completion — call archiveOutput before saving receipt:**
```typescript
// In handleGenerationComplete (wherever generation done is handled in room.ts or ControlPane):
if (modality === "image" && outputUrls.length > 0) {
  const archivedUrls = await Promise.all(
    outputUrls.map(url => archiveOutput(receiptId, url, "image"))
  );
  // Store archivedUrls in receipt — NOT the ephemeral provider URLs
  saveImageReceipt({ ...receipt, outputUrls: archivedUrls });
} else {
  saveImageReceipt({ ...receipt, outputUrls });
}
```

> ⚠️ **Promise.all on archive calls.** If you have 4 images and one
> archive call fails (e.g., here.now rate-limits you), `Promise.all`
> rejects entirely and you lose all 4 URLs. Use `Promise.allSettled`
> instead and archive each URL independently, falling back to OPFS for
> any that fail:
> ```typescript
> const results = await Promise.allSettled(
>   outputUrls.map(url => archiveOutput(receiptId, url, "image"))
> );
> const archivedUrls = results.map((r, i) =>
>   r.status === "fulfilled" ? r.value : outputUrls[i] // keep expiring URL as last resort
> );
> ```

**✅ Verify:** Generate an image. Confirm grid renders with correct count.
Click "Use as reference" — confirm the URL is stored in component state
for next generate call. Click download — confirm a file downloads.
Check the receipt: outputUrls must be `here.now://` or `opfs://` URIs,
never the raw provider URL.

***

### Task 15 — Image receipt schema
**File:** `apps/web/src/state/ydoc.ts` (or `packages/protocol/src/types.ts`)
**Time:** 1h

```typescript
export interface ImageReceipt {
  type:               "image";
  id:                 string;
  roomId:             string;
  createdAt:          number;
  signerPubkey:       string;
  prompt:             string;
  negativePrompt?:    string;
  modelId:            string;
  aspectRatio:        string;
  stylePreset?:       string;
  seed?:              number;
  referenceImageHash?: string;   // SHA-256 of reference — never the image itself
  outputUrls:         string[];  // permanent archived URLs (here.now or opfs://)
  outputCount:        number;
  tokenCost?:         number;    // images consumed from budget
}

// Save to vault on generation complete:
export async function saveImageReceipt(receipt: ImageReceipt): Promise<void> {
  await saveReceipt(receipt); // existing vault function — union type on Receipt
}
```

> **referenceImageHash instead of referenceImageUrl:** Storing the hash
> rather than the image or URL serves two purposes: (1) privacy — the
> reference image may be a user's unpublished work and should not be
> stored anywhere; (2) linkage — if the same reference image is used
> in multiple generations, the hash links them together in the fork
> graph without duplicating any data.

**✅ Verify:** Generate an image, complete the generation. Open the
vault (me page). Confirm an ImageReceipt appears with `type: "image"`,
non-empty `outputUrls` pointing to archived (not provider) URLs, and
correct `modelId` and `aspectRatio` fields.

***

## Phase 4 — MVS Features

***

### Task 16 — here.now uploadBlob upgrade
**File:** `apps/web/src/net/herenow.ts`
**Time:** 2–3h ⚠️

> **Treat this task as an investigation before an implementation.** The
> stub currently triggers a manual CLI script. Before writing a single
> line of upload code, determine:
> 1. What is the here.now upload endpoint URL?
> 2. What auth method does it use (OAuth bearer token, API key header,
>    session cookie)?
> 3. Does it accept multipart/form-data, raw binary, or base64?
> 4. What does the success response look like? (permanent URL format?)
> 5. Is there a file size limit? (video files can be 50MB+)
>
> If you can't answer all 5 in 30 minutes, implement the OPFS path first
> and ship with that. here.now upload becomes a "progressive enhancement"
> in a follow-up PR. The rest of the plan does not block on this task —
> archive.ts's OPFS fallback handles everything.

```typescript
// herenow.ts — upgrade uploadBlobToHereNow from stub:
export async function uploadBlobToHereNow(
  blob: Blob,
  metadata: { receiptId: string; modality: string },
): Promise<string> {
  const token = safeStorage.getItem(KEY_HERENOW_TOKEN);
  if (!token) throw new Error("Not authenticated with here.now");

  // TODO: confirm actual endpoint and auth after investigating API
  const form = new FormData();
  form.append("file",       blob, `${metadata.receiptId}.${extForModality(metadata.modality)}`);
  form.append("receiptId",  metadata.receiptId);
  form.append("modality",   metadata.modality);

  const res = await fetch("https://api.here.now/v1/upload", {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}` },
    body:    form,
  });

  if (res.status === 401) throw new Error("here.now token expired — re-authenticate");
  if (!res.ok) throw new Error(`here.now upload failed: ${res.status}`);

  const data = await res.json() as { url: string };
  return data.url; // permanent URL
}

function extForModality(m: string): string {
  return m === "image" ? "webp" : m === "audio" ? "mp3" : "mp4";
}
```

**✅ Verify:** Authenticate with here.now via the existing OAuth flow.
Upload a real image blob. Confirm the returned URL is accessible from
a different browser without auth (permanent + public). Confirm it's
still accessible after 24h (ephemeral URL test).

***

### Task 17 — One-click publish buttons
**Files:** `ReceiptCard.ts`, room header
**Time:** 1.5h

```typescript
// In ReceiptCard — add publish button alongside fork button:
export function attachPublishAction(
  card: HTMLElement,
  receipt: ImageReceipt | TextReceipt,
): void {
  const btn = document.createElement("button");
  btn.className = "ff-receipt-publish";
  btn.type = "button";
  btn.textContent = "Publish →";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Publishing…";
    try {
      // For image receipts: re-archive if still on OPFS
      if (receipt.type === "image") {
        const urls = await Promise.allSettled(
          receipt.outputUrls.map(async url => {
            if (url.startsWith("opfs://")) {
              const blob = await opfsUrlToBlob(url);
              return uploadBlobToHereNow(blob, { receiptId: receipt.id, modality: "image" });
            }
            return url; // already here.now URL
          })
        );
        // Update receipt with new permanent URLs
        const permanentUrls = urls.map((r, i) =>
          r.status === "fulfilled" ? r.value : receipt.outputUrls[i]);
        await saveReceipt({ ...receipt, outputUrls: permanentUrls });
      }
      // Copy link to clipboard
      const shareUrl = `https://fatedfortress.com/receipt/${receipt.id}`;
      await navigator.clipboard.writeText(shareUrl);
      btn.textContent = "Link copied ✓";
      setTimeout(() => { btn.textContent = "Publish →"; btn.disabled = false; }, 3_000);
    } catch (err) {
      btn.textContent = "Failed — retry";
      btn.disabled = false;
    }
  });
  card.appendChild(btn);
}
```

**✅ Verify:** Generate an image. Click "Publish →". Confirm button shows
"Publishing…" then "Link copied ✓". Paste the URL in an incognito window.
Confirm the receipt page loads and the image is visible without auth.

***

### Task 18 — Room templates
**Files:** `apps/web/src/state/ydoc.ts` (templates Y.Array), room creation UI
**Time:** 2h

```typescript
export interface RoomTemplate {
  id:             string;
  name:           string;
  roomType:       RoomType;
  systemPrompt?:  string;
  defaultModel:   string;
  defaultTemp?:   number;
  stylePresets?:  string[];
  aspectRatio?:   string;
  createdBy:      string;  // pubkey
  createdAt:      number;
  isPublic:       boolean;
}

// Save template (host only):
export function saveRoomTemplate(doc: FortressRoomDoc, template: RoomTemplate): void {
  const templates = doc.doc.getArray("templates");
  doc.doc.transact(() => { templates.push([template]); });
}

// In the lobby table page — seed public templates if templates array is empty:
const SEEDED_TEMPLATES: RoomTemplate[] = [
  {
    id: "tmpl-writing",
    name: "Writing Studio",
    roomType: "text",
    systemPrompt: "You are a skilled creative writing collaborator. ...",
    defaultModel: "gpt-4o",
    isPublic: true,
    createdBy: "ff-platform",
    createdAt: 0,
  },
  {
    id: "tmpl-concept-art",
    name: "Concept Art Brief",
    roomType: "image",
    defaultModel: "dall-e-3",
    aspectRatio: "16:9",
    stylePreset: "concept",
    isPublic: true,
    createdBy: "ff-platform",
    createdAt: 0,
  },
];
```

**✅ Verify:** Open the lobby. "Start from template" chips appear.
Click "Concept Art Brief" — a new image room opens with the correct
model, aspect ratio, and style preset pre-filled. Save a custom template
from inside a room — confirm it appears in the lobby for the creating user.

***

### Task 19 — Fork tree visualization
**File:** `apps/web/src/pages/me.ts` (new "Receipt Map" tab)
**Time:** 2h

```typescript
// Build the DAG from flat receipt list:
function buildReceiptGraph(receipts: Receipt[]): {
  nodes: Receipt[];
  edges: Array<{ from: string; to: string }>;
} {
  const edges: Array<{ from: string; to: string }> = [];
  const byId = new Map(receipts.map(r => [r.id, r]));

  receipts.forEach(r => {
    if ("forkOf" in r && r.forkOf && byId.has(r.forkOf)) {
      edges.push({ from: r.forkOf, to: r.id });
    }
  });

  return { nodes: receipts, edges };
}

// Simple tree renderer — CSS grid, no external dep for MVS:
function renderReceiptTree(graph: ReturnType<typeof buildReceiptGraph>): string {
  // Build depth map (BFS from roots)
  const depth = new Map<string, number>();
  const children = new Map<string, string[]>();
  graph.edges.forEach(e => {
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
  });
  const roots = graph.nodes
    .filter(n => !graph.edges.find(e => e.to === n.id))
    .map(n => n.id);

  const queue = roots.map(r => ({ id: r, d: 0 }));
  while (queue.length) {
    const { id, d } = queue.shift()!;
    depth.set(id, d);
    (children.get(id) ?? []).forEach(c => queue.push({ id: c, d: d + 1 }));
  }

  return graph.nodes
    .sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0))
    .map(r => `
      <div class="ff-tree-node" style="--depth:${depth.get(r.id) ?? 0}"
           data-id="${r.id}"
           role="button" tabindex="0"
           aria-label="Receipt ${r.id.slice(0, 8)} — click to fork"
           onclick="window.location.hash='#/room?seed=${r.id}'">
        ${r.type === "image"
          ? `<img src="${(r as ImageReceipt).outputUrls[0]