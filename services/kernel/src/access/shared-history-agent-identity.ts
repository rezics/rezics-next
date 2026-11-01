import type { Pool } from 'pg';
import {
  readAgentIdentityCopyReceiving,
  type AgentIdentitySourceKey,
} from '../history/agent-identity-source.ts';
import {
  readAgentIdentityInventory,
  verifyAgentIdentityInventory,
  type AgentIdentityInventoryVerification,
} from '../history/agent-identity-inventory.ts';
import { readAgentIdentitySDKRetirementGap } from '../history/agent-identity-retirement.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import type { CommandTransaction } from '../command/command.ts';
import { verifyHistoryReceivingReceipt } from '../history/receiving.ts';

export type AgentIdentityCopyRetentionPending = Readonly<{
  state: 'pending';
  gaps: readonly string[];
  native?: 'pending' | 'verified';
}>;
export type PreparedAgentIdentityCopy = Awaited<ReturnType<typeof readAgentIdentityCopyReceiving>> & Readonly<{
  inventory: Awaited<ReturnType<typeof readAgentIdentityInventory>>;
  sdkGap: string;
}>;

/** Without a native inventory read, coverage is unknown. Once staged, report the original
 * owner's exact current branch; neither a point association nor an SDK mapping seals it.
 */
export function agentIdentityCopyRetention(
  copy?: PreparedAgentIdentityCopy,
  verified?: AgentIdentityInventoryVerification,
): AgentIdentityCopyRetentionPending {
  return Object.freeze({
    state: 'pending',
    gaps: Object.freeze(copy
      ? [...new Set([verified?.gap ?? copy.inventory.gap, copy.sdkGap])]
      : ['agent-identity-original-inventory-unsealed', 'agent-identity-sdk-recording-port-unavailable']),
    ...(verified ? { native: verified.native } : {}),
  });
}

/** Released owner probes only. Preserve the historical point lookup while independently
 * staging the real finite native cut (at most three copies) and the actual SDK branch.
 * Every owner releases its checkout before reading a receiving home.
 */
export async function prepareAgentIdentityCopyRetention(
  pool: Pool,
  barrier: HistoryBarrier,
  key: AgentIdentitySourceKey,
  deadline: number,
): Promise<PreparedAgentIdentityCopy> {
  const point = await readAgentIdentityCopyReceiving({ pool }, barrier, [key], { deadline });
  const inventory = await readAgentIdentityInventory({ pool }, barrier, key, { deadline });
  const sdkGap = await readAgentIdentitySDKRetirementGap(pool, {
    kind: key.direction, account: key.accountId, receipt: key.receiptId,
  }, { deadline });
  return { ...point, inventory, sdkGap };
}

/** A point receipt is independent of complete inventory custody. */
export async function verifyAgentIdentityCopyRetention(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  copy: PreparedAgentIdentityCopy,
): Promise<boolean> {
  return copy.artifact !== null && copy.receipt !== null &&
    await verifyHistoryReceivingReceipt(tx, barrier, copy.artifact, copy.receipt);
}

/** SAME original source-home command. The original inventory owner rechecks generation,
 * all native role/receiving/physical rows and SDK obligation. Its current result remains
 * pending even when native copies verify: it has no positive all-SDK-custody declaration.
 */
export async function verifyAgentIdentityCopyInventory(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  key: AgentIdentitySourceKey,
  copy: PreparedAgentIdentityCopy,
): Promise<AgentIdentityInventoryVerification> {
  if (!copy.inventory.proof)
    return { state: 'pending', native: 'pending', gap: copy.inventory.gap };
  return verifyAgentIdentityInventory(tx, barrier, key, copy.inventory.proof);
}
