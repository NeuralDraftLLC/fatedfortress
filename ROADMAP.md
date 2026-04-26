# Fated Fortress — Roadmap

> Tracked incomplete features, known gaps, and planned work.
> Add items here before opening an issue so context isn't lost.

---

## 🔴 Critical / Front-Facing Gaps

_Nothing here — all critical gaps resolved._

---

## 🟡 Planned / Backlog

_Nothing here._

---

## ✅ Shipped

### [REVIEW-COLLAB-001] Live Collaborative Code Review Screen — 2026-04-25

**Screen:** `apps/web/src/pages/reviews.ts` → center column (`crucible__preview`)

All 4 steps complete and merged to `main`.

**What shipped:**
- [x] Deps installed: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/lang-javascript`, `y-codemirror.next` in `apps/web/package.json`
- [x] Y.js transport wired in `mountReviews()` — `createRoomDoc()` + `WebrtcProvider(reviewSessionId, room.doc, { signaling: [RELAY_URL] })` per item select; `clearActiveRoomDoc()` + `provider.destroy()` on deselect and page teardown
- [x] CodeMirror 6 editor bound to `room.output` (`Y.Text`) via `yCollab` — edits by one reviewer appear for all; seeded from asset URL on first load; destroyed in teardown
- [x] Live cursors: `upsertPresence()` on every CM6 `selectionSet`; `observePresence()` re-renders colored cursor overlays; `removePresence()` on teardown
- [x] Peer avatar chips in decision panel header via `observePresence()` — updates as reviewers join/leave

**Acceptance criteria (all met):**
- [x] Two reviewers on the same `review_session` see each other's edits in real time
- [x] Live cursors with colored overlays visible for all connected peers
- [x] Peer avatar list updates as reviewers join / leave
- [x] Full teardown: no Y.Doc leaks, no dangling WebRTC connections on page nav

### [README-STATUS-001] README Status Table — Y.js Live Review Updated — 2026-04-25

Status row updated to `Complete — real-time editor, live cursors, presence avatars`.
