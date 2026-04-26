/**
 * packages/protocol/src/index.ts — Shared types for FatedFortress MVP.
 *
 * Sacred objects: Task, Submission, Decision
 * System of record: Supabase
 *
 * Legacy room-based types (deprecated, do not use in new code):
 *   RoomId, ReceiptId, RoomCategory, RoomAccess, RoomRole,
 *   PaletteIntent, PaletteContext (room-scoped variants),
 *   FortressRoomDoc, join_room, spectate_room, fork_receipt, etc.
 *
 * New MVP types:
 *   Profile, Project, Task, Submission, ReviewSession
 *   DecisionReason, TaskStatus, SubmissionStatus
 *   ClaimTaskIntent, SubmitSubmissionIntent, ApproveSubmissionIntent,
 *   RejectSubmissionIntent, RequestRevisionIntent, ScopeProjectIntent,
 *   VerifySubmissionIntent, ReviewReliability
 *
 * Crypto helpers (kept for receipt signing and audit trail):
 *   FFError, hashOutput, base64urlEncode/Decode, toBase58/fromBase58,
 *   verifyBudgetToken, generateTokenId, generateTokenNonce,
 *   encodeBudgetTokenSigningMessage, assertEd25519Supported, BUDGET_TOKEN_TTL_MS
 */

// ---------------------------------------------------------------------------
// Brands & IDs
// ---------------------------------------------------------------------------

export type RoomId = string & { readonly __brand: "RoomId" };
export type ReceiptId = string & { readonly __brand: "ReceiptId" };
export type PublicKeyBase58 = string & { readonly __brand: "PublicKeyBase58" };
export type ReceiptHash = string & { readonly __brand: "ReceiptHash" };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FF_ORIGIN = "http://localhost:5173"; // Default for dev, overridden in prod
export const WORKER_ORIGIN = "http://localhost:5174"; // Stub worker origin for dev

export const PROVIDER_ALLOWLIST = [
  "openai",
  "anthropic",
  "google",
  "minimax",
  "groq",
  "openrouter",
] as const;

export type ProviderId = (typeof PROVIDER_ALLOWLIST)[number];

export const BUDGET_TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour
export const SUB_BUDGET_TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour (same as budget token)

// ---------------------------------------------------------------------------
// Room & Generation Types
// ---------------------------------------------------------------------------

export type RoomCategory =
  | "code"
  | "animation"
  | "audio"
  | "games"
  | "writing"
  | "general";

/** Modality supported in a room or generation request. */
export type Modality = "text" | "image" | "audio" | "video";

/**
 * Yield types emitted by adapter `generate()` implementations.
 * Each variant carries the data needed by the caller.
 *
 * text_delta  → incremental text token (same as current string yield)
 * image_url  → URL or opfs:// path to a generated image
 * audio_url  → URL or opfs:// path to generated audio
 * job_id     → async job reference (for polling-based providers)
 * progress   → integer 0–100 estimated progress
 * done       → final marker; adapterId lets caller know which adapter finished
 */
export type AdapterYield =
  | { type: "text_delta";  delta: string }
  | { type: "image_url";   url: string; alt?: string }
  | { type: "audio_url";   url: string; durationSeconds?: number }
  | { type: "job_id";      jobId: string; provider: ProviderId }
  | { type: "progress";    percent: number }
  | { type: "done";        adapterId: ProviderId };

/**
 * Multimodal generation request — extends the basic text-only request.
 * The `modality` field determines which output types are expected/allowed.
 */
export interface GenerateRequest {
  modality: Modality;
  prompt: string;
  model: string;
  systemPrompt?: string;
}

export type RoomAccess = "free" | "paid";

export type RoomRole =
  | "prompt_engineer"
  | "sound_engineer"
  | "animator"
  | "video_editor"
  | "writer"
  | "critic";

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

// ---------------------------------------------------------------------------
// Palette & Intents
// ---------------------------------------------------------------------------

