%%{init: {"theme": "dark", "fontFamily": "Geist Mono, monospace", "fontSize": 12}}%%
graph TD
    %% ============================================================
    %% STYLE DEFINITIONS
    %% ============================================================
    classDef page      fill:#171717,stroke:#fafafa,stroke-width:2px,color:#fafafa
    classDef comp      fill:#0a0a0a,stroke:#525252,stroke-width:1px,color:#d4d4d4
    classDef handler   fill:#1b2a49,stroke:#ffd166,stroke-width:1px,color:#ffd166
    classDef db        fill:#0d1b2a,stroke:#2a9d8f,stroke-width:2px,color:#2a9d8f
    classDef edgefn    fill:#0d1b2a,stroke:#e9c46a,stroke-width:1px,color:#ffd166
    classDef worker    fill:#1a1a2e,stroke:#a78bfa,stroke-width:1px,color:#a78bfa
    classDef ext       fill:#000000,stroke:#737373,stroke-width:1px,color:#737373
    classDef state     fill:#1a1a2e,stroke:#a78bfa,stroke-width:1px,color:#a78bfa
    classDef zone      fill:#0d1b2a,stroke:#ef476f,stroke-width:2px,color:#ef476f
    classDef rpc       fill:#1b2a49,stroke:#06d6a0,stroke-width:1px,color:#06d6a0

    %% ============================================================
    %% ZONE 1: SPA (apps/web)
    %% ============================================================
    subgraph SPA ["🌐 Zone 1: Main Thread (apps/web)"]
        subgraph Pages ["📄 Page Views"]
            login_p["/login<br/>Supabase Auth"]:::page
            create_p["/create<br/>Forge Project"]:::page
            tasks_p["/tasks<br/>Marketplace"]:::page
            submit_p["/submit/:taskId<br/>Verify Flow"]:::page
            reviews_p["/reviews<br/>Host Queue"]:::page
            project_p["/project/:id<br/>Wallet & Feed"]:::page
            profile_p["/profile<br/>Reliability"]:::page
            settings_p["/settings<br/>Onboarding"]:::page
        end

        subgraph Components ["🧩 UI Components"]
            PV_Wallet["WalletGauge<br/>(Stripe Balances)"]:::comp
            RV_Diff["SideBySide<br/>(AI vs Asset)"]:::comp
            RV_Decide["DecisionModal<br/>(Feedback)"]:::comp
        end

        subgraph Handlers ["⚡ Client Handlers"]
            payout_h["handlers/payout.ts<br/>Verdict Logic"]:::handler
            scope_h["handlers/scope.ts<br/>Task Generator"]:::handler
        end

        subgraph State ["📦 Client State"]
            identity_s["state/identity.ts<br/>IndexedDB Keys"]:::state
            ydoc_s["state/ydoc.ts<br/>Y.js Sessions"]:::state
            handoff_s["state/handoff.ts<br/>Stream Cache"]:::state
            worker_bridge["net/worker-bridge.ts<br/>(Inert Stub)"]:::worker
        end
    end

    %% ============================================================
    %% OPTIONAL ZONES
    %% ============================================================
    subgraph VaultZone ["🔒 Zone 2: Secure Sandbox (Optional)"]
        W_Keys["apps/worker/src/keystore.ts<br/>(Vault)"]:::zone
    end

    subgraph EdgeZone ["⚡ Zone 3: Cloudflare Edge (Optional)"]
        RelayDO["apps/relay/src/index.ts<br/>(WebRTC Hub + TURN)"]:::edgefn
    end

    %% ============================================================
    %% PERSISTENCE (Supabase)
    %% ============================================================
    subgraph Supabase ["🗄️ Supabase Persistence Layer"]
        subgraph Schema ["Schema — Sacred Objects"]
            projects[(projects<br/>Blueprint Metadata)]:::db
            wallet[(project_wallet<br/>Atomic RPCs<br/>deposited/locked/released)]:::db
            tasks[(tasks<br/>deliverable_type<br/>context_snippet<br/>inferred_brief<br/>payment_intent_id<br/>accepted_roles[])]:::db
            submissions[(submissions<br/>Asset URLs)]:::db
            decisions[(decisions<br/>Formal Verdicts)]:::db
            invitations[(invitations<br/>Invite Tokens)]:::db
            profiles[(profiles<br/>skills[]<br/>notification_trigger)]:::db
            audit_log[(audit_log<br/>Immutable Record)]:::db
        end

        subgraph RPCs ["⚡ Atomic Wallet RPCs (V2)"]
            upsert_wallet_deposited["upsert_wallet_deposited<br/>(fundProjectWallet replaces racy upsert)"]:::rpc
            release_wallet_lock["release_wallet_lock<br/>(locked → released on payout)"]:::rpc
            unlock_wallet["unlock_wallet<br/>(locked → available on claim expiry)"]:::rpc
        end

        subgraph EdgeFunctions ["Edge Functions"]
            verify_sub["verify-submission<br/>(The Moat)"]:::edgefn
            storage_upload["supabase-storage-upload<br/>(Signed URLs)"]:::edgefn
            stripe_payment["stripe-payment<br/>(Capture/Cancel/Refund)"]:::edgefn
            create_payment_intent["create-payment-intent<br/>(Claim-time auth, manual capture)"]:::edgefn
            stripe_webhook["stripe-webhook<br/>(payment_intent.succeeded/failed)"]:::edgefn
            stripe_onboard["stripe-connect-onboard"]:::edgefn
            stripe_link["stripe-connect-link"]:::edgefn
            github_oauth["github-oauth"]:::edgefn
            scope_tasks["scope-tasks<br/>(AI Parse)"]:::edgefn
            asset_scanner["asset-scanner<br/>(Pass 1–3 · The Secret Sauce)"]:::edgefn
            auto_release["auto-release<br/>(Cron · 24h warning / 48h release)"]:::edgefn
            expire_claims["expire-claims<br/>(Cron · 5min · reclaim expired claims)"]:::edgefn
        end
    end

    %% ============================================================
    %% EXTERNAL WORLD
    %% ============================================================
    subgraph World ["🌍 External World"]
        Stripe[("Stripe Connect")]:::ext
        GitHub[("GitHub API")]:::ext
        FortressStorage[("Supabase Storage")]:::ext
        here_now[("here.now Publishing<br/>Portfolio Last")]:::ext
    end

    %% ============================================================
    %% FLOWS
    %% ============================================================

    %% ── Claim flow (V2: claim-time PI authorization) ────────────────
    tasks_p ==>|"claim"| create_payment_intent
    create_payment_intent ==>|"PI created, id stored on<br/>tasks.payment_intent_id"| Stripe
    tasks_p -->|"status = claimed"| tasks

    %% ── Submit flow ──────────────────────────────────────────────────
    submit_p ==>|"1. Get URL"| storage_upload
    storage_upload ==>|"2. PUT Asset"| FortressStorage
    submit_p -->|"3. Insert"| submissions
    submit_p ==>|"4. Invoke"| verify_sub
    verify_sub -.->|"auto_reject updates"| decisions & tasks

    %% ── Review Queue + Y.js ─────────────────────────────────────────
    reviews_p <-->|"Realtime"| tasks
    reviews_p <-->|"Y.js CRDT sync"| ydoc_s
    ydoc_s <-->|"WebRTC signaling"| RelayDO

    %% ── releasePayout Flow (V2: uses release_wallet_lock RPC) ────────
    payout_h -->|"1. Verdict"| decisions
    payout_h ==>|"2. Capture"| stripe_payment
    stripe_payment --> Stripe
    payout_h -->|"3. Mark Paid"| tasks
    payout_h -->|"4. release_wallet_lock RPC"| release_wallet_lock
    release_wallet_lock --> wallet

    %% ── fundProjectWallet (V2: uses upsert_wallet_deposited RPC) ────
    payout_h -.->|"fundProjectWallet"| upsert_wallet_deposited
    upsert_wallet_deposited --> wallet

    %% ── Autonomous Release (V2: uses release_wallet_lock RPC) ────────
    auto_release ==>|"48h Release"| stripe_payment
    auto_release -->|"release_wallet_lock RPC"| release_wallet_lock
    auto_release -->|"Update State"| tasks & decisions

    %% ── Claim Expiry (V2: uses unlock_wallet RPC) ───────────────────
    expire_claims ==>|"unlock_wallet RPC"| unlock_wallet
    unlock_wallet --> wallet
    expire_claims ==>|"Reclaim → open"| tasks

    %% ── Stripe Webhook (V2: handles PI events) ──────────────────────
    Stripe -.->|"payment_intent.succeeded"| stripe_webhook
    stripe_webhook -->|"Mark Paid + audit_log"| tasks
    stripe_webhook -->|"Insert decision"| decisions
    Stripe -.->|"payment_intent.payment_failed"| stripe_webhook
    stripe_webhook -.->|"Revert to open + notify"| tasks

    %% ── Asset Scanner (V2: dogfood on FatedFortress repo) ────────────
    scope_tasks -.->|"Pass 3 input"| asset_scanner
    asset_scanner -.->|"context_snippet / inferred_brief<br/>deliverable_type → tasks"| tasks

    %% ── publishToHereNow (Step 7 last) ──────────────────────────────
    project_p -.->|"publishToHereNow (stub)"| here_now
    create_p -.->|"publishToHereNow (stub)"| here_now