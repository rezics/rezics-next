import type { WorkClient } from '../work/client.ts';
import type { AgentIdentityRetirementStage } from '../history/agent-identity-retirement.ts';
import type { HistoryReceivingContext } from '../history/receiving.ts';
import { lookupAgentIdentityReceivingCopies } from '../history/agent-identity-source.ts';
import type { HistoryArtifact } from '../history/registry.ts';
import { reserveIdentityHistoryWork, nativeWork } from '../history/agent-identity-inventory-work.ts';
import type { Pool } from 'pg';
import { readAgentIdentityCopyReceiving, type AgentIdentitySourceKey } from '../history/agent-identity-source.ts';
import {
  readAgentIdentityInventory,
  readAgentIdentityRecoveryInventoryInTransaction,
  readAgentIdentityRecoveryInventory,
  verifyAgentIdentityInventory,
  verifyAgentIdentityRecoveryInventory,
  type AgentIdentityInventoryVerification,
  type AgentIdentityRecoveryInventoryVerification,
} from '../history/agent-identity-inventory.ts';
import { readAgentIdentitySDKRetirementGap } from '../history/agent-identity-retirement.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import { currentCommandResources, type CommandTransaction } from '../command/command.ts';
import { verifyHistoryReceivingReceipt } from '../history/receiving.ts';

export type AgentIdentityCopyRetention =
  | Readonly<{
      state: 'pending';
      gaps: readonly string[];
      native?: 'pending' | 'verified';
    }>
  | Readonly<{ state: 'received'; gaps: readonly []; native: 'verified' }>;
export type PreparedAgentIdentityCopy = Awaited<ReturnType<typeof readAgentIdentityCopyReceiving>> &
  Readonly<{
    inventory: Awaited<ReturnType<typeof readAgentIdentityInventory>>;
    recoveryInventory: Awaited<ReturnType<typeof readAgentIdentityRecoveryInventory>>;
    sdkGap: string | null;
    durable: HistoryArtifact | null;
  }>;

/** Without a native inventory read, coverage is unknown. Once staged, report the original
 * owner's exact current branch; neither a point association nor an SDK mapping seals it.
 */
