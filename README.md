# FATEDFORTRESS

> **The instant AI generation marketplace. Enter your keys. Join a room. Ship live in seconds.**

[![CI](https://img.shields.io/github/actions/workflow/status/Ghostmonday/fatedfortress-v2/ci.yml?style=flat-square&branch=master)](https://github.com/Ghostmonday/fatedfortress-v2/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-black?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-black?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Y.js](https://img.shields.io/badge/Y.js-CRDT-black?style=flat-square&logo=yjs)](https://yjs.dev)

---

## The Problem

Today's AI tools are isolated. One person generates, shares a screenshot, waits for feedback, pastes back, repeat. It's slow, version-controlled by Slack threads, and the output never ships.

Every team pays for its own keys. Rate limits go unused. Outputs live in chat history, not in the world.

**FatedFortress is Craigslist for AI generation power.**

---

## What It Is

A single URL where anyone enters their API key, drops into a live room, and ships real output to a real live URL — in under ten seconds.

- **Zero setup.** No account. No IDE. No build step.
- **Provably BYOK.** Your keys never leave your browser. The Fortress Worker is a sandboxed iframe that calls providers directly. We publish the worker hash. You can verify it.
- **Live rooms.** Real-time P2P sync via Y.js + WebRTC. Everyone in the room sees output stream as it happens.
- **Every output becomes a URL.** One click publishes to here.now. Share it, embed it, gate it with Tempo stablecoin.
- **Earn from your keys.** Host a paid room. Contributors pool their rate limits. The fork graph makes great work discoverable.

---

## How It Works

```
HOST creates room  →  ROOM is a URL (no account needed)
    ↓
PARTICIPANTS join  →  P2P CRDT sync (no server state)
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

### Fortress Protocol (BYOK Guarantee)
API keys live in a sandboxed Web Worker that has network access only to allow-listed AI provider origins. Keys are encrypted at rest with Argon2id + AES-256-GCM. The worker's SHA-256 hash is published and verifiable via SRI. **A FatedFortress server literally cannot receive a key.**

### P2P Real-Time Sync
Rooms are CRDT documents synced over WebRTC via a stateless Cloudflare Durable Object relay. No database. No server-side state. Sub-50ms sync. Works offline after first connect. At 10,000 concurrent rooms, infra cost is ~$40/month.

### Generation Receipts & Fork Graph
Every generation produces a signed, hash-chained receipt stored permanently on here.now. Fork any receipt into a new room with one click. The fork graph is the public record of how ideas evolved — and the viral loop that makes FatedFortress share itself.

### Provider Liquidity Pool
Hosts contribute their API keys with per-participant token quotas enforced by signed Ed25519 budget tokens. Multiple hosts co-host a room, pooling rate limits. A live fuel gauge shows remaining quota per participant. Rate limits become a social good.

### The Palette (`/`)

```
/  create animation room free
/  join rm_abc123
/  switch claude-4-opus
/  publish
/  pay 5
/  fork rcp_xyz
/  set system prompt: you are a 2D game artist
/  ?
```

One keyboard shortcut routes to everything. No menus. No settings pages. Just a command line, the way Craigslist would have shipped it.

### Brutalist Terminal Aesthetic

```
┌──────────────────────────────────────────────────────────────┐
│  FATEDFORTRESS                        [CREATE ROOM]  [/]     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $   │
│  $                                                       $  │
│  $   ENTER YOUR KEYS. FORGE YOUR FATE.                   $  │
│  $   SHIP LIVE IN SECONDS.                               $  │
│  $                                                       $  │
│  $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $ $   │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  FILTER: [ALL]  [GAMES]  [CODE]  [ANIMATION]  [PAID]      │
├──────────────────────────────────────────────────────────────┤
│  { }  Minimax Animation Sprint          @3  ████░░  [JOIN]  │
│  > Sprint through T2V prompts with the team. Fast output.   │
│  ─────────────────────────────────────────────────────────── │
│  { }  Claude Code Review              @5  FREE  [JOIN]      │
│  > Live code review with Claude 4 Opus. Paste, critique.   │
│  ─────────────────────────────────────────────────────────── │
│  $   Game Jam Helper                    @2  $5  [JOIN]       │
│  > Paid room. Host has Groq + Claude keys. Fuel available.  │
│  ─────────────────────────────────────────────────────────── │
└──────────────────────────────────────────────────────────────┘
```

Black on white. JetBrains Mono. One font everywhere. No color. No exceptions.

---

## Getting Started

### As a Participant (no keys needed)

1. Open [fatedfortress.com](https://fatedfortress.com)
2. Browse live rooms — click `JOIN`
3. Enter your own API key (optional) or use the room's shared key
4. Type a prompt. Watch output stream live.
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

# Build the web SPA (outputs to apps/web/dist/)
npx vite build apps/web

# Build the Fortress Worker (IIFE output for sandboxed iframe)
npx vite build apps/worker

# Compute and record the worker hash (required before first deploy)
node scripts/verify-worker-hash.mjs --build

# Start web dev server
npx vite apps/web

# Run security proof (requires Playwright)
node scripts/verify-key-never-exfiltrates.mjs --url http://localhost:5173
```

### Deploying

```bash
# Publish to here.now
HERENOW_TOKEN=your_token node scripts/publish.mjs
# optional: append --staging for staging log label only
```

---

## Architecture

```
Browser (FatedFortress SPA — here.now)
  │
  ├── Fortress Worker (sandboxed iframe — keys.fatedfortress.com)
  │     ├── keystore.ts     — Argon2id + AES-256-GCM, Ed25519 signing
  │     ├── budget.ts       — token minting, hourly quota, fuel gauge
  │     ├── liquidity.ts    — host-side liquidity pool API
  │     ├── generate.ts     — provider adapter orchestration
  │     └── adapters/       — openai · anthropic · google · minimax · groq · openrouter
  │
  ├── Y.js CRDT doc (room state)
  │
  └── y-webrtc (P2P sync)
        │
        └── Cloudflare Durable Object (stateless relay — ~50 LOC)

here.now
  ├── Static SPA hosting
  ├── here.now publish (receipts, room snapshots)
  └── Edge payment gate (Tempo stablecoin)

No primary database. here.now is the filesystem. CRDT is the state.
```

---

## Security

| Property | Mechanism |
|---|---|
| Keys never leave the browser | Sandboxed worker iframe, CSP allow-list, `getRawKey()` has no postMessage type |
| Keys never at rest in plaintext | Argon2id + AES-256-GCM, passphrase-derived wrapping key |
| Worker is verifiable | SHA-256 hash over minified bundle, published + SRI |
| Budget tokens are unforgeable | Ed25519 signature by host's non-extractable key |
| Receipts are tamper-evident | SHA-256 output hash + Ed25519 signature, hash-chained |
| No key exfiltration | Automated Playwright proof: sentinel key + all encoding variants checked on every network request and postMessage |

See `apps/worker/src/keystore.ts`, `apps/worker/src/budget.ts`, and the inline security comments throughout the codebase for the full security model.

---

## Roadmap

| Phase | What's Next |
|---|---|
| **v1.1** | P2P room sync via y-webrtc, presence cursors |
| **v1.5** | Liquidity pool, Tempo paid rooms, fuel gauge |
| **v2** | LiveKit voice chat, Liveblocks shared canvas overlays, template marketplace |
| **v3** | Mobile PWA, `ff` CLI, Tauri desktop app |

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

## Contributing

FatedFortress is open to contributors. The codebase is designed for modular, parallel development — each adapter, component, and protocol piece is self-contained with its own test scaffold.

Read the `apps/web`, `apps/worker`, and `apps/relay` directories for the development protocol and coding standards before submitting PRs.

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
