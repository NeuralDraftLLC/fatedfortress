# Fated Fortress — Roadmap

> Tracked incomplete features, known gaps, and planned work.
> Add items here before opening an issue so context isn't lost.

---

## 🔴 Critical / Front-Facing Gaps

### [REVIEW-COLLAB-001] Live Collaborative Code Review Screen — Real-Time Editor & Cursors Missing

**Screen:** `apps/web/src/pages/reviews.ts` → center column (`crucible__preview`)

**Status:** In progress — building now

**What exists today:**
- `ydoc.ts` ships a complete `FortressRoomDoc` schema with `Y.Text output`, `Y.Map presence`, and `PresenceEntry.cursorOffset` — the CRDT primitives are fully defined.
- `reviews.ts` loads `review_session` data from Supabase and renders the asset preview pane.
- The Supabase realtime channel on `tasks UPDATE` and `submissions INSERT` is wired.
- The `observePresence` / `observeOutput` teardown helpers exist and are ready to use.
- `y-webrtc@10.3.0` is already installed in `apps/web/package.json`.
- The relay Cloudflare Worker (`apps/relay/src/index.ts`) is already deployed.

**What is missing (user-visible):**
1. **No editor mounted in the preview pane for `code` / `text` deliverables.** `renderPreview()` renders a static `<pre>` populated via a one-shot `fetch()`. No CodeMirror 6 instance bound to `room.output` (`Y.Text`).
2. **No Y.js transport attached to the `review_session` doc.** `createRoomDoc()` is never called inside `mountReviews()`. No `y-webrtc` provider is instantiated — peers cannot sync.
3. **No live cursors rendered.** `PresenceEntry.cursorOffset` is defined but nothing calls `upsertPresence()` on selection change or renders remote cursor overlays from `observePresence()`.
4. **No presence avatars / peer list.** Decision panel shows static contributor info from Supabase only.

**Build plan (sequential):**

#### Step 1 — Install missing deps (unblocks everything else)
```
cd apps/web
npm install @codemirror/state @codemirror/view @codemirror/language @codemirror/lang-javascript y-codemirror.next
```
- [ ] Deps installed and committed to `apps/web/package.json` + `package-lock.json`

#### Step 2 — Wire Y.js transport in `mountReviews()`
- [ ] On item select: call `createRoomDoc()`, `setActiveRoomDoc()`, init `WebrtcProvider(reviewSessionId, room.doc)` pointing at relay URL
- [ ] Call `clearActiveRoomDoc()` + `provider.destroy()` in page teardown AND on item deselect
- [ ] Verify two browser tabs connect and sync via DevTools

#### Step 3 — Mount CodeMirror 6 editor bound to `room.output`
- [ ] Replace static `<pre>` in `renderPreview()` for `code`/`text` deliverables with a CodeMirror 6 editor
- [ ] Bind editor to `room.output` (`Y.Text`) via `y-codemirror.next` — edits by one reviewer appear for all
- [ ] Seed editor content from the fetched asset URL on first load
- [ ] Destroy editor in teardown

#### Step 4 — Live cursors + presence avatars
- [ ] Write local cursor position to `room.presence` via `upsertPresence()` on every CM6 selection change
- [ ] Call `observePresence()` to receive remote presence updates; render colored cursor overlays in the editor
- [ ] Render peer avatar chips in the decision panel header showing who is live in the session
- [ ] Call `removePresence()` on teardown

**Acceptance criteria (feature complete when all steps done):**
- [ ] Two reviewers on the same `review_session` see each other's edits in real time
- [ ] Live cursors with colored overlays visible for all connected peers
- [ ] Peer avatar list updates as reviewers join / leave
- [ ] Full teardown: no Y.Doc leaks, no dangling WebRTC connections on page nav

**References:**
- `apps/web/src/state/ydoc.ts` — CRDT schema, observe helpers, teardown contract
- `apps/web/src/pages/reviews.ts` — current static preview (Step 3 target)
- `apps/relay/src/index.ts` — Cloudflare Worker signaling relay (already deployed)
- Y.js docs: https://docs.yjs.dev
- y-codemirror.next: https://github.com/yjs/y-codemirror.next
- y-webrtc: https://github.com/yjs/y-webrtc

---

## 🟡 Planned / Backlog

### [README-STATUS-001] README Status Table — Y.js Live Review Marked "Scaffolded"

**File:** `README.md` → Status table, row: `Y.js live review`

**Status:** Accurate but needs updating as REVIEW-COLLAB-001 ships

**What it says today:**
> `Y.js live review | Scaffolded — state/ydoc.ts + relay/index.ts wired`

**Why it matters:**
The status table is the first place contributors and evaluators check feature completeness.
Once REVIEW-COLLAB-001 Step 2 lands, this row should update to `Partial — transport wired, editor pending`.
Once all 4 steps land, update to `Complete`.

**Action:**
- [ ] After Step 2 ships: update to `Partial — transport wired, editor pending`
- [ ] After Step 4 ships: update to `Complete — real-time editor, live cursors, presence avatars`

---

## ✅ Shipped

_Move completed items here with the date and PR reference._
