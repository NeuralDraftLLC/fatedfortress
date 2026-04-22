# Fated Fortress — System Diagram
# Mermaid flowchart covering all user-facing flows, data layer, and integrations

```mermaid
flowchart TB
    %% ─────────────────────────────────────────────
    %% EXTERNAL INTEGRATIONS
    %% ─────────────────────────────────────────────

    subgraph External["🌐 External Services"]
        direction TB
        Stripe[("Stripe Connect<br/>+ PaymentIntents")]
        GitHub[("GitHub API<br/>OAuth · PRs · Branches")]
        R2[("Cloudflare R2<br/>Asset Storage")]
        HereNow[("here.now<br/>Permanent Hosting")]
        SupabaseAuth[("Supabase Auth<br/>Magic Link · Google OAuth")]
    end

    %% ─────────────────────────────────────────────
    %% SUPABASE LAYER
    %% ─────────────────────────────────────────────

    subgraph Supabase["🗄️ Supabase (PostgreSQL + Realtime)"]
        direction TB

        subgraph Schema["Schema Tables"]
            profiles[( "profiles<br/>id · display_name · role<br/>github_username · avatar_url<br/>review_reliability signals" )]
            projects[( "projects<br/>id · host_id · title<br/>description · status<br/>template_id" )]
            project_wallet[( "project_wallet<br/>project_id · deposited<br/>locked · released" )]
            tasks[( "tasks<br/>id · project_id · title<br/>payout_min · payout_max<br/>approved_payout · status<br/>claimed_by · soft_lock_expires_at<br/>task_access · ambiguity_score" )]
            invitations[( "invitations<br/>id · task/project_id<br/>token · invited_email/user_id<br/>accepted_at · expires_at" )]
            submissions[( "submissions<br/>id · task_id · contributor_id<br/>asset_url · deliverable_type<br/>revision_number · ai_summary" )]
            decisions[( "decisions<br/>id · submission_id · host_id<br/>decision_reason · review_notes<br/>structured_feedback · approved_payout<br/>revision_deadline" )]
            review_sessions[( "review_sessions<br/>id · task_id · submission_id<br/>ydoc_id · status<br/>host_id · contributor_id" )]
            notifications[( "notifications<br/>id · user_id · type<br/>task_id · read" )]
            audit_log[( "audit_log<br/>id · actor_id · task_id<br/>action · payload" )]
            project_templates[( "project_templates<br/>id · title · description" )]
        end

        subgraph EdgeFunctions["Edge Functions (Deno)"]
            expire_claims["expire-claims<br/>(cron: every 5 min)"]
            auto_release["auto-release<br/>(cron: every 30 min)"]
            stripe_fn["stripe-payment<br/(capture PaymentIntent)"]
            scope_tasks["scope-tasks<br/(AI task generation)"]
            verify_submission["verify-submission<br/(R2 → pre-review)"]
            r2_upload_url["r2-upload-url<br/(presigned R2 PUT)"]
            github_oauth["github-oauth<br/(code exchange)"]
        end

        RealtimeNotice["Supabase Realtime<br/>postgres_changes on tasks + notifications"]
    end

    %% ─────────────────────────────────────────────
    %% FRONTEND — PAGES
    %% ─────────────────────────────────────────────

    subgraph Frontend["🖥️ Web App (apps/web/src)"]
        direction TB

        subgraph Pages["Pages (SPA Routes)"]
            login_page["/login<br/>Magic link + Google OAuth"]
            create_page["/create<br/>Brief → SCOPE → Preview → Publish"]
            tasks_page["/tasks<br/>Browse · Filter · Claim"]
            submit_page["/submit/:taskId<br/>Upload → VERIFY → Submit"]
            reviews_page["/reviews<br/>Queue · FIFO · Staleness · Decision"]
            project_page["/project/:id<br/>Wallet · Tasks · Audit Feed"]
            profile_page["/profile<br/>Reliability · Portfolio"]
            settings_page["/settings<br/>Stripe Connect · GitHub OAuth"]
        end

        subgraph Auth["Auth Layer"]
            auth_index["auth/index.ts<br/>getSupabase · signInWithEmailMagicLink<br/>signInWithGoogle · signOut<br/>getMyProfile · updateMyProfile"]
            auth_mw["auth/middleware.ts<br/>requireAuth · isProtectedRoute<br/>isAuthenticated · getRedirectPath"]
        end

        subgraph Handlers["Business Logic Handlers"]
            payout_h["handlers/payout.ts<br/>createConnectAccountLink<br/>fundProjectWallet<br/>releasePayout ⚡ STRIPE<br/>rejectSubmission<br/>requestRevision"]
            scope_h["handlers/scope.ts<br/>generateScopedTasks<br/>writeScopedTasks"]
        end

        subgraph Net["Network Layer"]
            storage_n["net/storage.ts<br/>createPresignedUploadUrl<br/>uploadToR2 · validateFile<br/>createPortfolioUploadUrl"]
            notifications_n["net/notifications.ts<br/>subscribeToNotifications<br/>markNotificationRead<br/>getUnreadCount"]
            github_n["net/github.ts<br/>initiateGitHubOAuth<br/>createBranch · createPR<br/>checkPRExists · checkFigmaAccessible"]
        end
    end

    %% ─────────────────────────────────────────────
    %% WORKERS
    %% ─────────────────────────────────────────────

    subgraph Workers["⚙️ Workers"]
        verify_worker["workers/verify-submission.ts<br/>(Cloudflare Worker)<br/>format_valid · size · mime<br/>pr_exists · figma_accessible<br/>auto_reject flag"]
        worker_bridge["net/worker-bridge.ts<br/(iframe bridge to keys.fatedfortress.com)<br/>requestGenerate · storeKey<br/>requestFuelGauge · consumeDemoToken"]
    end

    %% ─────────────────────────────────────────────
    %% STATE
    %% ─────────────────────────────────────────────

    subgraph State["📦 Client State"]
        identity_s["state/identity.ts<br/>Ed25519 keypair<br/>IndexedDB persistence"]
        ydoc_s["state/ydoc.ts<br/>Y.js CRDT (REVIEW SESSIONS ONLY)<br/>FortressRoomDoc<br/>hydrateDoc · serializeDoc"]
        handoff_s["state/handoff.ts<br/>Host Transfer (SubBudgetToken)<br/>Minimax Stream Cache (LRU)"]
        signaling_s["net/signaling.ts<br/>WebSocket relay<br/>y-webrtc (WebRTC P2P)<br/>OPFS snapshot · TURN/STUN"]
    end

    %% ─────────────────────────────────────────────
    %% USER ACTIONS & FLOWS
    %% ─────────────────────────────────────────────

    subgraph Flows["User Flows (numbered by priority)"]

        Flow1["① LOGIN FLOW"]
        Flow1a["Visitor → /login → Magic Link or Google OAuth"]
        Flow1b["Supabase Auth → profile auto-created → redirect /reviews or /tasks"]

        Flow2["② PROJECT CREATION FLOW"]
        Flow2a["Host → /create → fill brief (title, description, type, budget)"]
        Flow2b["SCOPE button → scope-tasks edge fn → ScopedTask[] + readmeDraft + folderStructure"]
        Flow2c["Host edits payouts (within AI range) → PUBLISH"]
        Flow2d["Project status → active · tasks status → open · project_wallet row created (deposited=0)"]
        Flow2e["audit_log: task_published"]

        Flow3["③ INVITATION + CLAIM FLOW"]
        Flow3a["Host → creates invitation → unique token URL"]
        Flow3b["Contributor opens ?invite=<token> link → invitation validated + accepted"]
        Flow3c["CLAIM button → tasks.status → claimed · soft_lock_expires_at = now+24h"]
        Flow3d["audit_log: claimed · notifications: task_claimed → host"]

        Flow4["④ SUBMISSION + VERIFY FLOW"]
        Flow4a["Contributor → /submit/:taskId → drops file (max 500MB)"]
        Flow4b["Upload via presigned R2 PUT → asset_url stored"]
        Flow4c["VERIFY_SUBMISSION runs (Cloudflare Worker)"]
        Flow4d{"auto_reject?"}
        Flow4e2["❌ FAIL → decisions row (quality_issue) → task: revision_requested → notifications: verification_failed → contributor sees error"]
        Flow4f2["✅ PASS → submissions row created → task.status → under_review → notifications: submission_received → host"]
        Flow4e2 --> audit_log

        Flow5["⑤ REVIEW QUEUE FLOW (THE MOAT)"]
        Flow5a["Host → /reviews (realtime via Supabase Realtime)"]
        Flow5b["Tasks shown: oldest first (submitted_at ASC) + payout_max DESC · 20/page · cursor pagination"]
        Flow5c["Staleness badge if under_review > 12h"]
        Flow5d["Host clicks Review → Decision modal opens"]
        Flow5e{"Decision"}
        Flow5f2["APPROVE & PAY<br/>→ releasePayout()<br/>① decisions insert<br/>② Stripe PaymentIntent captured ⚡<br/>③ tasks.paid · tasks.approved_payout cached<br/>④ project_wallet locked↓ released↑<br/>⑤ audit_log: payment_released<br/>⑥ review_sessions resolved<br/>⑦ host reliability stats<br/>⑧ notifications: payment_released"]
        Flow5g2["REJECT<br/>→ rejectSubmission()<br/>① decisions insert<br/>② task → open (claim cleared)<br/>③ audit_log: rejected<br/>④ host reliability stats<br/>⑤ notifications: submission_rejected"]
        Flow5h2["REQUEST REVISION<br/>→ requestRevision()<br/>① decisions insert<br/>② task → revision_requested<br/>③ audit_log: revision_requested<br/>④ host reliability stats<br/>⑤ notifications: revision_requested"]
        Flow5e --> Flow5f2
        Flow5e --> Flow5g2
        Flow5e --> Flow5h2

        Flow6["⑥ AUTO-RELEASE EDGE FUNCTION"]
        Flow6a["auto-release runs every 30 min"]
        Flow6b{"24h check"}
        Flow6c["under_review > 24h → notifications: auto_release_warning → host"]
        Flow6d{"48h check"}
        Flow6e["under_review > 48h → full releasePayout contract → auto_released decision → task.paid → notifications: auto_released (host + contributor)"]

        Flow7["⑦ EXPIRE-CLAIMS EDGE FUNCTION"]
        Flow7a["expire-claims runs every 5 min"]
        Flow7b["tasks.status=claimed + soft_lock_expires_at < now() → reset to open · clear claim"]
        Flow7c["notifications: claim_expired → prior contributor · audit_log: claim_expired"]

        Flow8["⑧ PROJECT DETAIL FLOW"]
        Flow8a["Host → /project/:id"]
        Flow8b["Shows: project info + wallet (deposited/locked/released/available) + task list + audit feed"]
        Flow8c["Click task → navigates to /reviews for that task's submission"]

        Flow9["⑨ PROFILE + SETTINGS"]
        Flow9a["/profile → review_reliability signals + portfolio upload"]
        Flow9b["/settings → Stripe Connect onboarding → createConnectAccountLink → Stripe OAuth"]
        Flow9c["/settings → GitHub OAuth → initiateGitHubOAuth → exchangeGitHubCode → token stored on profile"]
    end

    %% ─────────────────────────────────────────────
    %% CONNECTIONS
    %% ─────────────────────────────────────────────

    %% Auth connections
    SupabaseAuth -->|"signInWithMagicLink / OAuth"| login_page
    auth_index -->|"getSupabase()"| auth_mw
    auth_mw -->|"requireAuth()"| Pages

    %% Page → Handler connections
    create_page -->|"generateScopedTasks"| scope_h
    scope_h -->|"scope-tasks edge fn"| scope_tasks
    scope_tasks -.->|"ScopedTask[] + readmeDraft + folderStructure"| create_page
    create_page -->|"writeScopedTasks"| scope_h
    scope_h -->|"INSERT tasks + project_wallet"| projects
    scope_h -->|"INSERT tasks + project_wallet"| tasks
    scope_h -->|"INSERT tasks + project_wallet"| project_wallet

    payout_h -->|"stripe-payment edge fn"| stripe_fn
    stripe_fn -.->|"PaymentIntent captured"| Stripe
    payout_h -->|"INSERT decisions"| decisions
    payout_h -->|"UPDATE tasks"| tasks
    payout_h -->|"UPDATE project_wallet"| project_wallet
    payout_h -->|"INSERT audit_log"| audit_log
    payout_h -->|"UPDATE profiles (reliability)"| profiles
    payout_h -->|"INSERT notifications"| notifications

    reviews_page -->|"releasePayout / reject / requestRevision"| payout_h
    create_page -->|"fundProjectWallet"| payout_h

    settings_page -->|"createConnectAccountLink"| payout_h
    settings_page -->|"initiateGitHubOAuth"| github_n
    github_n -.->|"OAuth callback"| GitHub

    tasks_page -->|"SELECT tasks (invitation-aware)"| tasks
    tasks_page -->|"SELECT invitations (accepted)"| invitations
    tasks_page -->|"UPDATE tasks (claim)"| tasks
    tasks_page -->|"INSERT audit_log / notifications"| audit_log
    tasks_page -->|"INSERT invitations (accept)"| invitations

    submit_page -->|"createPresignedUploadUrl"| storage_n
    storage_n -->|"r2-upload-url edge fn"| r2_upload_url
    r2_upload_url -.->|"presigned PUT URL"| R2
    submit_page -->|"uploadToR2"| storage_n
    storage_n -.->|"PUT file to R2"| R2
    submit_page -->|"verify-submission edge fn"| verify_worker
    verify_worker -.->|"VerificationResult"| submit_page
    submit_page -->|"INSERT submissions + UPDATE tasks + INSERT decisions (auto-reject)"| submissions
    submit_page -->|"INSERT notifications"| notifications
    submit_page -->|"INSERT audit_log"| audit_log

    project_page -->|"SELECT project + tasks + project_wallet + audit_log"| projects
    project_page -->|"SELECT project + tasks + project_wallet + audit_log"| tasks
    project_page -->|"SELECT project + tasks + project_wallet + audit_log"| project_wallet
    project_page -->|"SELECT project + tasks + project_wallet + audit_log"| audit_log

    profile_page -->|"SELECT/UPDATE profiles"| profiles
    profile_page -->|"createPortfolioUploadUrl + uploadToR2"| storage_n

    %% Notifications realtime
    notifications_n -.->|"postgres_changes INSERT"| notifications
    notifications_n -.->|"dispatchEvent ff:notification"| Frontend

    %% Edge functions connections
    expire_claims -->|"SELECT tasks (expired)"| tasks
    expire_claims -->|"UPDATE tasks (reset to open)"| tasks
    expire_claims -->|"INSERT notifications + audit_log"| notifications
    expire_claims -->|"INSERT notifications + audit_log"| audit_log

    auto_release -->|"SELECT tasks (24h/48h under_review)"| tasks
    auto_release -->|"SELECT submissions (latest per task)"| submissions
    auto_release -->|"INSERT decisions (approved_fast_track)"| decisions
    auto_release -->|"stripe-payment (capture)"| stripe_fn
    auto_release -->|"UPDATE tasks (paid)"| tasks
    auto_release -->|"UPDATE project_wallet (locked↓ released↑)"| project_wallet
    auto_release -->|"INSERT notifications + audit_log"| notifications
    auto_release -->|"INSERT notifications + audit_log"| audit_log

    %% Workers
    verify_worker -->|"GitHub API checkPRExists"| GitHub
    verify_worker -->|"Figma API checkFigmaAccessible"| GitHub

    github_n -->|"GitHub API createBranch / createPR"| GitHub
    github_n -->|"github-oauth edge fn"| github_oauth

    %% State connections
    State -->|"OPFS read/write snapshots"| signaling_s
    signaling_s -.->|"WebSocket relay (wss)"| Supabase
    ydoc_s -.->|"applyRemoteUpdate · serializeDoc"| signaling_s
    ydoc_s -->|"REVIEW SESSIONS ONLY<br/>(ydoc_id)"| review_sessions
    identity_s -->|"getMyPubkey()"| State
    worker_bridge -.->|"postMessage iframe"| External

    audit_log -.->|"audit feed shown in"| project_page
    audit_log -.->|"audit feed shown in"| reviews_page

    decisions -->|"read by"| payout_h

    invitations -->|"enforce invite-only access"| tasks_page

    project_wallet -->|"wallet display"| project_page
    project_wallet -->|"locked/released updates"| payout_h
    project_wallet -->|"locked/released updates"| auto_release

    SupabaseAuth -.->|"profile trigger → handle_new_user()"| profiles

    %% Styling
    classDef auth fill:#1a1a2e,color:#eee,stroke:#4cc9f0
    classDef page fill:#16213e,color:#eee,stroke:#4361ee
    classDef handler fill:#1b2a49,color:#e0e0ff,stroke:#7209b7
    classDef net fill:#1b2a49,color:#e0e0ff,stroke:#f72585
    classDef schema fill:#0d1b2a,color:#a8dadc,stroke:#2a9d8f
    classDef edgefn fill:#0d1b2a,color:#ffd166,stroke:#e9c46a
    classDef worker fill:#0d1b2a,color:#ef476f,stroke:#ef476f
    classDef state fill:#0d1b2a,color:#06d6a0,stroke:#06d6a0
    classDef flow fill:#1b2a49,color:#fff,stroke:#fff
    classDef stripe fill:#1b2a49,color:#fff,stroke:#635bff
    classDef github fill:#1b2a49,color:#fff,stroke:#24292e
    classDef r2 fill:#1b2a49,color:#fff,stroke:#f3801a

    class SupabaseAuth,auth_index,auth_mw auth
    class login_page,create_page,tasks_page,submit_page,reviews_page,project_page,profile_page,settings_page page
    class payout_h,scope_h handler
    class storage_n,notifications_n,github_n net
    class profiles,projects,project_wallet,tasks,invitations,submissions,decisions,review_sessions,notifications,audit_log,project_templates schema
    class expire_claims,auto_release,stripe_fn,scope_tasks,verify_submission,r2_upload_url,github_oauth edgefn
    class verify_worker,worker_bridge worker
    class identity_s,ydoc_s,handoff_s,signaling_s state
    class Flow1,Flow2,Flow3,Flow4,Flow5,Flow6,Flow7,Flow8,Flow9 flow
    class Stripe stripe
    class GitHub github
    class R2 r2
```