export type PaletteIntent =
  | { type: "create_room"; category: RoomCategory; access: RoomAccess; price: number | null; name: string | null }
  | { type: "join_room"; roomId: RoomId }
  | { type: "spectate_room"; roomId: RoomId | null }
  | { type: "fork_receipt"; receiptId: ReceiptId | null }
  | { type: "switch_model"; model: ModelRef | null; rawModelName: string }
  | { type: "publish"; target: "room" | "receipt" }
  | { type: "pay"; amount: number; roomId: RoomId | null }
  | { type: "invite"; peer: string | null }
  | { type: "search"; query: string; category: RoomCategory | null }
  | { type: "link_herenow" }
  | { type: "set_system_prompt"; prompt: string }
  | { type: "set_quota"; tokensPerUser: number }
  | { type: "open_connect"; provider: ProviderId | null }
  | { type: "open_me" }
  | { type: "help"; command: string | null }
  | { type: "claim_role"; role: RoomRole }
  | { type: "list_roles" }
  | { type: "upgrade_room"; price: number | null }
  | { type: "delegate_sub_budget"; peer: string | null; tokensPerUser: number };

export interface PaletteContext {
  currentPage: "table" | "room" | "connect" | "me";
  currentRoomId: RoomId | null;
  currentRoomAccess: RoomAccess | null;
  focusedReceiptId: ReceiptId | null;
  currentModel: ModelRef | null;
  keyValidated: boolean;
  fuelLevel: number | null;
  herenowLinked: boolean;
  isSpectator: boolean;
  availableRoles: RoomRole[];
}

export type ParseResult =
  | { kind: "resolved"; intent: PaletteIntent; confidence: number; label: string }
  | { kind: "candidates"; candidates: Array<{ intent: PaletteIntent; confidence: number; label: string }> }
  | { kind: "error"; hint: string };

// ---------------------------------------------------------------------------
// MVP — Sacred Objects: Task, Submission, Decision
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "draft"
  | "open"
  | "claimed"
  | "submitted"
  | "under_review"
  | "revision_requested"
  | "approved"
  | "rejected"
  | "paid"
  | "expired";

export type ProjectStatus = "draft" | "active" | "completed";

export type SubmissionStatus = "pending" | "approved" | "revision" | "rejected";

export type ReviewSessionStatus = "active" | "resolved" | "archived";

export type NotificationType =
  | "task_claimed"
  | "submission_received"
  | "revision_requested"
  | "payment_released"
  | "submission_rejected"
  | "claim_expired"
  | "verification_failed"
  | "auto_release_warning"
  | "auto_released";

/** Structured reason on every host decision. Enables analytics, fraud detection, pricing models. */
export type DecisionReason =
  | "requirements_not_met"
  | "quality_issue"
  | "scope_mismatch"
  | "missing_files"
  | "great_work"
  | "approved_fast_track";

/** Full deliverable type set. */
export type DeliverableType =
  | "file"
  | "pr"
  | "code_patch"
  | "design_asset"
  | "text"
  | "audio"
  | "video"
  | "3d_model"
  | "figma_link";

export interface Profile {
  id: string;
  display_name: string;
  role: "host" | "contributor";
  github_username: string | null;
  avatar_url: string | null;
  review_reliability: number;          // composite 0-1 score
  approval_rate: number;               // 0-1; % approved without revision_requested
  avg_revision_count: number;
  avg_response_time_minutes: number;
  total_approved: number;
  total_submitted: number;
  total_rejected: number;
}

export interface Project {
  id: string;
  host_id: string;
  title: string;
  description: string | null;
  references_urls: string[];
  template_id: string | null;
  status: ProjectStatus;
  created_at: number;
  updated_at: number;
}

