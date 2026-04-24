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
        RelayDO["apps/relay/src/index.ts<br/>(WebRTC Hub)"]:::edgefn
    end

    %% ============================================================
    %% PERSISTENCE (Supabase)
    %% ============================================================
    subgraph Supabase ["🗄️ Supabase Persistence Layer"]
        subgraph Schema ["Schema — Sacred Objects"]
            projects[(projects<br/>Blueprint Metadata)]:::db
            wallet[(project_wallet<br/>Stripe Balances)]:::db
            tasks[(tasks<br/>State Machine)]:::db
            submissions[(submissions<br/>Asset URLs)]:::db
            decisions[(decisions<br/>Formal Verdicts)]:::db
            invitations[(invitations<br/>Invite Tokens)]:::db
            profiles[(profiles<br/>Reliability Index)]:::db
            audit_log[(audit_log<br/>Immutable Record)]:::db
        end

        subgraph EdgeFunctions ["Edge Functions"]
            verify_sub["verify-submission<br/>(The Moat)"]:::edgefn
            storage_upload["supabase-storage-upload<br/>(Signed URLs)"]:::edgefn
            stripe_payment["stripe-payment<br/>(Capture)"]:::edgefn
            stripe_onboard["stripe-connect-onboard"]:::edgefn
            stripe_link["stripe-connect-link"]:::edgefn
            github_oauth["github-oauth"]:::edgefn
            scope_tasks["scope-tasks<br/>(AI Parse)"]:::edgefn
            auto_release["auto-release<br/>(Cron)"]:::edgefn
            expire_claims["expire-claims<br/>(Cron)"]:::edgefn
        end
    end

    %% ============================================================
    %% EXTERNAL WORLD
    %% ============================================================
    subgraph World ["🌍 External World"]
        Stripe[("Stripe Connect")]:::ext
        GitHub[("GitHub API")]:::ext
        FortressStorage[("Supabase Storage")]:::ext
        here_now[("here.now Publishing")]:::ext
    end

    %% ============================================================
    %% FLOWS
    %% ============================================================

    submit_p ==>|"1. Get URL"| storage_upload
    storage_upload ==>|"2. PUT Asset"| FortressStorage
    submit_p -->|"3. Insert"| submissions
    submit_p ==>|"4. Invoke"| verify_sub
    verify_sub -.->|"auto_reject updates"| decisions & tasks

    %% Review Queue
    reviews_p <-->|"Realtime"| tasks

    %% releasePayout Flow
    payout_h -->|"1. Verdict"| decisions
    payout_h ==>|"2. Capture"| stripe_payment
    stripe_payment --> Stripe
    payout_h -->|"3. Mark Paid"| tasks
    payout_h -->|"4. Release"| wallet

    %% Autonomous Release
    auto_release ==>|"48h Release"| stripe_payment
    auto_release -->|"Update State"| tasks & wallet & decisions
    expire_claims ==>|"Reclaim"| tasks