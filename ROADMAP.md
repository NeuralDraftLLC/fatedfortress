# Fated Fortress — Roadmap

> Tracked incomplete features, known gaps, and planned work.
> Add items here before opening an issue so context isn't lost.

---

## 🔴 Critical / Front-Facing Gaps

### [REVIEW-COLLAB-001] Live Collaborative Code Review Screen — Real-Time Editor & Cursors Missing

**Screen:** `apps/web/src/pages/reviews.ts` → center column (`crucible__preview`)

**Status:** Partially implemented — blocked

**What exists today:**
- `ydoc.ts` ships a complete `FortressRoomDoc` schema with `Y.Text output`, `Y.Map presence`, and `PresenceEntry.cursorOffset` — the CRDT primitives are fully defined.
- `reviews.ts` loads `review_session` data from Supabase and renders the asset preview pane.
- The Supabase realtime channel on `tasks UPDATE` and `submissions INSERT` is wired.
- The `observePresence` / `observeOutput` teardown helpers exist and are ready to use.

**What is missing (user-visible):**
1. **No editor mounted in the preview pane for `code` / `text` deliverables.** `renderPreview()` renders a static `<pre>` populated via a one-shot `fetch()`. There is no CodeMirror (or equivalent) editor instance bound to `room.output` (`Y.Text`). Edits by one reviewer are never broadcast to co-reviewers.
2. **No Y.js transport attached to the `review_session` doc.** `createRoomDoc()` is never called inside `mountReviews()`. `setActiveRoomDoc()` / `clearActiveRoomDoc()` are not called; the teardown contract is violated. No `y-webrtc` or relay provider is instantiated — peers cannot sync state.
3. **No live cursors rendered.** `PresenceEntry.cursorOffset` is defined and typesafe, but nothing in `reviews.ts` calls `upsertPresence()` on local selection change or renders remote cursor overlays from `observePresence()`.
4. **No presence avatars / connection status.** The right decision panel shows contributor info from Supabase but no live peer list from `room.presence`.

**Acceptance criteria (done when):**
- [ ] `mountReviews()` calls `createRoomDoc()` for the selected `review_session`, calls `setActiveRoomDoc()`, and calls `clearActiveRoomDoc()` in its teardown `() => void`.
- [ ] A CodeMirror 6 (or Monaco) editor is mounted in `#preview-body` for `code`/`text` deliverables and bound to `room.output` via `y-codemirror6` (or equivalent Y.js binding).
- [ ] A WebRTC or relay provider (`y-webrtc` / `y-websocket`) is initialized with the `review_session` ID as the room name.
- [ ] Local cursor position is written to `room.presence` via `upsertPresence()` on every selection change.
- [ ] Remote cursors are rendered as colored overlays in the editor using `observePresence()`.
- [ ] Peer avatars / presence chips are shown in the review panel header.
- [ ] `clearActiveRoomDoc()` is called in the page teardown function.

**References:**
- `apps/web/src/state/ydoc.ts` — CRDT schema, observe helpers, teardown contract
- `apps/web/src/pages/reviews.ts` — current static preview implementation
- Y.js docs: https://docs.yjs.dev
- y-codemirror6: https://github.com/yjs/y-codemirror.next

---

## 🟡 Planned / Backlog

_Nothing else tracked yet. Add items above this line._

---

## ✅ Shipped

_Move completed items here with the date and PR reference._