export interface ProjectWallet {
  id: string;
  project_id: string;
  deposited: number;
  locked: number;
  released: number;
  created_at: number;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  payout_min: number;
  payout_max: number;
  approved_payout: number | null;
  ambiguity_score: number | null;
  estimated_minutes: number | null;
  task_access: "invite" | "public";
  status: TaskStatus;
  claimed_by: string | null;
  claimed_at: number | null;
  soft_lock_expires_at: number | null;
  submitted_at: number | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Submission {
  id: string;
  task_id: string;
  contributor_id: string;
  asset_url: string;
  deliverable_type: DeliverableType | null;
  ai_summary: string | null;
  revision_number: number;
  created_at: number;
  updated_at: number;
}

export interface Decision {
  id: string;
  submission_id: string;
  host_id: string;
  decision_reason: DecisionReason;
  review_notes: string | null;
  structured_feedback: StructuredFeedback[] | null;
  approved_payout: number | null;
  revision_deadline: number | null;
  created_at: number;
}

export interface StructuredFeedback {
  dimension: string; // 'lighting' | 'timing' | 'quality' | 'style' | 'scope'
  note: string;
}

export interface Invitation {
  id: string;
  project_id: string | null;
  task_id: string | null;
  invited_email: string | null;
  invited_user_id: string | null;
  token: string;
  accepted_at: number | null;
  expires_at: number;
  created_at: number;
}

export interface ReviewSession {
  id: string;
  task_id: string;
  submission_id: string;
  host_id: string;
  contributor_id: string | null;
  ydoc_id: string | null;
  status: ReviewSessionStatus;
  created_at: number;
  updated_at: number;
}

export interface AuditEntry {
  id: string;
  actor_id: string | null;
  task_id: string | null;
  action: string;
  payload: Record<string, unknown>;
  created_at: number;
}

export interface ReviewReliability {
  reviewReliability: number;
  approvalRate: number;
  avgRevisionCount: number;
  avgResponseTimeMinutes: number;
  totalApproved: number;
  totalSubmitted: number;
  totalRejected: number;
}

// ---------------------------------------------------------------------------
// MVP Intents
// ---------------------------------------------------------------------------

export interface ScopeProjectIntent {
  projectId: string;
  title: string;
  description: string;
  projectType: string;
  referenceUrls: string[];
  budgetRange: { min: number; max: number };
  targetTimeline?: string;
}

export interface ScopedTask {
  title: string;
  description: string;
  deliverableType: DeliverableType;
  payoutMin: number;
  payoutMax: number;
  ambiguityScore: number;        // 0-1
  estimatedMinutes: number;
  suggestedRole: string;
}

export interface ScopeProjectResult {
  tasks: ScopedTask[];           // 1-10 atomic tasks
  readmeDraft: string;            // markdown
  folderStructure: string[];      // placeholder file paths
  totalPayoutMin: number;
  totalPayoutMax: number;
  scoped?: boolean;               // true if AI succeeded; false if all retries exhausted
  warning?: string;               // present when scoped=false
}

export interface ClaimTaskIntent {
  taskId: string;
  invitationToken?: string;
}

export interface SubmitSubmissionIntent {
  taskId: string;
  assetUrl: string;
  deliverableType: DeliverableType;
}

export interface ApproveSubmissionIntent {
  submissionId: string;
  approvedPayout: number;
  decisionReason: DecisionReason;
  reviewNotes?: string;
  structuredFeedback?: StructuredFeedback[];
}

export interface RejectSubmissionIntent {
  submissionId: string;
  decisionReason: DecisionReason;
  notes: string;
  structuredFeedback?: StructuredFeedback[];
}

export interface RequestRevisionIntent {
  submissionId: string;
  decisionReason: DecisionReason;
  notes: string;
  structuredFeedback?: StructuredFeedback[];
  revisionDeadline?: Date;
}

export interface VerifySubmissionIntent {
  submissionId: string;
  assetUrl: string;
  deliverableType: DeliverableType;
}

export interface VerificationResult {
  passed: boolean;
  checks: {
    format_valid: boolean;
    size_within_limit: boolean;       // < 500MB
    not_empty: boolean;
    mime_matches_type: boolean;
    build_success?: boolean;           // code tasks only
    pr_exists?: boolean;              // pr type only
    figma_accessible?: boolean;       // figma_link type only
  };
  auto_reject: boolean;
  suggested_decision_reason?: DecisionReason;
  failure_summary?: string;
}

export type MVPIntent =
  | ScopeProjectIntent
  | ClaimTaskIntent
  | SubmitSubmissionIntent
  | ApproveSubmissionIntent
  | RejectSubmissionIntent
  | RequestRevisionIntent
  | VerifySubmissionIntent;

// ---------------------------------------------------------------------------
// Budget & Liquidity
// ---------------------------------------------------------------------------

export interface BudgetToken {
  id: string;
  roomId: RoomId;
  participantPubkey: PublicKeyBase58;
  hostPubkey: PublicKeyBase58;
  tokensGranted: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string & { readonly __brand: "Signature" };
}

export interface SubBudgetToken {
  id: string;
  roomId: RoomId;
  delegatePubkey: PublicKeyBase58;
  hostPubkey: PublicKeyBase58;
  tokensGranted: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string & { readonly __brand: "Signature" };
  /**
   * When `"handoff"`, token accompanies Y.js snapshot on relay; same structural checks as sub-budget,
   * but tokensGranted is 0 and signing may be validated when delegate first spends.
   */
  purpose?: "handoff";
}

export interface PaymentIntent {
  amount: number;
  currency: "USDC";
  destination: PublicKeyBase58;
  platformAddress: PublicKeyBase58;
  memo: string;
  split: {
    hostAmount: number;
    platformAmount: number;
    hostBasisPoints: 8000;        // 8000/10000 = 80% to host
    platformBasisPoints: 2000;    // 2000/10000 = 20% to platform
  };
  type: "entry_fee" | "tip" | "boost";
}

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

export class FFError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "FFError";
  }
}

