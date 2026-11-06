import type { AccountReference, HistoryLocator, HistoryScope } from './locator.ts';
import type { AgentIdentityCopyCursor, AgentIdentityHistoryUnit, AgentIdentityInventoryProof, AgentIdentityInventoryRead, AgentIdentityInventoryVerification, AgentIdentityLockedHistory, AgentIdentityNativeInventory, AgentIdentityOriginal, AgentIdentityReceipt, AgentIdentityReceivingLookup, AgentIdentityReceivingPage, AgentIdentityRecoveryArtifactInspection, AgentIdentityRecoveryArtifactReadiness, AgentIdentityRecoveryInventory, AgentIdentityRecoveryInventoryProof, AgentIdentityRecoveryInventoryVerification, AgentIdentityRetirementResult, AgentIdentityRetirementStage, AgentIdentitySDKFenceObservation, AgentIdentitySDKReceivingObservation, AgentIdentitySDKRetirementObservation, AgentIdentitySDKRetirementReceipt, AgentIdentitySDKWriterObservation, AgentIdentitySourceHandoff, AgentIdentityWorkAdmission, IdentityHistoryAccountsDeclaration, IdentityHistoryAccountsLocalWork, NativeStepWork } from './identity-types.ts';
import type { AgentIdentitySourceKey } from './identity-vocabulary.ts';
import type { CommandHistoryKind, CommandHistoryScopes, RecordHistorySourceReference } from './record-vocabulary.ts';
import type { CommittedOperationalWork, OperationalMembersBinding, OperationalWorkPhase, OperationalWorkRegistration, OperationalWorkTransfer, SelectedEpisode, SelectedLocator, SelectedOutcome } from './operational-types.ts';
import type { HistoryArtifact, HistoryBarrier, HistoryProducerFamily, HistoryReadiness, HistoryRegistry } from './registry.ts';
import type { HistoryCallback, HistoryHandle, HistoryPool, HistoryTransaction, HistoryWorkClient, HistoryWorkContext } from './transaction.ts';
import type { HistoryOwnerCoverageResult, HistoryReceivingContext, HistoryReceivingDependencies, HistoryReceivingReceipt } from './receiving-types.ts';
import type { RecordHistoryPurgeResult, SharedHistoryResult } from './record-types.ts';
/**
 * The inward surface of the native History composition. Foreign Kernel modules reach History only through
 * the application facades, which read the composition installed by the process root. Opaque handles stand for
 * foreign owners' nominal values that History carries without reading; each native adapter narrows them.
 */