export function agentIdentityCopyRetention(
  copy?: PreparedAgentIdentityCopy,
  verified?: AgentIdentityInventoryVerification,
  recoveryVerified?: AgentIdentityRecoveryInventoryVerification,
): AgentIdentityCopyRetention {
  const gaps = copy
    ? [
        ...new Set(
          [
            verified ? verified.gap : copy.inventory.gap,
            verified?.state === 'verified' ? null : copy.sdkGap,
            copy.recoveryInventory.state === 'pending' ? copy.recoveryInventory.gap : null,
            copy.recoveryInventory.state === 'sealed'
              ? recoveryVerified?.state === 'verified'
                ? null
                : (recoveryVerified?.gap ?? 'agent-identity-recovery-receiving-pending')
              : null,
          ].filter((gap): gap is string => gap !== null),
        ),
      ]
    : ['agent-identity-original-inventory-unsealed', 'agent-identity-sdk-recording-port-unavailable'];
  if (gaps.length === 0)
    return Object.freeze({
      state: 'received',
      gaps: Object.freeze([]) as readonly [],
      native: 'verified',
    });
  return Object.freeze({
    state: 'pending',
    gaps: Object.freeze(gaps),
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
  receiving?: Readonly<{
    client: WorkClient;
    context: HistoryReceivingContext;
  }>,
): Promise<PreparedAgentIdentityCopy> {
  const context = receiving?.context ?? { deadline };
  await reserveIdentityHistoryWork(pool, nativeWork(270, 270, 12, 90112), context);
  const point = await readAgentIdentityCopyReceiving({ pool }, barrier, [key], {
    deadline,
  });
  const inventory = await readAgentIdentityInventory(
    { pool, ...(receiving ? { client: receiving.client } : {}) },
    barrier,
    key,
    context,
  );
  const recoveryInventory = await readAgentIdentityRecoveryInventory({ pool }, barrier, key, context);
  const sdkGap = receiving
    ? inventory.gap
    : await readAgentIdentitySDKRetirementGap(
        pool,
        {
          kind: key.direction,
          account: key.accountId,
          receipt: key.receiptId,
        },
        context,
      );
  await reserveIdentityHistoryWork(pool, nativeWork(80, 80, 12, 32768), context);
  const [lookup] = await lookupAgentIdentityReceivingCopies(pool, [
    { kind: key.direction, account: key.accountId, receipt: key.receiptId },
  ]);
  // The original lookup supplies an address, not the retained physical role union.
  // Resolve the actual immutable mapping and complete locator inventory separately.
  const custodyId =
    lookup?.state === 'associated' && lookup.artifact.locator.artifactType === 'durable-work/v1'
      ? lookup.artifact.locator.workId
      : null;
  const { readAgentIdentityReceivingArtifact } = await import('../history/agent-identity-sdk-fence.ts');
  const durable = custodyId ? await readAgentIdentityReceivingArtifact(pool, custodyId, context) : null;
  return {
    ...point,
    inventory,
    recoveryInventory,
    sdkGap,
    durable,
  };
}

/** Recovery has no SDK handoff. It still has an exact current two-copy receiver cut. */
export async function verifyAgentIdentityRecoveryCopyInventory(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  key: AgentIdentitySourceKey,
  copy: PreparedAgentIdentityCopy,
): Promise<AgentIdentityRecoveryInventoryVerification> {
  if (copy.recoveryInventory.state === 'absent') {
    // A released absence snapshot is not final authority. The source/root transaction
    // re-reads the exact recovery key while holding its native source locks through COMMIT.
    const resources = currentCommandResources(tx);
    await reserveIdentityHistoryWork(resources.pool, nativeWork(2, 2, 1, 512), {
      deadline: resources.deadline,
    });
    const current = await readAgentIdentityRecoveryInventoryInTransaction(tx, key);
    return current.state === 'absent'
      ? { state: 'verified', native: 'verified', gap: null }
      : {
          state: 'pending',
          native: current.native === 'sealed' ? 'verified' : 'pending',
          gap: current.gap ?? 'agent-identity-recovery-copy-cut-changed',
        };
  }
  if (copy.recoveryInventory.state !== 'sealed' || !copy.recoveryInventory.proof)
    return {
      state: 'pending',
      native: copy.recoveryInventory.native === 'sealed' ? 'verified' : 'pending',
      gap: copy.recoveryInventory.gap,
    };
  return verifyAgentIdentityRecoveryInventory(
    tx,
    barrier,
    key,
    copy.recoveryInventory.proof,
    copy.recoveryInventory.receipts,
  );
}

/** A point receipt is independent of complete inventory custody. */
export async function verifyAgentIdentityCopyRetention(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  copy: PreparedAgentIdentityCopy,
): Promise<boolean> {
  return (
    copy.artifact !== null &&
    copy.receipt !== null &&
    (await verifyHistoryReceivingReceipt(tx, barrier, copy.artifact, copy.receipt))
  );
}

/** SAME original source-home command. The original inventory owner rechecks generation,
 * all native role/receiving/physical rows and SDK obligation. It reuses the original current Source/SDK guard and the actual durable-work receiving association.
 */
export async function verifyAgentIdentityCopyInventory(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  key: AgentIdentitySourceKey,
  copy: PreparedAgentIdentityCopy,
  stage?: AgentIdentityRetirementStage,
  client?: WorkClient,
): Promise<AgentIdentityInventoryVerification> {
  if (!copy.inventory.proof) return { state: 'pending', native: 'pending', gap: copy.inventory.gap };
  return verifyAgentIdentityInventory(
    tx,
    barrier,
    key,
    copy.inventory.proof,
    stage,
    client && copy.durable ? { client, artifact: copy.durable } : undefined,
  );
}