// ---------------------------------------------------------------------------
// Crypto Helpers (Stubs/Implementations)
// ---------------------------------------------------------------------------

export async function hashOutput(output: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(output);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Phase 5 Low L10 — Chunked base64url: avoid spreading huge Uint8Arrays into
 * String.fromCharCode / fromCharCode(...chunk) (V8 ~65k arg limit on large Y.js payloads).
 */
const B64_CHUNK = 8_192;

export function base64urlEncode(data: Uint8Array): string {
  let binaryStr = "";
  for (let i = 0; i < data.length; i += B64_CHUNK) {
    const chunk = data.subarray(i, i + B64_CHUNK); // ≤8k spread args — under V8 arg ceiling
    binaryStr += String.fromCharCode(...chunk);
  }
  return btoa(binaryStr)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const binaryStr = atob(str);
  const length = binaryStr.length;
  const bytes = new Uint8Array(length);
  // Byte-by-byte fill — never `fromCharCode(...allBytes)` on megabyte snapshots
  for (let i = 0; i < length; i += B64_CHUNK) {
    const end = Math.min(i + B64_CHUNK, length);
    for (let j = i; j < end; j++) {
      bytes[j] = binaryStr.charCodeAt(j);
    }
  }
  return bytes;
}

// ─── Base58 Encoding Utilities ───────────────────────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function toBase58(bytes: Uint8Array): string {
  let leadingOnes = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingOnes++;
  }
  let num = bytes.reduce((acc, byte) => acc * 256n + BigInt(byte), 0n);
  let encoded = "";
  while (num > 0n) {
    encoded = BASE58_ALPHABET[Number(num % 58n)] + encoded;
    num /= 58n;
  }
  return "1".repeat(leadingOnes) + encoded;
}

export function fromBase58(encoded: string): Uint8Array {
  let num = 0n;
  for (const char of encoded) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value < 0) throw new Error(`Invalid Base58 character: ${char}`);
    num = num * 58n + BigInt(value);
  }
  let hex = num.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const bytes = new Uint8Array(hex.length / 2) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  let leadingOnes = 0;
  while (encoded[leadingOnes] === "1") leadingOnes++;
  const result = new Uint8Array(leadingOnes + bytes.length) as Uint8Array<ArrayBuffer>;
  result.set(bytes, leadingOnes);
  return result;
}

export function generateTokenId(): string {
  // 64 bits of entropy via Web Crypto API (collision-resistant)
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return "tkn_" + hex; // 16 hex chars = 64 bits of entropy, collision-resistant
}

