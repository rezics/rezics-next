import type { WorkAuthorization, WorkClock, WorkDispatchCost, WorkEffect, WorkHistoryRegistry, WorkHistoryScope, WorkIntent, WorkPool, WorkQueryClient, WorkQueryResult, WorkQueueName, WorkQueueOptions, WorkRegisteredEffects, WorkRetirementFence, WorkRetirementInvocation, WorkRetirementOutcome, WorkScopedRequest, WorkSdkClient, WorkSelectedIdentity, WorkSelectedLocator, WorkSelectedOutcome, WorkService, WorkWriterState } from './vocabulary.ts';
import type { WorkCost } from './cost.ts';
export type WorkSdkConfig = Readonly<{
    name: string;
    systemDatabaseUrl: string;
    systemDatabaseSchemaName: string;
    systemDatabasePool: WorkPool;
    runMigrations: boolean;
    logLevel: string;
    executorID?: string;
}>;
export type WorkEnqueueCapture = (created: boolean) => void;
export type SdkEnqueuePort = {
    enqueueInTransaction(sdk: WorkSdkClient, tx: WorkQueryClient, intent: WorkIntent, capture?: WorkEnqueueCapture): Promise<void>;
    assertClient?(client: WorkSdkClient, pool: WorkPool): void;
};
export type SdkRuntimePort = {
    isInitialized(): boolean;
    setConfig(config: WorkSdkConfig): void;
    registerQueue(client: WorkSdkClient, name: string, options: WorkQueueOptions): Promise<void>;
    launch(): Promise<void>;
    shutdown(options: {
        workflowCompletionTimeoutMS: number;
    }): Promise<void>;
    registerWorkflow(body: () => Promise<unknown>, config: {
        name: string;
    }): void;
    runStep<T>(body: () => Promise<T>, config: {
        name: string;
        retriesAllowed?: boolean;
        maxAttempts?: number;
    }): Promise<T>;
    applySchedules(client: WorkSdkClient, schedules: readonly Readonly<{
        scheduleName: string;
        workflowName: string;
        schedule: string;
        queueName: WorkQueueName;
        cronTimezone: string;
        automaticBackfill: boolean;
    }>[]): Promise<void>;
    deleteWorkflows(ids: readonly string[], descendants: false): Promise<void>;
};
export type SdkRetirementPort = {
    retireWorkflow(actualWorkflowId: string): Promise<WorkRetirementFence>;
    supportsBoundedRetirement(client: WorkSdkClient): boolean;
    invokeRetirement(actualWorkflowId: string, client: WorkSdkClient, invocation: Readonly<{
        deadline: number;
        maxAttempts: number;
        reserve: (dispatch: string) => Promise<void>;
        signal?: AbortSignal;
    }>): Promise<WorkRetirementOutcome>;
    readFence(actualWorkflowId: string): Promise<WorkRetirementFence | null>;
    readWriterState(actualWorkflowId: string, client: WorkSdkClient): Promise<WorkWriterState | null>;
    lockWriterState(tx: WorkQueryClient, pool: WorkPool, expected: WorkWriterState, client: WorkSdkClient): Promise<WorkWriterState>;
    supportsBoundedMaintenance(client: WorkSdkClient): boolean;
    maintainOnce(pool: WorkPool, client: WorkSdkClient, expected: WorkWriterState, action: 'retire' | 'delete', deadline: number, reserve: (dispatch: string) => Promise<void>): Promise<WorkRetirementFence | null>;
};
export type SelectedLifecycle = {
    open(): Promise<{
        deadline: number;
        reserve(dispatch: 'issue' | 'release'): Promise<void>;
        close(): Promise<void>;
        run<T>(body: () => Promise<T>): Promise<T>;
    }>;
};
export type SdkSelectedPort = {
    registerSelectedStep<R>(body: (locator: WorkSelectedLocator) => Promise<R>, config: {
        name: string;
    }, lifecycle: SelectedLifecycle): (locator: WorkSelectedLocator) => Promise<R>;
    getSelectedExecution(): object | undefined;
    selectedExecutionIdentity(claim: object, pool: WorkPool, client: WorkSdkClient): WorkSelectedIdentity;
    consumeSelectedExecutionAdmission(claim: object, pool: WorkPool, client: WorkSdkClient): Promise<boolean>;
    checkSelectedExecutionInTransaction(tx: WorkQueryClient, pool: WorkPool, claim: object, client: WorkSdkClient): Promise<void>;
    isSelectedClient(client: WorkSdkClient): boolean;
};
export type SqlPort = {
    hasRetainedCopies(client: WorkQueryClient, workflowId: string): Promise<boolean>;
};
export type HistoryAssociationPort = {
    validateLocator(artifactType: 'durable-work/v1', locator: {
        artifactType: 'durable-work/v1';
        workId: string;
    }): void;
    validateScope(artifactType: 'durable-work/v1', scope: WorkHistoryScope): void;
    encodeLocator(locator: {
        artifactType: 'durable-work/v1';
        workId: string;
    }): Uint8Array;
    beginSerialization(tx: WorkQueryClient): void;
    recordCopy(tx: WorkQueryClient, locator: {
        artifactType: 'durable-work/v1';
        workId: string;
    }): Promise<void>;
    guardAccounts(tx: WorkQueryClient, partition: number, accounts: WorkHistoryScope['accounts']): Promise<void>;
    persist(tx: WorkQueryClient, partition: number, source: number, sourceTransaction: string, request: WorkScopedRequest, digest: Uint8Array, custodyId?: string): Promise<{
        retired: boolean;
        admitted: boolean;
    }>;
    readOrigin(pool: WorkPool, sourcePartition: number, workId: string): Promise<{
        request_digest: Uint8Array;
        owner: string;
        request: WorkIntent;
        scope: WorkHistoryScope;
        source_transaction: string;
        state: string;
        recordCopies: readonly Record<string, unknown>[];
        recordSets: readonly Record<string, unknown>[];
        recordLocator: Uint8Array;
    }>;
    withConnection<T>(pool: WorkPool, body: (tx: WorkQueryClient) => Promise<T>): Promise<T>;
    beginSerializable(tx: WorkQueryClient): Promise<void>;
    commit(tx: WorkQueryClient): Promise<void>;
    rollback(tx: WorkQueryClient): Promise<void>;
    lockReceiving(tx: WorkQueryClient, workId: string): Promise<{
        state: string;
        request_digest: Uint8Array;
    } | undefined>;
    insertRecordCopies(tx: WorkQueryClient, copies: readonly Record<string, unknown>[], locator: Uint8Array): Promise<void>;
    insertRecordSets(tx: WorkQueryClient, sets: readonly Record<string, unknown>[], locator: Uint8Array): Promise<void>;
    markAdmitted(tx: WorkQueryClient, partition: number, workId: string): Promise<void>;
    settleOwner(tx: WorkQueryClient, input: {
        partition: number;
        workId: string;
        digest: Uint8Array;
        owner: string;
    }): Promise<void>;
    readIdentityMapping(tx: WorkQueryClient, custodyId: string): Promise<{
        workflow_id: string;
    } | undefined>;
    bindIdentityDigest(tx: WorkQueryClient, custodyId: string, digest: Uint8Array): Promise<boolean>;
    captureIdentityCreation(tx: WorkQueryClient, custodyId: string): Promise<void>;
    currentCommand(tx: WorkQueryClient): {
        partition: number;
        transactionId: string;
    };
    commandPool(tx: WorkQueryClient): WorkPool;
};
export type SelectedEpisode = object;
export type OperationalResources = Readonly<{
    pool: WorkPool;
    workClient: WorkSdkClient;
    deadline: number;
    partition: number;
    mode: string;
    kind: string;
    accounts: readonly string[];
}>;
export type OperationalPort = {
    runTransaction<T>(pool: WorkPool, options: Readonly<{
        mode: 'work-step';
        partition: number;
        kind: string;
        accounts: readonly string[];
        workClient: WorkSdkClient;
        deadline: number;
        selectedRuntime: object;
    }>, body: (tx: WorkQueryClient) => Promise<T>): Promise<T>;
    currentResources(tx: WorkQueryClient): OperationalResources;
};
export type SelectedAssociationPort = {
    associateEpisode(tx: WorkQueryClient, identity: WorkSelectedIdentity, locator: WorkSelectedLocator, fresh: boolean): Promise<SelectedEpisode & {
        result: WorkSelectedOutcome | null;
    }>;
    finishEpisode(tx: WorkQueryClient, identity: WorkSelectedIdentity, episode: SelectedEpisode, phase: 'apply' | 'failure', body: (tx: WorkQueryClient) => Promise<WorkSelectedOutcome>): Promise<WorkSelectedOutcome>;
};
export type RoutePort = {
    routeOf(id: string): number | null;
    partitionOf(route: number): number;
};
export type AuthorizationPort = {
    create(deps: {
        pool: WorkPool;
        client: WorkSdkClient;
        env: Readonly<Record<string, string | undefined>>;
        clock: WorkClock;
        receiptKeys?: unknown;
    }): WorkAuthorization;
};
export type EffectsPort = {
    identityFxName: string;
    bindIdentityOriginal(effect: WorkEffect, deps: {
        pool: WorkPool;
        client: WorkSdkClient;
    }): WorkEffect;
    register(effects: readonly WorkEffect[], pool: WorkPool): WorkRegisteredEffects;
};
export type HistoryRegistryPort = {
    create(): WorkHistoryRegistry;
};
export type KindConsentPort = {
    readConfig(env: Readonly<Record<string, string | undefined>>): object | null;
    createParticipant(config: object, deadline: number): unknown;
};
export type RetentionSelectorPort = {
    create(pool: WorkPool): (input: Readonly<{
        applicationName: string;
        statuses: readonly ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'];
        completedBefore: number;
        limit: number;
    }>) => Promise<readonly string[]>;
};
export type CostPort = {
    isBound(value: unknown): boolean;
};
export type WorkApplicationPorts = {
    readonly sdkEnqueue: SdkEnqueuePort;
    readonly sdkRuntime: SdkRuntimePort;
    readonly sdkRetirement: SdkRetirementPort;
    readonly sdkSelected: SdkSelectedPort;
    readonly sql: SqlPort;
    readonly history: HistoryAssociationPort;
    readonly operational: OperationalPort;
    readonly selectedAssociation: SelectedAssociationPort;
    readonly route: RoutePort;
    readonly authorization: AuthorizationPort;
    readonly effects: EffectsPort;
    readonly historyRegistry: HistoryRegistryPort;
    readonly kindConsent: KindConsentPort;
    readonly retentionSelector: RetentionSelectorPort;
    readonly cost: CostPort;
    readonly clock: WorkClock;
    readonly now: () => number;
};
export type WorkComposeOptions = {
    databaseUrl: string;
    executorId?: string;
    pool: WorkPool;
    client: WorkSdkClient;
    env?: Readonly<Record<string, string | undefined>>;
    clock?: WorkClock;
    receiptKeys?: unknown;
};
export type WorkRegistrationContext = {
    readonly pool: WorkPool;
    readonly queues: Readonly<Record<WorkQueueName, WorkQueueOptions>>;
    readonly client: WorkSdkClient;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly clock: WorkClock;
    readonly history?: WorkHistoryRegistry;
    getAuthorization(): WorkAuthorization;
    getSelectedRuntime(): WorkSelectedRuntime;
    getKindConsentParticipant?(deadline: number): unknown;
    addEffects(effects: WorkEffect[]): void;
    addNativeEffects?(effects: WorkEffect[]): void;
    addService(start: () => WorkService | Promise<WorkService>): void;
};
export type WorkModule = {
    name: string;
    register(context: WorkRegistrationContext): void | Promise<void>;
};
export type WorkSelectedNativeDeclaration = Readonly<{
    sql: string;
    limit: number;
    cost: WorkCost;
}>;
export type WorkSelectedChildren = Readonly<{
    native: readonly WorkSelectedNativeDeclaration[];
    source?: WorkCost;
}>;
export type WorkSelectedInvocation = Readonly<{
    deadline: number;
    select(locator: WorkSelectedLocator): Promise<SelectedEpisode & {
        result: WorkSelectedOutcome | null;
    }>;
    source<T>(body: (deadline: number) => Promise<T>): Promise<T>;
    apply(episode: SelectedEpisode, body: (tx: WorkQueryClient) => Promise<WorkSelectedOutcome>): Promise<WorkSelectedOutcome>;
    failure(episode: SelectedEpisode, body: (tx: WorkQueryClient) => Promise<WorkSelectedOutcome>): Promise<WorkSelectedOutcome>;
}>;
export type WorkSelectedRuntime = Readonly<{
    registerMembersStep<R>(body: (invocation: WorkSelectedInvocation, locator: WorkSelectedLocator) => Promise<R>, children?: WorkSelectedChildren): (locator: WorkSelectedLocator) => Promise<R>;
}>;
export type WorkComposedRuntime = {
    effects: WorkRegisteredEffects;
    launch(): Promise<void>;
    shutdown(): Promise<void>;
};
export type WorkSelectedPhase = {
    deadline: number;
    assertLive(): void;
    query(sql: unknown): void;
    hold(tx: WorkQueryClient, raw: WorkQueryClient): Promise<void>;
    guardBody(): void;
    finish(): void;
};
export type WorkApplication = {
    readonly ports: WorkApplicationPorts;
    enqueue(client: WorkSdkClient, tx: WorkQueryClient, intent: WorkIntent, capture?: WorkEnqueueCapture): Promise<void>;
    hasRetainedCopies(client: WorkQueryClient, workflowId: string): Promise<boolean>;
    compose(modules: readonly WorkModule[], options: WorkComposeOptions): Promise<WorkComposedRuntime>;
    composeSelectedRuntime(pool: WorkPool, client: WorkSdkClient): WorkSelectedRuntime;
    selectedOperationalEnqueue(tx: WorkQueryClient, intent: WorkIntent): WorkEnqueueCapture | undefined;
    assertSelectedOperationalTransaction(tx: WorkQueryClient, expected: WorkSelectedIdentity): void;
    selectedLocalQuery(tx: WorkQueryClient, expected: WorkSelectedIdentity, sql: string, values?: unknown[]): Promise<WorkQueryResult>;
    assertSelectedContinuation(tx: WorkQueryClient, expected: WorkSelectedIdentity, workflow: string): void;
    openSelectedOperationalPhase(pool: WorkPool, options: Readonly<{
        selectedRuntime?: object;
        workClient: WorkSdkClient;
        mode: string;
        operationalHistory?: unknown;
        partition: number;
        kind: string;
        accounts: readonly string[];
        deadline?: number;
    }>): WorkSelectedPhase;
    stageHistoryWork(tx: WorkQueryClient, input: WorkScopedRequest): Promise<void>;
    receiveHistoryWork(pool: WorkPool, client: WorkSdkClient, sourcePartition: number, workId: string): Promise<'admitted' | 'retired'>;
    receiveMappedHistoryWork(tx: WorkQueryClient, client: WorkSdkClient, custodyId: string, source: {
        partition: number;
        transactionId: string;
    }, request: WorkScopedRequest): Promise<'admitted' | 'retired'>;
    settleHistoryWork(tx: WorkQueryClient, input: {
        partition: number;
        workId: string;
        digest: Uint8Array;
        owner: string;
    }): Promise<void>;
    retireWriters(actualWorkflowId: string): Promise<WorkRetirementFence>;
    invokeRetirement(actualWorkflowId: string, client: WorkSdkClient, invocation: WorkRetirementInvocation): Promise<WorkRetirementOutcome>;
    readRetirement(actualWorkflowId: string): Promise<WorkRetirementFence | null>;
    readWriterState(actualWorkflowId: string, client: WorkSdkClient): Promise<WorkWriterState | null>;
    lockWriterState(tx: WorkQueryClient, expected: WorkWriterState, client: WorkSdkClient): Promise<WorkWriterState>;
    maintainOnce(pool: WorkPool, client: WorkSdkClient, expected: WorkWriterState, action: 'retire' | 'delete', deadline: number, reserve: (cost: WorkDispatchCost) => Promise<void>): Promise<WorkRetirementFence | null>;
    runRetentionBatch(retentionDays: number, now: Date, select: RetentionSelectorPort['create'] extends (pool: WorkPool) => infer S ? S : never, applicationName: string): Promise<number>;
    runRetentionSweep(retentionDays: number, now: Date, step: (batch: () => Promise<number>) => Promise<number>, select: RetentionSelectorPort['create'] extends (pool: WorkPool) => infer S ? S : never, applicationName: string): Promise<number>;
    registerRetention(context: {
        client: WorkSdkClient;
        env: Readonly<Record<string, string | undefined>>;
        queues: Readonly<Record<string, WorkQueueOptions>>;
        pool: WorkPool;
    }): Promise<void>;
};
