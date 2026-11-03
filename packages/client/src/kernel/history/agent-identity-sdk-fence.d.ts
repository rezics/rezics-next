import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import { type WorkClient } from '../work/client.ts';
import { type SdkRetirementFence as WorkflowWriterFence, type SdkWriterState } from '../work/sdk-retirement-fence.ts';
import type { AgentIdentityWorkSource } from './agent-identity-source.ts';
import type { AgentIdentityRetirementStage } from './agent-identity-retirement.ts';
import { type HistoryReceivingContext } from './receiving.ts';
import type { HistoryArtifact, HistoryBarrier } from './registry.ts';
/** Published producer vocabulary. Availability is checked on the genuine runtime client;
 * a source declaration does not prove migration coverage or grant source discharge. */
export declare const AGENT_IDENTITY_SDK_FENCE_CONSUMER: Readonly<{
    readonly binding: 'access.agent-identity.sdk-retirement/v1';
    readonly nativeAPI: readonly ["retireWorkflow", "getWorkflowWriterFence"];
    readonly nativeReceipt: readonly ["workflowID", "generation", "closureID", "closedAt"];
    readonly gap: 'identity-source-terminal-transfer-unavailable';
}>;
/** Exact receiving request binding. This is metadata, never cleanup permission. */
export type AgentIdentitySDKReceivingBinding = Readonly<{
    kind: typeof AGENT_IDENTITY_SDK_FENCE_CONSUMER.binding;
    custodyId: string;
    workflowId: string;
    requestDigest: string;
    source: AgentIdentityWorkSource;
    receiver: Readonly<{
        partition: 0;
        epoch: number;
        generation: string;
        writerVersion: 1;
    }>;
    barrier: HistoryBarrier;
}>;
type Pending = Readonly<{
    state: 'pending';
    gap: string;
}>;
export type AgentIdentitySDKReceivingObservation = Pending | Readonly<{
    state: 'observed';
    binding: AgentIdentitySDKReceivingBinding;
}>;
/** A released check or copied SDK receipt cannot authorize native History readiness. */
export declare const IDENTITY_HISTORY_HANDOFF_UNAVAILABLE = "identity-source-history-durable-handoff-unavailable";
export declare const AGENT_IDENTITY_SDK_OBSERVATION_COST: Readonly<{
    rows: 3;
    points: 2;
    statements: 1;
    bytes: 8192;
    engineRequests: 0;
}>;
export declare const AGENT_IDENTITY_RECEIVING_ARTIFACT_COST: Readonly<{
    rows: 69;
    points: 69;
    statements: 4;
    bytes: 24576;
    engineRequests: 0;
}>;
/** Released physical inventory observation. Pay its complete local body before acquiring
 * the receiving checkout; the returned address and roles still confer no cleanup custody. */
export declare function readAgentIdentityReceivingArtifact(pool: Pool, custodyId: string, context: HistoryReceivingContext): Promise<HistoryArtifact | null>;
export type AgentIdentitySDKWriterObservation = Pending | Readonly<{
    state: 'observed';
    writer: SdkWriterState;
}>;
/** Released observation, independently funded in the SAME live Source frame. This never
 * creates a workflow identity and is not authority for a later command. */
export declare function readAgentIdentitySDKWriterState(pool: Pool, client: WorkClient, workflowId: string, context: HistoryReceivingContext): Promise<AgentIdentitySDKWriterObservation>;
/** Technical current-state check only. The SDK derives physical placement from the actual
 * command pool, and owns both native locks until this command commits. Generation 1 may
 * serialize readiness; only the exact generation-2 tuple may serialize closure. A database
 * error propagates: its transaction must roll back, never continue after a stale check. */
export declare function lockAgentIdentitySDKWriterState(tx: CommandTransaction, client: WorkClient, workflowId: string, expected: SdkWriterState, phase: 'readiness' | 'closure'): Promise<AgentIdentitySDKWriterObservation>;
/** Receiver-local locks only. The caller releases its source checkout before entering.
 * Native UUID mapping, original SDK creation, restore/writer generation, physical roles
 * and the independent erasure barrier must agree before even describing the request. */