---

## System Overview

Fated Fortress is a **review-centered task marketplace** with three sacred objects: **Task**, **Submission**, **Decision**.

- **Host** creates a project → AI generates tasks via SCOPE → publishes
- **Contributor** claims a task → submits a deliverable → gets verified automatically
- **Host** reviews in a FIFO queue → approves (and pays) / rejects / requests revision
- **Auto-release** fires if the host doesn't act in 48h
- **Soft-lock** expires if contributor doesn't submit in 24h

---

## Key Design Decisions

- **Stripe capture only in `releasePayout`** — never on claim or submit
- **`decisions` is the authoritative record** — `submissions` has no decision columns
- **`project_wallet.available`** is computed, never stored
- **Invite-first** — `?invite=<token>` URL param on claim flow
- **VERIFY runs before the host queue** — auto-reject saves host time
- **Y.js = review sessions only** — not room-based presence
- **Supabase Realtime** for notifications and the review queue

---

## Environment Variables Required

```env
# Supabase
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=

# Stripe
STRIPE_SECRET_KEY=          # server-side only
VITE_STRIPE_PUBLISHABLE_KEY= # client-side

# GitHub
VITE_GITHUB_CLIENT_ID=
GITHUB_TOKEN=               # server-side (verify worker)

# here.now
VITE_HERENOW_CLIENT_ID=

# Worker bridge
VITE_WORKER_ORIGIN=https://keys.fatedfortress.com

# Relay
__RELAY_ORIGIN__=wss://relay.fatedfortress.com
__RELAY_HTTP_ORIGIN__=https://relay.fatedfortress.com
```
