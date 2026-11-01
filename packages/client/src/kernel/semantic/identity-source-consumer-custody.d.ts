import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import type { IdentityJobRef, IdentityNativeReceipt, IdentityReceipt, NativeStepWork } from './identity-epoch-contract.ts';
import type { WorkAllowance } from '../library/collection-source.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import type { AgentIdentityRetirementStage } from '../history/agent-identity-retirement.ts';
import type { AgentIdentitySDKReceivingBinding } from '../history/agent-identity-sdk-fence.ts';
import { type SdkWriterState } from '../work/sdk-retirement-fence.ts';
import type { IdentitySourceConsumerMaintenanceWork } from './identity-source-consumer-maintenance.ts';
export type IdentitySourceConsumerReference = Readonly<{
    receipt: Exclude<IdentityReceipt, {
        kind: 'subject.merge';
    }>;
    job: IdentityJobRef;
    source: IdentityNativeReceipt;
    sourceDigest: string;
    barrier: HistoryBarrier;
    /** subject is the original source key's account, distinct from requester/decider. */
    erasedRole: 'subject' | 'requester' | 'decider';
}>;
declare const identitySourceConsumerCustody: unique symbol;
export type IdentitySourceConsumerCustody = Readonly<{
    [identitySourceConsumerCustody]: true;
}>;
/** Required additive owner exchange, not a caller proof or an installed adapter. Native
 * implementations must resolve these generations from the original accepted input. */
export type IdentitySourceConsumerGeneration = Readonly<{
    replayGeneration: string;
    undoGeneration: string;
    restoreGeneration: string;
}>;
export type IdentitySourceConsumerWork = IdentitySourceConsumerGeneration & Readonly<{
    allowance: NativeStepWork;
}>;
export type IdentitySourceConsumerContext = Readonly<{
    deadline: number;
    identityConsumerWork?: IdentitySourceConsumerMaintenanceWork;
}>;
export type IdentitySourceConsumerDisposition = 'discharged' | 'transferred';
export type IdentitySourceScopeConsumerWork = Readonly<{
    allowance: WorkAllowance;
    /** Native owners provide proved SQL bounds. Unknown SQL must be refused before dispatch. */
    footprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
}>;
/** Prepare retained native custody, then advance one exhaustive consumer-cut step. Missing
 * native fences or technical receiving authority leave the original bytes retained. */
export declare function readIdentitySourceConsumerCustody(pool: Pool, reference: IdentitySourceConsumerReference, context: IdentitySourceConsumerContext): Promise<IdentitySourceConsumerCustody | null>;
/** Original 4/4/6/8192 reservation plus 96/96/16/131072 for the complete
 * nested Source verifier. Reserve here, rather than only in the History wrapper:
 * initial staging, post-commit reconstruction and independent History checks also
 * invoke this verifier. Subject Account settlement reserves separately in its owner. */
export declare const IDENTITY_SOURCE_CONSUMER_VERIFY_COST: NativeStepWork;
/** Same genuine live original-home command, fixed indexed points, no foreign checkout. */
export declare function verifyIdentitySourceConsumerCustody(tx: CommandTransaction, reference: IdentitySourceConsumerReference, proof: IdentitySourceConsumerCustody): Promise<boolean>;
type HistoryNativeLocator = Omit<IdentityNativeReceipt, 'position'> & Readonly<{
    position: string;
}>;
export type IdentitySourceHistoryReference = Omit<IdentitySourceConsumerReference, 'source' | 'job'> & Readonly<{
    source: HistoryNativeLocator;
    job: Readonly<{
        jobId: string;
        epoch: string;
    }>;
}>;
/** Persistable address of original Source authority, never a portable certificate.
 * The native consumer must resolve this SAME original row through the Source function
 * on every guarded transition, including the later receiving commit. */
export type IdentitySourceHistoryAuthority = Readonly<{
    kind: 'identity-source-history-guard/v1';
    custody: string;
    sequence: string;
    reference: IdentitySourceHistoryReference;
    generation: IdentitySourceConsumerGeneration;
    disposition: IdentitySourceConsumerDisposition;
    terminal: HistoryNativeLocator;
    receiving: HistoryNativeLocator | null;
}>;
/** Outer SELECT, fifteen exact native keyed inputs, and the returned native tuple.
 * There are two SQL statements: the outer SELECT and the function's joined SELECT.
 * PL/pgSQL comparisons/RETURN dispatch no SQL and this read fires no row triggers. */
export declare const IDENTITY_SOURCE_HISTORY_GUARD_COST: NativeStepWork;
export declare const IDENTITY_SOURCE_HISTORY_RECHECK_COST: NativeStepWork;
export declare const IDENTITY_SOURCE_HISTORY_RECEIVER_COST: NativeStepWork;
export type IdentitySourceHistoryHandoff = Readonly<{
    phase: 'readiness' | 'closure';
    sourceAuthority: IdentitySourceHistoryAuthority;
    binding: AgentIdentitySDKReceivingBinding;
    writer: SdkWriterState;
}>;
export type IdentitySourceHistoryHandoffResult = Readonly<{
    state: 'pending';
    gap: string;
}> | Readonly<{
    state: 'guarded';
    handoff: IdentitySourceHistoryHandoff;
}>;
/** Resolve durable ORIGINAL Source state, not a copied terminal receipt. This same
 * function is the supported native Source half of History's installed row guard:
 * semantic.lock_identity_source_history_handoff(reference, expectedAuthority).
 * It locks original custody, current binding/generations and native enrollment until
 * COMMIT. It does not supply Account verification, SDK closure or History readiness. */
export declare function lockIdentitySourceHistoryAuthority(tx: CommandTransaction, reference: IdentitySourceConsumerReference, expected?: IdentitySourceHistoryAuthority | null): Promise<IdentitySourceHistoryAuthority | null>;
/** Default owner composition on the genuine original Source command. Both phases
 * re-run native History/Source/Account verification and exact receiving admission,
 * then lock the actual SDK state on this SAME command. No foreign SQL, callbacks,
 * fresh frame, SDK retirement or History state mutation is substituted here.
 *
 * History owns persisting distinct guarded readiness/closure transitions. Its native
 * row guard must consume the Source function with the stored exact authority AND
 * its own current association, barrier, receiver and SDK prerequisites. Returning
 * this locator cannot authorize a later write by itself. */
export declare function lockIdentitySourceHistoryHandoff(tx: CommandTransaction, stage: AgentIdentityRetirementStage, binding: AgentIdentitySDKReceivingBinding, expectedWriter: SdkWriterState, phase: 'readiness' | 'closure', sdk: DBOSClient): Promise<IdentitySourceHistoryHandoffResult>;
export {};
