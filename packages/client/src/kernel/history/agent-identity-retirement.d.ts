import type { IdentitySourceConsumerCustody, IdentitySourceConsumerReference } from '../semantic/identity-source-consumer-custody.ts';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { WorkClient } from '../work/client.ts';
import { type CommandTransaction } from '../command/command.ts';
import { type AgentIdentityWorkSource } from './agent-identity-source.ts';
import { type AgentIdentitySDKRetirementReceipt } from './agent-identity-sdk-fence.ts';
import { type HistoryReceivingContext } from './receiving.ts';
import type { HistoryArtifact, HistoryBarrier, HistoryReadiness } from './registry.ts';
import type { AgentIdentityOriginal } from './agent-identity-inventory.ts';
import type { HistoryOriginalDependencies, IdentityOriginalSourceContext, PrepaidAgentIdentityHistoryUnit } from '../access/identity-original-admission.ts';
export type { IdentitySourceConsumerMaintenanceWork, IdentitySourceConsumerMaintenanceContext, } from '../semantic/identity-source-consumer-maintenance.ts';
export type IdentitySourceConsumerMaintenanceModule = Pick<typeof import('../semantic/identity-source-consumer-maintenance.ts'), 'withIdentitySourceConsumerMaintenance'>;
/** Released foreign staging is not cleanup authority. The receiving owner must verify
 * the original source and its native terminal transfer before settling its obligation. */
export type AgentIdentityRetirementStage = Readonly<{
    handoff: Readonly<{
        custodyId: string;
        source: AgentIdentityWorkSource;
        generation: string;
    }>;
    reference: IdentitySourceConsumerReference;
    consumer: IdentitySourceConsumerCustody | null;
}>;
export type AgentIdentityRetirementResult = Readonly<{
    state: 'pending';
    gap: string;
}> | Readonly<{
    state: 'verified';
    gap: null;
    custodyId: string;
    workflowId: string;
}>;
/** Semantic terminal custody and the SDK writer fence are separate prerequisites to
 * retiring the retained receiving work. */
export declare const AGENT_IDENTITY_SDK_RETIREMENT: Readonly<{
    readonly sdkVersion: '5.5.3-preview';
    readonly futureWriters: 'native-sdk-fence-requires-source-transfer';
    readonly gap: "identity-source-terminal-transfer-unavailable";
}>;
export declare const IDENTITY_SOURCE_MAINTENANCE_UNAVAILABLE = "identity-source-maintenance-funding-unavailable";
export declare const IDENTITY_SOURCE_PREPAID_MAINTENANCE_UNAVAILABLE = "identity-source-prepaid-maintenance-not-installed";
export { IDENTITY_HISTORY_HANDOFF_UNAVAILABLE } from './agent-identity-sdk-fence.ts';
/** One selected native identity unit, after the scheduler has released its job checkout.
 * Only the actual Source runtime export may enter this callback. Its frame spans the
 * released receiver/source/accepted-job reads, Source staging and final native verifier.
 * Neither this entry nor its opaque funding grants any retirement/SDK authority. */
export declare function advanceAgentIdentityConsumerMaintenance(deps: Readonly<{
    pool: Pool;
    client: WorkClient;
    env: Readonly<Record<string, string | undefined>>;
    clock?: KernelClock;
}>, artifact: HistoryArtifact, barrier: HistoryBarrier, context: HistoryReceivingContext): Promise<string | null>;
type IdentityUnit = {
    context: HistoryReceivingContext;
    stage?: AgentIdentityRetirementStage;
    client?: WorkClient;
    active: boolean;
    prepaid?: Readonly<{
        deps: HistoryOriginalDependencies;
        parent: IdentityOriginalSourceContext;
        owner: Pick<typeof import('../semantic/identity-source-consumer-maintenance.ts'), 'isLiveIdentitySourceConsumerMaintenance' | 'identitySourceConsumerLibraryWork'>;
    }>;
    failure?: Error;
};
export declare function currentAgentIdentityHistoryUnit(): Readonly<IdentityUnit> | undefined;
/** Validate the exact callback context, actual Pool/client and original lifetime.
 * A deadline-only native command may inherit this frame; a copied explicit token
 * context cannot replace the producer callback's object. */
export declare function assertAgentIdentityHistoryUnit(pool: Pool, context?: HistoryReceivingContext, client?: WorkClient): void;
export declare const withPrepaidAgentIdentityHistoryUnit: PrepaidAgentIdentityHistoryUnit;
/** The default scheduler enters this AFTER selection releases its checkout. The only
 * Source frame and deadline survive physical cleanup and the final receiving COMMIT. */
export declare function withAgentIdentityHistoryUnit<T>(deps: Readonly<{
    pool: Pool;
    env: Readonly<Record<string, string | undefined>>;
    clock?: KernelClock;
    client?: WorkClient;
}>, context: HistoryReceivingContext, body: (funded: HistoryReceivingContext) => Promise<T>): Promise<T>;
/** Stage only on RELEASED checkouts. Semantic performs its own exact accepted-job,
 * publication and consumer-cut probes; no receiver/source transaction is held during them.
 * An unavailable or incomplete native cut remains null and retains every byte. */
export declare function readAgentIdentityRetirementStage(pool: Pool, reference: IdentitySourceConsumerReference, context: HistoryReceivingContext): Promise<AgentIdentityRetirementStage | null>;
/** Foreign staging cannot grant source retirement. Recheck its exact barrier, source
 * generation/restore/writer and native Semantic terminal receipt in this SAME source
 * transaction. No foreign reads occur here. SDK writer retirement remains separate. */
export declare function verifyAgentIdentityRetirementStage(tx: CommandTransaction, stage: AgentIdentityRetirementStage): Promise<AgentIdentityRetirementResult>;
/** Receiver-local preconditions only. A durable SDK receipt is recorded only after Semantic
 * terminal custody has been verified on the original source home and the SDK writer fence
 * has been installed. This check makes no foreign reads. */
export declare function agentIdentityRetirementReadiness(tx: CommandTransaction, artifact: HistoryArtifact, barrier: HistoryBarrier): Promise<HistoryReadiness>;
/** Released SDK receiving observation for inventory presentation. It cannot be used in the
 * source transaction as a certificate. Old executions remain explicitly uncovered. */
export declare function readAgentIdentitySDKRetirementGap(pool: Pool, receipt: IdentitySourceConsumerReference['receipt'], context: HistoryReceivingContext, receiving?: Readonly<{
    client: WorkClient;
    original: AgentIdentityOriginal;
    barrier: HistoryBarrier;
}>): Promise<string | null>;
export type AgentIdentitySDKRetirementObservation = Readonly<{
    state: 'pending';
    gap: string;
}> | Readonly<{
    state: 'received';
    gap: null;
    receipt: AgentIdentitySDKRetirementReceipt;
}>;
/** Exact released observation of ONE original SDK receiving copy. The native SDK is
 * independently re-read before and after the ordinary physical receiving proof. This is
 * not a certificate for a later source command, a Source disposition or an Account root. */
export declare function readAgentIdentitySDKRetirement(pool: Pool, client: WorkClient, original: AgentIdentityOriginal, barrier: HistoryBarrier, context: HistoryReceivingContext): Promise<AgentIdentitySDKRetirementObservation>;
export { IDENTITY_HISTORY_ACCOUNTS_DECLARATION } from './agent-identity-inventory-work.ts';
