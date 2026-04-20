/**
 * liquidity.ts — Thin façade: budget.ts + keystore signing key for router handlers.
 * Keeps router imports stable; real logic remains in budget.ts / keystore.ts.
 */
import type { PublicKeyBase58, RoomId } from "@fatedfortress/protocol";
import type { BudgetToken, SubBudgetToken } from "@fatedfortress/protocol";
import {
  mintBudgetToken,
  verifyAndConsumeToken,
  mintSubBudgetTokenForRoom,
  verifyAndConsumeSubBudgetToken,
  initQuota,
  getFuelGaugeState,
  teardownBudget,
  revokeSubBudgetDelegation as revokeDelegationCore,
  isDelegationRevoked as isDelegationRevokedCore,
  type FuelGaugeState,
} from "./budget.js";
import { getSigningKey } from "./keystore.js";

export async function mintToken(
  roomId: RoomId,
  participantPubkey: PublicKeyBase58,
  tokensToGrant: number
): Promise<BudgetToken | null> {
  const hostSigningKey = await getSigningKey();
  return mintBudgetToken({
    roomId,
    participantPubkey,
    hostPubkey: hostSigningKey.publicKeyBase58,
    hostSigningKey: hostSigningKey.privateKey,
    tokensToGrant,
  });
}

export async function mintSubBudgetToken(
  delegatePubkey: PublicKeyBase58,
  roomId: RoomId,
  tokensToGrant: number
): Promise<SubBudgetToken> {
  const hostSigningKey = await getSigningKey();
  return mintSubBudgetTokenForRoom(
    hostSigningKey.privateKey,
    hostSigningKey.publicKeyBase58,
    delegatePubkey,
    roomId,
    tokensToGrant
  );
}

export async function verifyToken(
  token: unknown,
  hostPubkey: PublicKeyBase58,
  roomId: string
): Promise<number> {
  return verifyAndConsumeToken(token, hostPubkey, roomId);
}

export async function verifySubBudgetToken(
  token: unknown,
  hostPubkey: PublicKeyBase58,
  roomId: string
): Promise<number> {
  return verifyAndConsumeSubBudgetToken(token, hostPubkey, roomId);
}

export function initRoomQuota(roomId: string, quotaPerUser: number): void {
  initQuota(roomId, quotaPerUser);
}

export function getFuelState(roomId: string): FuelGaugeState {
  return getFuelGaugeState(roomId);
}

export async function teardownLiquidity(): Promise<void> {
  await teardownBudget();
}

export function revokeSubBudgetDelegation(delegatePubkey: PublicKeyBase58): void {
  revokeDelegationCore(delegatePubkey);
}

export function isDelegationRevoked(delegatePubkey: PublicKeyBase58): boolean {
  return isDelegationRevokedCore(delegatePubkey);
}
