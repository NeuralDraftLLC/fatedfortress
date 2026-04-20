# FATEDFORTRESS

> **The instant AI generation marketplace. Enter your keys. Join a room. Ship live in seconds.**

[![CI](https://img.shields.io/github/actions/workflow/status/Ghostmonday/fatedfortress-v2/ci.yml?style=flat-square&branch=main)](https://github.com/Ghostmonday/fatedfortress-v2/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-black?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-black?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Y.js](https://img.shields.io/badge/Y.js-CRDT-black?style=flat-square&logo=yjs)](https://yjs.dev)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-black?style=flat-square&logo=cloudflare)](https://workers.cloudflare.com/)

---

## The Problem

Today's AI tools are isolated. One person generates, shares a screenshot, waits for feedback, pastes back, repeat. It's slow, version-controlled by Slack threads, and the output never ships.

Every team pays for its own keys. Rate limits go unused. Outputs live in chat history, not in the world.

**FatedFortress is Craigslist for AI generation power.**

---

## What It Is

A single URL where anyone enters their API key, drops into a live room, and ships real output to a real live URL — in under ten seconds.

- **Zero setup.** No account. No IDE. No build step.
- **Provably BYOK.** Your keys never leave your browser. The Fortress Worker is a sandboxed iframe that calls providers directly. Keys are encrypted at rest. The worker hash is published and verifiable.
- **Live rooms.** Real-time CRDT sync via Y.js + WebRTC through a Cloudflare Durable Object relay. Everyone in the room watches output stream as it happens.
- **Spectate mode.** Watch any public room instantly — no key needed, no signaling traffic burned, no payment required.
- **Every output becomes a URL.** One click publishes to here.now. Share it, embed it, gate it with Tempo stablecoin.
- **Earn from your keys.** Host a paid room. Contributors pool their rate limits. The fork graph makes great work discoverable.

---

## How It Works

```
HOST creates room  →  ROOM is a URL (no account needed)
    ↓
PARTICIPANTS join (or spectate)  →  P2P CRDT sync (no server state)
    ↓
KEYS validated in sandboxed Fortress Worker  →  provably never exfiltrated
    ↓
GROUP prompts together  →  output streams to all peers in real-time
    ↓
ONE CLICK  →  here.now  →  LIVE URL
    ↓
SHARE  →  fork graph grows  →  network effect compounds
    ↓
PAID ROOM?  →  Tempo stablecoin  →  80% to host, 20% to FF
```

---

## Key Features

### Command Palette (`/`)

A trie-accelerated command palette with ghost text completion. Type `/sp` and Tab accepts the longest common prefix — no mouse, no menus.

```
/  create animation room free
/  join rm_abc123
/  spectate rm_abc123
/  switch claude-4-opus
/  publish
/  pay 5
/  fork rcp_xyz
/  set system prompt: you are a 2D game artist
/  delegate @alice 2000
/  ?
```

Ghost text previews the full command before you commit. Trie is rebuilt on every open with context-aware vocabulary — room-scoped commands (`spectate`, `join`, `publish`) only appear when you're actually in a room.

### P2P Real-Time Sync

Rooms are Y.js CRDT documents. Changes merge deterministically regardless of network reordering or concurrent edits. The relay is a thin Cloudflare Durable Object fan-out layer — it never holds room state. At 80+ peers, it automatically shards to up to 8 Durable Objects, routing messages between them via an O(1) peer-to-shard map.

- **OPFS caching** — room state is snapshotted to the Origin Private File System every 30 seconds and on disconnect. Reconnecting to a room restores the last state instantly, even if the relay hasn't synced yet.
- **Spectator mode** — `?spectator=1` tells the relay to skip WebRTC signaling fan-out entirely. Spectators receive CRDT sync updates but never initiate peer connections, burning zero budget.
- **Sub-50ms sync** — no database round-trip, no server-side state to maintain.

### Fortress Protocol (BYOK Guarantee)

API keys live in a sandboxed Web Worker iframe with network access allow-listed per provider. Keys are encrypted at rest with Argon2id + AES-256-GCM. The worker's SHA-256 hash is recorded at build time and verifiable via SRI. **A FatedFortress server literally cannot receive a key.**

```
Browser (SPA)
  ├── Fortress Worker iframe (keys.fatedfortress.com)
  │     ├── keystore.ts    — Argon2id + AES-256-GCM, Ed25519 signing
  │     ├── budget.ts      — SubBudgetToken minting, per-participant quota, fuel gauge
  │     ├── liquidity.ts   — host-side liquidity pool API
  │     ├── generate.ts    — adapter orchestration + stream cache
  │     └── adapters/      — openai · anthropic · google · minimax · groq · openrouter
  │
  ├── Y.js CRDT doc (room state)
  │
  └── Cloudflare Durable Object relay (stateless fan-out + sharding)
        ├── Parent DO (room-scoped) — peer registry, signaling, shard routing
        └── Shard DOs (overflow, up to 8) — isolated peer maps, cross-shard forward
```

### Provider Liquidity Pool

Hosts contribute their API keys with per-participant token quotas enforced by signed Ed25519 SubBudgetTokens. Multiple hosts co-host a room, pooling rate limits. A live fuel gauge shows remaining quota per participant. **Rate limits become a social good.**

### Generation Receipts & Fork Graph

Every generation produces a signed, hash-chained receipt stored permanently on here.now. Fork any receipt into a new room with one click. The fork graph is the public record of how ideas evolved — and the viral loop that makes FatedFortress share itself.

### Brutalist Terminal Aesthetic

```
┌──────────────────────────────────────────────────────────────┐
│  FATEDFORTRESS                        [CREATE ROOM]  [/]     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $   │
│  $                                                       $  │
│  $   ENTER YOUR KEYS. FORGE YOUR FATE.                   $  │
│  $   SHIP LIVE IN SECONDS.                               $  │
│  $                                                       $  │
│  $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $   │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  [ALL]  [GAMES]  [CODE]  [ANIMATION]  [WRITING]  [PAID]   │
├──────────────────────────────────────────────────────────────┤
│  { }  Minimax Animation Sprint        @3  ████░░  [JOIN]    │
│  > Sprint through T2V prompts with the team. Fast output.     │
│  ─────────────────────────────────────────────────────────   │
│  { }  Claude Code Review              @5  FREE  [SPECTATE]   │
│  > Live code review with Claude 4 Opus. Paste, critique.     │
│  ─────────────────────────────────────────────────────────   │
│  $   Game Jam Helper                  @2  $5  [JOIN]         │
│  > Paid room. Host has Groq + Claude keys. Fuel available. │
└──────────────────────────────────────────────────────────────┘
```

Black on white. Geist Mono. One font everywhere. No color. No exceptions.

---

## Getting Started

### As a Participant (no keys needed)

1. Open [fatedfortress.com](https://fatedfortress.com)
2. Click `SPECTATE` on any public room
3. Watch output stream live — no account, no key, no cost
4. To generate: enter your own API key (optional)
5. Click `PUBLISH >>>` — get a permanent URL

### As a Host

1. Press `/` to open the Palette
2. Type `create [category] room [free|paid $5]`
3. Share the room URL
4. Optionally contribute your key to the liquidity pool

### Running Locally

```bash
# Clone
git clone https://github.com/Ghostmonday/fatedfortress-v2.git
cd fatedfortress-v2

# Install dependencies
npm install

# Build the web SPA (outputs to apps/web/dist/)
npm run build --workspace=apps/web

# Start web dev server
npm run dev --workspace=apps/web
# → http://localhost:5173

# Deploy the relay worker (Cloudflare Wrangler)
cd apps/relay && wrangler deploy
```

### Environment Variables

```bash
# apps/web/.env.development
VITE_RELAY_ORIGIN=ws://localhost:8787
VITE_WORKER_ORIGIN=http://localhost:8788
VITE_FF_ORIGIN=http://localhost:5173
VITE_HERENOW_CLIENT_ID=your_client_id
VITE_PLATFORM_WALLET=your_wallet_address

# apps/web/.env.production
VITE_RELAY_ORIGIN=wss://relay.fatedfortress.com
VITE_WORKER_ORIGIN=https://keys.fatedfortress.com
VITE_FF_ORIGIN=https://fatedfortress.com
```

---

## Architecture

### Relay DO Sharding

The Durable Object is room-scoped (`env.RELAY.idFromName(roomId)`). When the parent DO exceeds 80 connected peers, new connections receive a `{ type: "REDIRECT", shardUrl }` message and reconnect to a shard DO (`roomId-shard-0` through `roomId-shard-7`). Shards notify the parent of their peer registry via `POST /internal/register-shard-peer`, enabling O(1) cross-shard message routing via `POST /_relay/forward`. Maximum room capacity: ~80 × 9 = 720 peers.

### Y.js Document Schema

```
FortressRoomDoc
  ├── meta:          Y.Map        — room metadata, access, price, system prompt
  ├── participants:  Y.Map        — keyed by pubkey (Phase 5 L12 migration from Y.Array)
  ├── output:        Y.Text       — character-level streaming output
  ├── receiptIds:    Y.Array      — hash-chained receipt IDs
  ├── templates:     Y.Array      — saved prompt templates
  ├── presence:      Y.Map        — peer cursor + online state
  └── spectatorChat: Y.Array      — spectator chat messages
```

Participants moved from `Y.Array` to `Y.Map<pubkey, ParticipantEntry>` in Phase 5 — eliminating the CRDT delete/insert race condition under concurrent `updateParticipant` calls.

### Stream Cache (Mid-Session Resume)

On host drop mid-generation, the `handoff.ts` stream cache captures chunks as they arrive. The cache key is `SHA-256(model | systemPrompt | prompt)`. If the host rejoins within 10 minutes, the accumulated text is prepended to the generation input with a `--- resume ---` separator, so the new host continues from where the stream was cut.

---

## Security

| Property | Mechanism |
|---|---|
| Keys never leave the browser | Sandboxed worker iframe, CSP allow-list per provider origin, `getRawKey()` has no `postMessage` export |
| Keys never at rest in plaintext | Argon2id + AES-256-GCM, passphrase-derived wrapping key |
| Worker is verifiable | SHA-256 hash over minified bundle, recorded at build time + SRI |
| Budget tokens are unforgeable | Ed25519 signature by host's non-extractable key |
| Receipts are tamper-evident | SHA-256 output hash + Ed25519 signature, hash-chained |
| Participant updates are CRDT-safe | `Y.Map` keyed by pubkey — no delete/insert races |
| No localStorage crashes in embeds | `safeStorage` wrapper probes once; falls back to in-memory Map |
| No base64 stack overflow on large docs | Chunked encoding/decoding in 8,192-byte blocks |

---

## Supported Providers

| Provider | Streaming | Models |
|---|---|---|
| OpenAI | Yes | GPT-4o, o3, o4-mini |
| Anthropic | Yes | Claude 4 Sonnet, Opus, Haiku |
| Google | Yes | Gemini 2.0 Flash, Pro |
| Minimax | Yes | abab, MX-T2V, SDXL |
| Groq | Yes | Llama 3.3, Mixtral |
| OpenRouter | Yes | 100+ models |

---

## Roadmap

| Version | What's Next |
|---|---|
| **v1.1** | ✅ Shipped — P2P sync, presence cursors, liquidity pool, fuel gauge, spectate mode |
| **v1.5** | ✅ Shipped — Y.Map participants, OPFS caching, command trie ghost text, stream resume |
| **v2** | here.now native integration, LiveKit voice, shared canvas overlays, template marketplace |
| **v3** | Mobile PWA, `ff` CLI, Tauri desktop app |

---

## Contributing

The codebase is designed for modular, parallel development. Each adapter, component, and protocol piece is self-contained.

```
apps/
  web/       — Vite + React SPA (here.now hosted)
  worker/     — Sandboxed iframe (keys.* origin)
  relay/      — Cloudflare Durable Object (stateless fan-out + sharding)
packages/
  protocol/   — Shared types, crypto helpers, budget token schemas
```

Read the inline comments in `ydoc.ts`, `budget.ts`, and `relay/src/index.ts` for the full data model and protocol invariants before submitting PRs.

---

## The Thesis

Craigslist won because a person with something and a person who needed it could meet in ten seconds. No account. No algorithm. No fluff.

FatedFortress does the same for AI generation.

More rooms → more people joining → better output → more value → more rooms. At scale, this becomes unkillable — because every generation is a permanent URL, every URL is a shareable artifact, and every artifact is a potential fork that deposits a new user right back into the network.

**The output always goes somewhere real. The room always lives at a URL. The keys never leave your browser.**

---

<p align="center">
  <strong>FATEDFORTRESS</strong> · Built for the people who build the future.
</p>