export interface HistoryComposition {
    readHistoryOwnerCoverage(deps: HistoryReceivingDependencies, barrier: HistoryBarrier, family: HistoryProducerFamily, context: HistoryReceivingContext): Promise<HistoryOwnerCoverageResult>;
    verifyHistoryReceivingReceipt(tx: HistoryTransaction, barrier: HistoryBarrier, artifact: HistoryArtifact, receipt: HistoryReceivingReceipt, context?: HistoryReceivingContext): Promise<boolean>;
    recordHistoryReceivingProof(tx: HistoryTransaction, barrier: HistoryBarrier, partition: number, locator: HistoryArtifact['locator'], pool?: HistoryPool, context?: HistoryReceivingContext): Promise<string | null>;
    historyDeadline(context: HistoryReceivingContext, partition: number): void;
    lockHistoryBarrier(tx: HistoryTransaction, barrier: HistoryBarrier): Promise<boolean>;
    historyReceivingGap(tx: HistoryTransaction, partition: number, locator: HistoryArtifact['locator'], barrier?: HistoryBarrier, pool?: HistoryPool, context?: HistoryReceivingContext): Promise<string | null>;
    readHistoryReceivingReceipt(deps: HistoryReceivingDependencies, barrier: HistoryBarrier, artifact: HistoryArtifact, context: HistoryReceivingContext): Promise<HistoryReceivingReceipt | null>;
    verifyCurrentHistoryReceiving(tx: HistoryTransaction, barrier: HistoryBarrier, artifact: HistoryArtifact): Promise<boolean>;
    declareCommandHistory(tx: HistoryTransaction, kind: CommandHistoryKind, scopes: CommandHistoryScopes): Promise<void>;
    bindCommandHistoryEvidence(tx: HistoryTransaction, accounts: readonly AccountReference[]): void;
    commandHistoryIdentityAccounts(tx: HistoryTransaction): readonly AccountReference[];
    validateCommandHistory(tx: HistoryTransaction, kind: string | undefined, response: unknown, events: readonly unknown[]): void;
    validateCommandHistoryScope(tx: HistoryTransaction, kind: string | undefined, events: readonly {
        type: string;
    }[]): void;
    recordCommandHistory(tx: HistoryTransaction, input: {
        principal: {
            kind: 'account' | 'anonymous';
            id: string;
        };
        kind: string;
        storageKey: string;
        position: bigint;
    }): Promise<void>;
    releaseCommandHistory(tx: HistoryTransaction): void;
    beginRecordHistorySerialization(tx: HistoryTransaction): void;
    commandRecordSources(tx: HistoryTransaction): readonly RecordHistorySourceReference[];
    declareCommandRecordSources(tx: HistoryTransaction, sources: readonly RecordHistorySourceReference[]): void;
    declareCommandRecordSourceSet(tx: HistoryTransaction, sourceSet: HistoryHandle): void;
    finalizeCommandRecordSources(tx: HistoryTransaction, position: bigint): Promise<void>;
    releaseCommandRecordSources(tx: HistoryTransaction): void;
    recordRecordHistoryCopy(tx: HistoryTransaction, locator: HistoryLocator, position?: bigint | null): Promise<void>;
    hasCommandRecordSourceSet(tx: HistoryTransaction): boolean;
    finalizeCommandRecordSourceSet(tx: HistoryTransaction, position: bigint): Promise<void>;
    releaseCommandRecordSourceSet(tx: HistoryTransaction): void;
    recordCommandRecordSourceSetCopy(tx: HistoryTransaction, locator: HistoryLocator, position: bigint | null): Promise<void>;
    commandHistoryKind(id: number): string | undefined;
    recordDurableWorkLocator(tx: HistoryTransaction, input: {
        partition: number;
        custodyId: string;
        scope: HistoryScope;
    }): Promise<void>;
    guardHistoryAccounts(tx: HistoryTransaction, partition: number, accounts: readonly AccountReference[]): Promise<void>;
    declareAgentIdentitySource(tx: HistoryTransaction, key: AgentIdentitySourceKey, digest: string): Promise<void>;
    commandAgentIdentitySource(tx: HistoryTransaction): Readonly<{
        kind: string;
        accounts: readonly AccountReference[];
    }> | undefined;
    beginAgentIdentitySerialization(tx: HistoryTransaction): void;
    releaseAgentIdentitySource(tx: HistoryTransaction): void;
    recordAgentIdentityWorkSource(tx: HistoryTransaction, receipt: AgentIdentityReceipt, initialCustodyId: string | null): Promise<void>;
    lookupAgentIdentityReceivingCopies(pool: HistoryPool, receipts: readonly AgentIdentityReceipt[]): Promise<readonly AgentIdentityReceivingLookup[]>;
    readAgentIdentityCopyReceiving(deps: HistoryReceivingDependencies, barrier: HistoryBarrier, keys: readonly AgentIdentitySourceKey[], context: HistoryReceivingContext, after?: AgentIdentityCopyCursor): Promise<AgentIdentityReceivingPage>;
    readAgentIdentityReceivingArtifact(pool: HistoryPool, custodyId: string, context: HistoryReceivingContext): Promise<HistoryArtifact | null>;
    readAgentIdentityInventory(deps: HistoryReceivingDependencies & Readonly<{
        client?: HistoryWorkClient;
    }>, barrier: HistoryBarrier, key: AgentIdentitySourceKey, context: HistoryReceivingContext): Promise<AgentIdentityInventoryRead>;
    verifyAgentIdentityInventory(tx: HistoryTransaction, barrier: HistoryBarrier, key: AgentIdentitySourceKey, proof: AgentIdentityInventoryProof, sdkStage?: AgentIdentityRetirementStage, receiving?: Readonly<{
        client: HistoryWorkClient;
        artifact: HistoryArtifact;
    }>): Promise<AgentIdentityInventoryVerification>;
    readAgentIdentityRecoveryInventory(deps: HistoryReceivingDependencies, barrier: HistoryBarrier, key: AgentIdentitySourceKey, context: HistoryReceivingContext): Promise<AgentIdentityRecoveryInventory>;
    readAgentIdentityRecoveryInventoryInTransaction(tx: HistoryTransaction, key: AgentIdentitySourceKey): Promise<AgentIdentityRecoveryInventory>;
    readAgentIdentityRecoveryArtifactInTransaction(tx: HistoryTransaction, artifact: HistoryArtifact, pool?: HistoryPool, context?: Pick<HistoryReceivingContext, 'deadline' | 'identityConsumerWork'>): Promise<AgentIdentityRecoveryArtifactInspection>;
    verifyAgentIdentityRecoveryInventory(tx: HistoryTransaction, barrier: HistoryBarrier, key: AgentIdentitySourceKey, proof: AgentIdentityRecoveryInventoryProof, receipts: readonly HistoryReceivingReceipt[]): Promise<AgentIdentityRecoveryInventoryVerification>;
    verifyAgentIdentityRecoveryArtifactReadiness(tx: HistoryTransaction, artifact: HistoryArtifact, barrier?: HistoryBarrier, pool?: HistoryPool, source?: Readonly<{
        deadline?: number;
        searchObservation?: HistoryHandle;
        recoveryReceivingReserved?: boolean;
    }>): Promise<AgentIdentityRecoveryArtifactReadiness>;
    declareAgentIdentityInventory(tx: HistoryTransaction, original: HistoryHandle, accounts: readonly AccountReference[]): Promise<void>;
    captureAgentIdentityInventory(tx: HistoryTransaction, kind: string | undefined, events: readonly {
        type: string;
    }[]): void;
    finalizeAgentIdentityInventory(tx: HistoryTransaction, position: bigint): Promise<void>;
    releaseAgentIdentityInventory(tx: HistoryTransaction): void;
    readAgentIdentityInventoryInTransaction(tx: HistoryTransaction, key: AgentIdentitySourceKey): Promise<AgentIdentityNativeInventory>;
    readAgentIdentityNativeInventory(pool: HistoryPool, key: AgentIdentitySourceKey, context: HistoryReceivingContext): Promise<AgentIdentityNativeInventory>;
    currentAgentIdentityHistoryUnit(): AgentIdentityHistoryUnit | undefined;
    withAgentIdentityHistoryUnit<T>(deps: Readonly<{
        pool: HistoryPool;
        env: Readonly<Record<string, string | undefined>>;
        clock?: () => Date;
        client?: HistoryWorkClient;
    }>, context: HistoryReceivingContext, body: HistoryCallback<[HistoryReceivingContext], Promise<T>>): Promise<T>;
    readAgentIdentityRetirementStage(pool: HistoryPool, reference: HistoryHandle, context: HistoryReceivingContext): Promise<AgentIdentityRetirementStage | null>;
    verifyAgentIdentityRetirementStage(tx: HistoryTransaction, stage: AgentIdentityRetirementStage): Promise<AgentIdentityRetirementResult>;
    agentIdentityRetirementReadiness(tx: HistoryTransaction, artifact: HistoryArtifact, barrier: HistoryBarrier): Promise<HistoryReadiness>;
    readAgentIdentitySDKRetirementGap(pool: HistoryPool, receipt: HistoryHandle, context: HistoryReceivingContext, receiving?: Readonly<{
        client: HistoryWorkClient;
        original: AgentIdentityOriginal;
        barrier: HistoryBarrier;
    }>): Promise<string | null>;
    readAgentIdentitySDKRetirement(pool: HistoryPool, client: HistoryWorkClient, original: AgentIdentityOriginal, barrier: HistoryBarrier, context: HistoryReceivingContext): Promise<AgentIdentitySDKRetirementObservation>;
    readAgentIdentitySDKReceivingBinding(tx: HistoryTransaction, artifact: HistoryArtifact, barrier: HistoryBarrier): Promise<AgentIdentitySDKReceivingObservation>;
    readAgentIdentitySDKFence(pool: HistoryPool, client: HistoryWorkClient, receipt: AgentIdentitySDKRetirementReceipt, context: HistoryReceivingContext): Promise<AgentIdentitySDKFenceObservation>;
    retireAgentIdentitySDKWork(pool: HistoryPool, client: HistoryWorkClient, stage: AgentIdentityRetirementStage, context: HistoryReceivingContext): Promise<AgentIdentitySDKFenceObservation>;
    readAgentIdentitySDKWriterState(pool: HistoryPool, client: HistoryWorkClient, workflowId: string, context: HistoryReceivingContext): Promise<AgentIdentitySDKWriterObservation>;
    lockAgentIdentityReceivingArtifact(tx: HistoryTransaction, custodyId: string): Promise<HistoryArtifact | null>;
    identityHistoryCommand<T>(pool: HistoryPool, context: HistoryReceivingContext, body: HistoryCallback<[HistoryTransaction], Promise<T>>, partition?: number): Promise<T>;
    reserveIdentityHistoryWork(pool: HistoryPool, amount: NativeStepWork, invocation?: HistoryHandle | Pick<HistoryReceivingContext, 'deadline' | 'identityConsumerWork'>): Promise<void>;
    nativeWork(rows: number, points: number, statements: number, bytes: number): NativeStepWork;
    addNativeWork(...parts: readonly NativeStepWork[]): NativeStepWork;
    identityHistoryCommandControl: NativeStepWork;
    AGENT_IDENTITY_HISTORY_GUARD_COST(): NativeStepWork;
    identityHistoryConnection<T>(pool: HistoryPool, context: HistoryReceivingContext, body: HistoryCallback<[HistoryTransaction], Promise<T>>): Promise<T>;
    unpricedIdentityHistoryWork(term: string, amount: NativeStepWork): NativeStepWork;
    identityHistoryAccountsLocalWork(): IdentityHistoryAccountsLocalWork;
    IDENTITY_HISTORY_ACCOUNTS_DECLARATION(): IdentityHistoryAccountsDeclaration;
    resolveAgentIdentitySDKWork(tx: HistoryTransaction, custodyId: string): Promise<HistoryHandle | null>;
    assertAgentIdentityHistoryUnit(pool: HistoryPool, context?: HistoryReceivingContext, client?: HistoryWorkClient): void;
    assertAgentIdentitySourceHandoff(handoff: AgentIdentitySourceHandoff): void;
    lockRecordedAgentIdentityHistory(tx: HistoryTransaction, client: HistoryWorkClient, stage: AgentIdentityRetirementStage, context: HistoryReceivingContext): Promise<AgentIdentityLockedHistory>;
    AGENT_IDENTITY_HISTORY_ABSENCE_COST(): NativeStepWork;
    withPrepaidAgentIdentityHistoryUnit<T>(deps: Readonly<{
        pool: HistoryPool;
        client: HistoryWorkClient;
        registry: HistoryRegistry;
        env: Readonly<Record<string, string | undefined>>;
        clock: () => Date;
    }>, parent: HistoryHandle, body: HistoryCallback<[HistoryReceivingContext], Promise<T>>): Promise<T>;
    advanceAgentIdentityConsumerMaintenance(deps: Readonly<{
        pool: HistoryPool;
        client: HistoryWorkClient;
        env: Readonly<Record<string, string | undefined>>;
        clock?: () => Date;
    }>, artifact: HistoryArtifact, barrier: HistoryBarrier, context: HistoryReceivingContext): Promise<string | null>;
    enqueueAgentIdentityVerification(pool: HistoryPool, client: HistoryWorkClient, requestId: string, receiptId: string): Promise<AgentIdentityWorkAdmission>;
    enqueueAgentIdentityReversal(pool: HistoryPool, client: HistoryWorkClient, decision: HistoryHandle): Promise<AgentIdentityWorkAdmission>;
    associateAgentIdentityWorkSource(pool: HistoryPool, receipt: AgentIdentityReceipt): Promise<void>;
    verifyAgentIdentityWorkReplay(pool: HistoryPool, workflowId: string): Promise<void>;
    readAgentIdentitySourceHandoff(pool: HistoryPool, receipt: AgentIdentityReceipt): Promise<AgentIdentitySourceHandoff | null>;
    bindIdentityOriginalEffect<E extends HistoryHandle>(effect: E, deps: Readonly<{
        pool: HistoryPool;
        client: HistoryWorkClient;
    }>): E;
    isIdentityOriginalEffect(effect: {
        name: string;
        types: string[];
    }, event: HistoryHandle): boolean;
    requireIdentityFxOriginalDispatch(effect: HistoryHandle, pool: HistoryPool): never;
    associateIdentityFxOriginal(effect: HistoryHandle, pool: HistoryPool, envelope: HistoryHandle, eventSeq: number, workflowId: string): Promise<void>;
    historyExecutionPort: HistoryExecutionPort;
    registerPositionedOperationalHistoryWork(tx: HistoryTransaction, binding: OperationalMembersBinding, intent: HistoryHandle): Promise<OperationalWorkRegistration>;
    reserveOperationalWorkTransfer(tx: HistoryTransaction, phase: OperationalWorkPhase): OperationalWorkTransfer;
    receiveOperationalWorkDestination(pool: HistoryPool, work: HistoryWorkClient, origin: CommittedOperationalWork, transfer: OperationalWorkTransfer): Promise<'registered-pending-source-currentness' | 'registered-pending-position' | 'uncaptured'>;
    associateSelectedEpisode(tx: HistoryTransaction, identity: HistoryHandle, locator: SelectedLocator, fresh?: boolean): Promise<SelectedEpisode>;
    finishSelectedEpisode(tx: HistoryTransaction, identity: HistoryHandle, episode: SelectedEpisode, phase: 'apply' | 'failure', body: HistoryCallback<[HistoryTransaction], Promise<SelectedOutcome>>): Promise<SelectedOutcome>;
    prepareRecordHistoryPurge(deps: Readonly<{
        pool: HistoryPool;
        clock?: () => Date;
    }>, authority: HistoryHandle, context: Readonly<{
        deadline: number;
    }>): Promise<HistoryHandle | null>;
    minimizeRecordHistoryPurge(deps: Readonly<{
        pool: HistoryPool;
        clock?: () => Date;
    }>, preparation: HistoryHandle, context: Readonly<{
        deadline: number;
    }>): Promise<RecordHistoryPurgeResult>;
    admitSharedHistory(tx: HistoryTransaction, accountId: string, jobId: string): Promise<void>;
    advanceSharedHistory(deps: Readonly<{
        pool: HistoryPool;
        client: HistoryWorkClient;
        registry: HistoryRegistry;
        env?: Readonly<Record<string, string | undefined>>;
        clock?: () => Date;
    }>, jobId: string): Promise<SharedHistoryResult>;
    redriveSharedHistory(tx: HistoryTransaction, accountId: string): Promise<void>;
    sharedHistoryWorkModule: HistoryWorkModule;
    advanceSelectedHistoryOriginal(deps: Readonly<{
        pool: HistoryPool;
        client: HistoryWorkClient;
        registry: HistoryRegistry;
        env: Readonly<Record<string, string | undefined>>;
        clock: () => Date;
    }>): Promise<SharedHistoryResult | null>;
    advanceOutstandingRecordHistory(pool: HistoryPool, clock: () => Date): Promise<void>;
    localSharedHistoryWorkModule: HistoryWorkModule;
}
/** The execution callbacks the Kernel operational command runtime calls around a History attempt. */
export interface HistoryExecutionPort {
    begin(tx: HistoryTransaction, original: HistoryHandle): void;
    finalize(tx: HistoryTransaction): Promise<void>;
    finish(tx: HistoryTransaction, committed: boolean): void;
    enqueueCapture(tx: HistoryTransaction, intent: HistoryHandle): ((created: boolean) => void) | undefined;
}
/** A Work module as History registers it; the Work runtime supplies the concrete context. */
export interface HistoryWorkModule {
    readonly name: string;
    register(context: HistoryWorkContext): void | Promise<void>;
}