export declare function readAgentIdentitySDKReceivingBinding(tx: CommandTransaction, artifact: HistoryArtifact, barrier: HistoryBarrier): Promise<AgentIdentitySDKReceivingObservation>;
/** First supported consumer receipt binding for Source and original-row minimization.
 * `fence` is the UNMODIFIED SDK receipt. The surrounding binding is Kernel metadata;
 * it supplies no Semantic terminal/undo locator and confers no cleanup authority. */
export type AgentIdentitySDKRetirementReceipt = Readonly<{
    binding: AgentIdentitySDKReceivingBinding;
    sourceGeneration: string;
    fence: WorkflowWriterFence;
}>;
export type AgentIdentitySDKFenceObservation = Pending | Readonly<{
    state: 'observed';
    receipt: AgentIdentitySDKRetirementReceipt;
}>;
/** Independently reread a previously bound receipt through the real SDK. This observation is
 * also required AFTER supported deletion. No source/receiver checkout spans the SDK call.
 * Receipt shape/equality proves neither writer guard installation nor source/root authority. */
export declare function readAgentIdentitySDKFence(pool: Pool, client: WorkClient, receipt: AgentIdentitySDKRetirementReceipt, context: HistoryReceivingContext): Promise<AgentIdentitySDKFenceObservation>;
/** Complete readiness -> released owner retirement -> exact closure recording.
 * Each command re-enters the original Source owner. Nothing here mints Source proof. */
export declare function retireAgentIdentitySDKWork(pool: Pool, client: WorkClient, stage: AgentIdentityRetirementStage, context: HistoryReceivingContext): Promise<AgentIdentitySDKFenceObservation>;
/** Native expected address returned by the original Source producer. It is persisted
 * only after that producer has reconstructed and locked it, and re-resolved by the
 * original native function on every later History transition. */
export type AgentIdentityHistoryAuthority = import('../semantic/identity-source-consumer-custody.ts').IdentitySourceHistoryAuthority;
export type AgentIdentityHistoryReadiness = Readonly<{
    binding: AgentIdentitySDKReceivingBinding;
    writer: SdkWriterState;
}>;
/** Delegate to the installed Source producer's native handoff and authority type. */
export declare function lockAgentIdentityHistoryHandoff(tx: CommandTransaction, client: WorkClient, stage: AgentIdentityRetirementStage, binding: AgentIdentitySDKReceivingBinding, writer: SdkWriterState, phase: 'readiness' | 'closure'): Promise<Readonly<{
    state: 'pending';
    gap: string;
}> | Readonly<{
    state: 'guarded';
    handoff: import("../semantic/identity-source-consumer-custody.ts").IdentitySourceHistoryHandoff;
}>>;
export declare const AGENT_IDENTITY_HISTORY_GUARD_COST: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    engineRequests: number;
}>;
export declare const AGENT_IDENTITY_HISTORY_ABSENCE_COST: Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    engineRequests: number;
}>;
export declare function lockRecordedAgentIdentityHistory(tx: CommandTransaction, client: WorkClient, stage: AgentIdentityRetirementStage, context: HistoryReceivingContext): Promise<Pending | Readonly<{
    state: 'guarded';
    receipt: AgentIdentitySDKRetirementReceipt;
    writer: SdkWriterState;
}>>;
/** Resolve an original mapped receiving execution using its native physical inventory.
 * Accounts come from the complete current locator union, never workflow/source metadata.
 * Callers reserve the bounded mapping/role reads before entry; nativeReceipt supplies
 * current barrier, generation-2, physical absence and later receiving verification.
 */
export declare function lockAgentIdentityReceivingArtifact(tx: CommandTransaction, custodyId: string): Promise<HistoryArtifact | null>;
export {};
