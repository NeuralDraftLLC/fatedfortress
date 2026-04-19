/**
 * packages/protocol/src/index.ts — Shared types for FatedFortress.
 *
 * Re-exported from: @fatedfortress/protocol
 * Consumed by: apps/web, apps/worker, apps/relay
 *
 * Types:
 *   RoomId, ReceiptId, RoomCategory, RoomAccess
 *   PaletteIntent, PaletteContext, ParseResult
 *   BudgetToken, PaymentIntent
 *   PublicKeyBase58
 *   ProviderId
 *
 * Crypto helpers:
 *   FFError (error class with code + message)
 *   hashOutput(output: string): Promise<string>
 *   base64urlEncode / base64urlDecode
 *   verifyBudgetToken / generateTokenId / generateTokenNonce
 *   encodeBudgetTokenSigningMessage / isBudgetToken
 *   BUDGET_TOKEN_TTL_MS
 *
 * Constants:
 *   FF_ORIGIN, PROVIDER_ALLOWLIST
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

export type RoomAccess = "free" | "paid";

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
  | { type: "help"; command: string | null };

export interface PaletteContext {
  currentPage: "table" | "room" | "connect" | "me";
  currentRoomId: RoomId | null;
  currentRoomAccess: RoomAccess | null;
  focusedReceiptId: ReceiptId | null;
  currentModel: ModelRef | null;
  keyValidated: boolean;
  fuelLevel: number | null;
  herenowLinked: boolean;
}

export type ParseResult =
  | { kind: "resolved"; intent: PaletteIntent; confidence: number; label: string }
  | { kind: "candidates"; candidates: Array<{ intent: PaletteIntent; confidence: number; label: string }> }
  | { kind: "error"; hint: string };

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

export interface PaymentIntent {
  amount: number;
  currency: "USDC";
  destination: PublicKeyBase58;
  memo: string;
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

export function base64urlEncode(data: Uint8Array): string {
  let base64 = btoa(String.fromCharCode(...data));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function generateTokenId(): string {
  return "tkn_" + Math.random().toString(36).slice(2, 10);
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

export function encodeBudgetTokenSigningMessage(token: Omit<BudgetToken, "id" | "signature">): Uint8Array {
  const s = JSON.stringify(token);
  return new TextEncoder().encode(s);
}

export async function verifyBudgetToken(
  token: BudgetToken,
  options: { hostPubkeyFromDoc: PublicKeyBase58; seenNonces: Set<string> }
): Promise<{ tokensGranted: number }> {
  // Stub implementation: verify that hostPubkey matches the doc and nonce is new
  if (token.hostPubkey !== options.hostPubkeyFromDoc) {
    throw new FFError("BudgetTokenForged", "Host pubkey mismatch");
  }
  if (options.seenNonces.has(token.nonce)) {
    throw new FFError("BudgetTokenReplayed", "Token nonce already seen");
  }
  if (Date.now() > token.expiresAt) {
    throw new FFError("BudgetTokenExpired", "Token has expired");
  }
  // Real implementation would use crypto.subtle.verify here
  options.seenNonces.add(token.nonce);
  return { tokensGranted: token.tokensGranted };
}
