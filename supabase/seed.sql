-- supabase/seed.sql
-- Demo seed tasks for FatedFortress.
-- Safe to run multiple times (ON CONFLICT DO NOTHING).
-- Requires at least one project row to exist — uses a placeholder project_id
-- that will be replaced by a real project once a host signs up.
-- Run: supabase db seed (or psql -f supabase/seed.sql)

-- ── Ensure seed project exists ──────────────────────────────────────────────
INSERT INTO projects (id, title, host_id, status, payout_max, created_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'FatedFortress Demo Project',
  '00000000-0000-0000-0000-000000000000', -- placeholder host (anonymous)
  'active',
  50000, -- $500 total budget
  NOW()
)
ON CONFLICT (id) DO NOTHING;

-- ── Demo tasks ───────────────────────────────────────────────────────────────

-- Task 1: Code — TypeScript utility
INSERT INTO tasks (
  id, project_id, title, description,
  deliverable_type, payout_min, payout_max,
  status, spec_constraints, created_at
)
VALUES (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'Build CSV-to-JSON converter utility',
  'Write a TypeScript utility function (Node.js/Deno compatible) that converts a CSV string into a typed JSON array. Must handle quoted fields, escaped commas, and empty cells. Include unit tests covering edge cases. Deliverable: a single .ts file + test file as a .zip.',
  'file',
  7500,   -- $75.00
  12000,  -- $120.00
  'open',
  '{"max_files_changed": 2, "requires_tests": true}',
  NOW() - INTERVAL '2 hours'
)
ON CONFLICT (id) DO NOTHING;

-- Task 2: Design Asset — icon set
INSERT INTO tasks (
  id, project_id, title, description,
  deliverable_type, payout_min, payout_max,
  status, spec_constraints, created_at
)
VALUES (
  '10000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'Design 12-icon UI set (SVG + PNG)',
  'Create a cohesive set of 12 UI icons for a dark-themed SaaS dashboard. Icons needed: dashboard, tasks, wallet, settings, notifications, user, search, filter, upload, download, check, close. Deliver as a ZIP containing both SVG (vector) and PNG (32×32, 64×64) for each icon. Dark and light variants required.',
  'design_asset',
  15000,  -- $150.00
  25000,  -- $250.00
  'open',
  '{"min_width": 32, "min_height": 32, "max_width": 64, "max_height": 64}',
  NOW() - INTERVAL '5 hours'
)
ON CONFLICT (id) DO NOTHING;

-- Task 3: Audio — UI SFX pack
INSERT INTO tasks (
  id, project_id, title, description,
  deliverable_type, payout_min, payout_max,
  status, spec_constraints, created_at
)
VALUES (
  '10000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000001',
  'UI sound effects pack (8 clips)',
  'Produce 8 short UI sound effects for a web app: button_click, task_claimed, task_submitted, payment_approved, payment_rejected, notification_ping, error_buzz, success_chime. Each clip must be ≤ 2 seconds, 44.1 kHz WAV, mono. Deliver as a ZIP.',
  'audio',
  8000,   -- $80.00
  14000,  -- $140.00
  'open',
  '{"sample_rate": 44100, "channels": 1, "max_duration_s": 2}',
  NOW() - INTERVAL '1 hour'
)
ON CONFLICT (id) DO NOTHING;

-- Task 4: Copy — onboarding email sequence
INSERT INTO tasks (
  id, project_id, title, description,
  deliverable_type, payout_min, payout_max,
  status, spec_constraints, created_at
)
VALUES (
  '10000000-0000-0000-0000-000000000004',
  '00000000-0000-0000-0000-000000000001',
  'Write 3-email onboarding sequence for contributors',
  'Write three plain-text onboarding emails for new FatedFortress contributors: (1) Welcome + how to claim your first task (2) Tips for passing the auto-verifier (3) How payouts work and Stripe Connect setup. Each email: subject line + body, 150–300 words, conversational-technical tone, no marketing fluff. Deliver as a single Markdown file.',
  'text',
  5000,   -- $50.00
  9000,   -- $90.00
  'open',
  '{"min_words": 150, "max_words": 300}',
  NOW() - INTERVAL '30 minutes'
)
ON CONFLICT (id) DO NOTHING;

-- ── Ensure profiles columns exist for avg_review_time tracking ──────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS review_count          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_review_time_hours FLOAT   NOT NULL DEFAULT 0;
