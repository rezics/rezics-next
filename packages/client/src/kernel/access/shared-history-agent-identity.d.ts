import type { WorkClient } from '../work/client.ts';
import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import { readAgentIdentityCopyReceiving, readAgentIdentityInventory, readAgentIdentityRecoveryInventory } from '../history/application/index.ts';
import { type AgentIdentityInventoryVerification, type AgentIdentityRecoveryInventoryVerification, type AgentIdentityRetirementStage, type AgentIdentitySourceKey, type HistoryArtifact, type HistoryBarrier, type HistoryReceivingContext } from '../history/contract/index.ts';
export type AgentIdentityCopyRetention = Readonly<{
    state: 'pending';
    gaps: readonly string[];
    native?: 'pending' | 'verified';
}> | Readonly<{
    state: 'received';
    gaps: readonly [];
    native: 'verified';
}>;
export type PreparedAgentIdentityCopy = Awaited<ReturnType<typeof readAgentIdentityCopyReceiving>> & Readonly<{
    inventory: Awaited<ReturnType<typeof readAgentIdentityInventory>>;
    recoveryInventory: Awaited<ReturnType<typeof readAgentIdentityRecoveryInventory>>;
    sdkGap: string | null;
    durable: HistoryArtifact | null;
}>;
/** Without a native inventory read, coverage is unknown. Once staged, report the original
 * owner's exact current branch; neither a point association nor an SDK mapping seals it.
 */
export declare function agentIdentityCopyRetention(copy?: PreparedAgentIdentityCopy, verified?: AgentIdentityInventoryVerification, recoveryVerified?: AgentIdentityRecoveryInventoryVerification): AgentIdentityCopyRetention;
/** Released owner probes only. Preserve the historical point lookup while independently
 * staging the real finite native cut (at most three copies) and the actual SDK branch.
 * Every owner releases its checkout before reading a receiving home.
 */
export declare function prepareAgentIdentityCopyRetention(pool: Pool, barrier: HistoryBarrier, key: AgentIdentitySourceKey, deadline: number, receiving?: Readonly<{
    client: WorkClient;
    context: HistoryReceivingContext;
}>): Promise<PreparedAgentIdentityCopy>;
/** Recovery has no SDK handoff. It still has an exact current two-copy receiver cut. */
export declare function verifyAgentIdentityRecoveryCopyInventory(tx: CommandTransaction, barrier: HistoryBarrier, key: AgentIdentitySourceKey, copy: PreparedAgentIdentityCopy): Promise<AgentIdentityRecoveryInventoryVerification>;
/** A point receipt is independent of complete inventory custody. */
export declare function verifyAgentIdentityCopyRetention(tx: CommandTransaction, barrier: HistoryBarrier, copy: PreparedAgentIdentityCopy): Promise<boolean>;
/** SAME original source-home command. The original inventory owner rechecks generation,
 * all native role/receiving/physical rows and SDK obligation. It reuses the original current Source/SDK guard and the actual durable-work receiving association.
 */
export declare function verifyAgentIdentityCopyInventory(tx: CommandTransaction, barrier: HistoryBarrier, key: AgentIdentitySourceKey, copy: PreparedAgentIdentityCopy, stage?: AgentIdentityRetirementStage, client?: WorkClient): Promise<AgentIdentityInventoryVerification>;
