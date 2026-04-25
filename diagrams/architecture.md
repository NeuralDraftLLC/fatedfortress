%%{init: {
  "theme": "dark",
  "themeVariables": {
    "fontFamily": "Geist Mono, monospace",
    "fontSize": "12px"
  }
}}%%
graph TD
    classDef page     fill:#171717,stroke:#fafafa,stroke-width:2px,color:#fafafa
    classDef comp     fill:#0a0a0a,stroke:#525252,stroke-width:1px,color:#d4d4d4
    classDef handler  fill:#1b2a49,stroke:#ffd166,stroke-width:1px,color:#ffd166
    classDef db       fill:#0d1b2a,stroke:#2a9d8f,stroke-width:2px,color:#2a9d8f
    classDef edgefn   fill:#0d1b2a,stroke:#e9c46a,stroke-width:1px,color:#ffd166
    classDef zone     fill:#0d1b2a,stroke:#ef476f,stroke-width:2px,color:#ef476f
    classDef ext      fill:#000000,stroke:#737373,stroke-width:1px,color:#737373
    classDef state    fill:#1a1a2e,stroke:#a78bfa,stroke-width:1px,color:#a78bfa
    classDef legacy   fill:#111111,stroke:#525252,stroke-width:1px,color:#525252,stroke-dasharray:4 4

    %% ============================================================
    %% ZONE 1: BROWSER MAIN THREAD
    %% ============================================================
    subgraph SPA["Zone 1: Untrusted UI (apps/web - Cloudflare Pages)"]
        subgraph Pages["Page Views"]
            login_p["/login<br/>Magic Link + Google OAuth<br/>pages/login.ts"]:::page
            create_p["/create<br/>Brief to SCOPE to Edit to Publish<br/>pages/create.ts"]:::page
            tasks_p["/tasks<br/>Marketplace - Claim - Skill Gate<br/>pages/tasks.ts"]:::page
            submit_p["/submit/:taskId<br/>Upload to Deep-Spec Verify<br/>pages/submit.ts"]:::page
            reviews_p["/reviews<br/>Realtime Queue - Three-Column Crucible<br/>pages/reviews.ts"]:::page
            project_p["/project/:id<br/>Wallet - Audit Feed<br/>pages/project.ts"]:::page
            settings_p["/settings<br/>Stripe Connect - GitHub<br/>pages/settings.ts"]:::page
        end

        subgraph Components["UI Components"]
            PV_Wallet["WalletGauge<br/>Deposited / Locked / Released"]:::comp
            RV_Diff["SideBySide<br/>AI Brief vs Specialist Asset"]:::comp
            RV_Decide["DecisionPanel<br/>Structured Feedback"]:::comp
        end

        subgraph Handlers["Client Handlers"]
            payout_h["handlers/payout.ts<br/>createConnectAccountLink<br/>fundProjectWallet"]:::handler
            review_h["handlers/review.ts<br/>reviewSubmission<br/>approved / rejected / revision_requested"]:::handler
            scope_h["handlers/scope.ts<br/>generateScopedTasks GPT-4o"]:::handler
        end

        subgraph State["Client State"]
            identity_s["state/identity.ts<br/>Ed25519 Keys - Audit Signing"]:::state
            ydoc_s["state/ydoc.ts<br/>Y.js - Review Sessions Only"]:::state
            handoff_s["state/handoff.ts<br/>Task Handoff State"]:::state
        end
    end

    %% ============================================================
    %% ZONE 2: SECURE SANDBOX
    %% ============================================================
    subgraph VaultZone["Zone 2: Secure Sandbox (apps/worker - isolated origin)"]
        W_Keys["keystore.ts<br/>AES-256-GCM Vault<br/>AI Provider API Keys"]:::zone
    end

    %% ============================================================
    %% ZONE 3: CLOUDFLARE EDGE
    %% ============================================================
    subgraph EdgeZone["Zone 3: Stateless Edge (apps/relay - Cloudflare Workers)"]
        RelayDO["RelayDO<br/>Y.js WebRTC Signaling Hub<br/>+ TURN Credential Endpoint"]:::edgefn
    end

    %% ============================================================
    %% PERSISTENCE LAYER
    %% ============================================================
    subgraph Supabase["Supabase - Database / Edge Functions / Storage"]
        subgraph Schema["Schema (migrations 001-008 + refactor + blueprint)"]
            projects[("projects<br/>Blueprint - readme_draft<br/>folder_structure - brief_* cols 009")]:::db
            wallet[("project_wallet<br/>deposited / locked / released<br/>Atomic RPCs 003")]:::db
            tasks[("tasks<br/>State Machine - spec_constraints jsonb 008<br/>payment_intent_id - accepted_roles[]<br/>deliverable_type - context_inferred 501-001")]:::db
            submissions[("submissions<br/>Asset URL - Revision Count")]:::db
            decisions[("decisions<br/>Verdict - Feedback - Audit Trail<br/>payout_ledger 013")]:::db
            invitations[("invitations<br/>Invite Tokens")]:::db
            profiles[("profiles<br/>skills[] - reliability 005<br/>Stripe Connect ID")]:::db
            notifications[("notifications<br/>auto_release_warning 006")]:::db
        end

        subgraph EdgeFunctions["Edge Functions"]
            claim_task["claim-task<br/>Active claim path — invoked from tasks.ts<br/>Locks wallet + updates task state"]:::edgefn
            %% create-payment-intent is LEGACY: superseded by claim-task flow.
            %% Retained for reference; not invoked in active claim path.
            create_pi["create-payment-intent<br/>Stripe PI manual capture<br/>LEGACY — superseded by claim-task flow"]:::legacy
            stripe_wh["stripe-webhook<br/>PI succeeded/failed<br/>transfer.created - account.updated"]:::edgefn
            asset_scan["asset-scanner<br/>9-sub-pass layered engine<br/>deterministic to heuristic to gap"]:::edgefn
            verify_fn["verify-submission<br/>Deep-Spec Gate<br/>GLB / WAV / MP3 / PNG / JPEG"]:::edgefn
            scope_fn["create-and-scope-project<br/>GPT-4o Task Decomposition<br/>+ Project Creation"]:::edgefn
            stripe_fn["stripe-payment<br/>capture / cancel / refund / transfer"]:::edgefn
            review_fn["review-submission<br/>review_submission_atomic RPC<br/>Stripe capture/cancel + wallet moves"]:::edgefn
            submit_fn["submit-task<br/>Asset Link + Trigger Deep-Spec Gate"]:::edgefn
            auto_release["auto-release Cron 30min<br/>24h warning to 48h auto-approve<br/>release_wallet_lock RPC"]:::edgefn
            expire_claims["expire-claims Cron 5min<br/>Reclaim Stale Soft-locks<br/>unlock_wallet RPC"]:::edgefn
            %% storage_fn: previously r2-upload-url (Cloudflare R2); migrated to Supabase Storage.
            storage_fn["supabase-storage-upload<br/>Upload URL / Supabase Storage path"]:::edgefn
            connect_onboard["stripe-connect-onboard<br/>Stripe Express Onboarding"]:::edgefn
            connect_link["stripe-connect-link<br/>Dashboard Link / Reauth"]:::edgefn
            github_fn["github-oauth<br/>Server-side Token Exchange"]:::edgefn
        end

        subgraph Storage["Storage - Supabase Storage"]
            SB_STORAGE[("submissions/<br/>Deliverable Assets — Supabase Storage")]:::db
        end
    end

    %% ============================================================
    %% EXTERNAL WORLD
    %% ============================================================
    subgraph World["External World"]
        Stripe[("Stripe Connect<br/>Express - Manual Capture<br/>10% Platform Fee")]:::ext
        GitHub[("GitHub API<br/>Asset Scanner - OAuth")]:::ext
        OpenAI[("OpenAI GPT-4o<br/>create-and-scope-project - asset-scanner")]:::ext
        Sentry[("Sentry<br/>Error Tracking - PII Scrubbed")]:::ext
    end

    %% ============================================================
    %% FLOWS
    %% ============================================================

    %% Auth
    login_p -->|"Magic Link / OAuth"| Supabase

    %% Settings / Onboarding
    settings_p -->|"Connect Onboarding"| payout_h
    payout_h -->|"createConnectAccountLink"| connect_onboard
    payout_h -->|"reauth / dashboard link"| connect_link
    connect_onboard --> Stripe
    connect_link --> Stripe
    payout_h -->|"fundProjectWallet RPC"| wallet
    settings_p -->|"GitHub OAuth"| github_fn
    github_fn --> GitHub

    %% Create / Scope
    create_p -->|"Generate Tasks"| scope_h
    scope_h -->|"Invoke"| scope_fn
    scope_fn --> OpenAI
    scope_fn -->|"Persist projects"| projects
    scope_fn -->|"Persist tasks"| tasks

    %% Asset Scanner
    create_p -->|"Scan Repo Gaps"| asset_scan
    asset_scan --> GitHub
    asset_scan --> OpenAI
    asset_scan -->|"asset_scanner_write RPC"| tasks

    %% Claim — Active path (tasks.ts → claim-task edge function)
    tasks_p -->|"Invoke claim-task edge fn"| claim_task
    claim_task -->|"Update claim state"| tasks
    claim_task -->|"Lock funds / claim RPC"| wallet

    %% create-payment-intent — standalone legacy node (not in active claim path)
    create_pi -->|"PI manual capture"| Stripe
    create_pi -->|"Store payment_intent_id"| tasks

    %% Submit
    submit_p -->|"Upload asset"| storage_fn
    storage_fn --> SB_STORAGE
    submit_p -->|"Invoke submit-task"| submit_fn
    submit_fn -->|"Trigger Deep-Spec Gate"| verify_fn
    verify_fn -->|"Reads spec_constraints"| tasks
    verify_fn -.->|"auto_reject on mismatch"| decisions

    %% Review — live collab
    reviews_p -->|"Supabase Realtime"| tasks
    tasks -->|"Realtime push"| reviews_p
    reviews_p -->|"Y.js CRDT"| RelayDO
    RelayDO -->|"Y.js sync"| reviews_p
    ydoc_s -->|"Y.js updates"| RelayDO
    RelayDO -->|"Y.js sync"| ydoc_s
    handoff_s -.->|"Handoff context"| reviews_p

    %% Review Decision
    reviews_p -->|"Host verdict"| review_h
    review_h ==>|"reviewSubmission"| review_fn
    review_fn -->|"atomic RPC"| decisions
    review_fn -->|"update status"| tasks
    review_fn -->|"wallet movement"| wallet
    review_fn ==>|"Stripe capture / cancel"| stripe_fn
    stripe_fn --> Stripe
    stripe_fn -->|"Webhook confirms"| stripe_wh
    stripe_wh -->|"Mark Paid"| tasks

    %% Autonomous Release
    auto_release -->|"24h Warning"| notifications
    auto_release ==>|"48h Capture PI"| stripe_fn
    auto_release -->|"Update tasks"| tasks
    auto_release -->|"Update wallet"| wallet
    auto_release -->|"Update decisions"| decisions

    %% Expire Claims
    expire_claims ==>|"unlock_wallet RPC"| wallet
    expire_claims -->|"Reopen Task"| tasks

    %% Keystore
    W_Keys -.->|"Isolated origin boundary"| SPA

    %% Error tracking
    SPA -.->|"Sentry PII scrubbed"| Sentry
