import type { PublicKeyBase58 } from "@fatedfortress/protocol";
import type { BudgetToken } from "@fatedfortress/protocol";
import {
  mintBudgetToken,
  verifyAndConsumeToken,
  initQuota,
  getFuelGaugeState,
  teardownBudget,
  type FuelGaugeState,
} from "./budget.js";
import { getSigningKey } from "./keystore.js";

export async function mintToken(
  roomId: string,
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

export async function verifyToken(
  token: unknown,
  hostPubkey: PublicKeyBase58,
  roomId: string
): Promise<number> {
  return verifyAndConsumeToken(token, hostPubkey, roomId);
}

export function initRoomQuota(roomId: string, quotaPerUser: number): void {
  initQuota(roomId, quotaPerUser);
}

export function getFuelState(roomId: string): FuelGaugeState {
  return getFuelGaugeState(roomId);
}

export function teardownLiquidity(): void {
  teardownBudget();
}