export function generateTokenNonce(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

export function isBudgetToken(obj: any): obj is BudgetToken {
  return (
    obj &&
    typeof obj.id === "string" &&
    typeof obj.roomId === "string" &&
    typeof obj.participantPubkey === "string" &&
    typeof obj.hostPubkey === "string" &&
    typeof obj.tokensGranted === "number" &&
    typeof obj.issuedAt === "number" &&
    typeof obj.expiresAt === "number" &&
    typeof obj.nonce === "string" &&
    typeof obj.signature === "string"
  );
}

// ---------------------------------------------------------------------------
// Deterministic JSON for budget signatures (internal — use encodeBudgetTokenSigningMessage)
// ---------------------------------------------------------------------------

/**
 * Canonical JSON string for signing: recurse into objects and sort keys lexicographically
 * before serializing. Arrays keep element order; primitives delegate to JSON.stringify.
 * Undefined/functions/symbols in leaves follow JSON.stringify coercions (≈ null / omit rules
 * where applicable — budget payloads are flat primitives only).
 */
function deterministicJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return "[" + value.map(deterministicJSON).join(",") + "]";
  }

  const sortedKeys = Object.keys(value as object).sort();
  const pairs = sortedKeys.map(
    (k) => `${JSON.stringify(k)}:${deterministicJSON((value as Record<string, unknown>)[k])}`
  );
  return "{" + pairs.join(",") + "}";
}

/**
 * Canonical bytes for Ed25519 budget/sub-budget signing and verification.
 * L9: deterministic key order — must match on host (mint) and verifier (worker).
 */
export function encodeBudgetTokenSigningMessage(token: Omit<BudgetToken, "id" | "signature">): Uint8Array {
  return new TextEncoder().encode(deterministicJSON(token));
}

export async function assertEd25519Supported(): Promise<void> {
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  } catch {
    throw new FFError(
      "Ed25519NotSupported",
      "Your browser does not support Ed25519. Use a current version of Chrome, Firefox, or Safari."
    );
  }
}

export async function verifyBudgetToken(
  token: BudgetToken,
  options: { hostPubkeyFromDoc: PublicKeyBase58; seenNonces: Set<string> }
): Promise<{ tokensGranted: number }> {
  // 1. Structural Validation
  if (token.hostPubkey !== options.hostPubkeyFromDoc) {
    throw new FFError("BudgetTokenForged", "Host pubkey mismatch");
  }
  if (options.seenNonces.has(token.nonce)) {
    throw new FFError("BudgetTokenReplayed", "Token nonce already seen");
  }
  if (Date.now() > token.expiresAt) {
    throw new FFError("BudgetTokenExpired", "Token has expired");
  }

  // 2. Cryptographic Verification
  const message = encodeBudgetTokenSigningMessage({
    roomId: token.roomId,
    participantPubkey: token.participantPubkey,
    hostPubkey: token.hostPubkey,
    tokensGranted: token.tokensGranted,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
    nonce: token.nonce,
  });

  const sigBytes = base64urlDecode(token.signature);

  // Wrap decoding — fromBase58 throws a plain Error on invalid input which must not
  // escape as a potentially revealing exception; re-throw as a typed FFError.
  let pubKeyBytes: Uint8Array;
  try {
    pubKeyBytes = fromBase58(token.hostPubkey);
  } catch {
    throw new FFError("BudgetTokenForged", "Invalid base58 encoding in host pubkey");
  }

  // Ed25519 public keys are always 32 bytes
  if (pubKeyBytes.length !== 32) throw new FFError("BudgetTokenForged", "Invalid public key length");

  const pubKey = await crypto.subtle.importKey(
    "raw",
    pubKeyBytes.buffer as ArrayBuffer,
    { name: "Ed25519" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "Ed25519",
    pubKey,
    sigBytes.buffer as ArrayBuffer,
    message.buffer as ArrayBuffer
  );
  if (!valid) {
    throw new FFError("BudgetTokenForged", "Signature verification failed");
  }

  // 3. Prevent replay (session-scoped Set here; worker persists nonces in IndexedDB — budget.ts)
  options.seenNonces.add(token.nonce);
  return { tokensGranted: token.tokensGranted };
}
