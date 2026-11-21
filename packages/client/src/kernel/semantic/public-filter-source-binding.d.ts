import { type CommandTransaction } from '../command/command.ts';
import type { Pool } from 'pg';
import type { Access } from '../access/index.ts';
import { type AccountDiscoveryRepairObservation } from '../access/account-discovery-source.ts';
import type { DiscoveryConsumerCaptureInput, PublicCanonicalCaptureInput, PublicFilterConsumerCaptureInput, PublicSuggestionCaptureInput } from '../search/index.ts';
import type { PublicFilterCost, PublicFilterDependencyKey, PublicFilterProjectionMeaning, PublicFilterSource, PublicFilterConsumer, PublicFilterProjectionObservation, PublicFilterProjectionPage, PublicFilterRepairLocator, PrivacyReductionStart, PrivacyReductionObservation, PrivacyReductionObservationRequest } from './public-filter-source-contract.ts';
import type { NativeSourceBindingPorts, PublicFilterConsumerContext, PublicFilterConsumerUnavailable, PublicFilterQueriedObservation, SourceBindingCustodyDefinition, SourceBindingCustodyExecution, SourceBindingRepairSettlement, SourceBindingFailureReason } from './source-binding-port.ts';
/** Agreed additive native binding handoff. The Source producer owns all implementation. */
export type JoinedPopulationRequest = Readonly<{
    kind: 'queried';
    phase: 'start' | 'status';
    queried: PublicFilterQueriedObservation;
}> | Readonly<{
    kind: 'queried';
    phase: 'final';
    queried: PublicFilterQueriedObservation;
    execution: string;
}>;
/** Same native head reader, with one role snapshot for an admitted set of Book pages. */
export type PagePopulationRequest = Readonly<{
    kind: 'page';
    members: readonly Extract<PrivacyReductionObservationRequest, {
        kind: 'population';
    }>[];
}>;
export interface PublicFilterNativeSource extends PublicFilterSource {
    resolvePublicFilterDefinition(request: Readonly<{
        meaning: PublicFilterProjectionMeaning;
        capture: PublicCanonicalCaptureInput;
    }>, context: PublicFilterConsumerContext): Promise<Readonly<{
        status: 'bound';
        definition: SourceBindingCustodyDefinition<PublicCanonicalCaptureInput>;
        cost: PublicFilterCost;
    }> | PublicFilterConsumerUnavailable>;
    readPrivacyReductionHeads(request: PagePopulationRequest): Promise<readonly PrivacyReductionObservation[]>;
    readPrivacyReductionHeads(request: PrivacyReductionObservationRequest): Promise<PrivacyReductionObservation>;
    readPrivacyReductionHeads(request: JoinedPopulationRequest, context: PublicFilterConsumerContext): Promise<PrivacyReductionObservation>;
}
export type NativePublicSource = Readonly<{
    id: string;
    partition: number;
    epoch: number;
    configuration: string;
}>;
/** Immutable root input. Refill size/frontier belongs to Search's retained execution lineage. */
export type PublicFilterSourceCaptureInput = PublicFilterConsumerCaptureInput | DiscoveryConsumerCaptureInput | PublicSuggestionCaptureInput;
export type PublicSourceCaptureInput = PublicFilterSourceCaptureInput;
export type PublicFilterSourceDefinition = Readonly<{
    source: NativePublicSource;
    readDefinition: string;
    meaning: PublicFilterProjectionMeaning;
    capture: PublicFilterSourceCaptureInput;
    dependencyKeys: readonly PublicFilterDependencyKey[];
}>;
export type PublicFilterBindingFailure = Readonly<{
    status: 'unready' | 'unavailable';
    reason: SourceBindingFailureReason;
    cost: PublicFilterCost;
}>;
export type PublicFilterSourceBinding = Readonly<{
    /** Older basic bindings have no repair producer. Native bootstrap bindings always provide this method. */
    readRepairStep?(request: NativeSourceRepairStepRead, context: PublicFilterConsumerContext): Promise<NativeSourceRepairStepVerification>;
    readRepairReceipt?(request: NativeSourceRepairRead, context: PublicFilterConsumerContext): Promise<NativeSourceRepairVerification>;
    /** Read an already retained definition through the current Source owner. */
    readDefinition?(request: Readonly<{
        source: PublicFilterSource;
        id: string;
    }>, context: PublicFilterConsumerContext): ReturnType<PublicFilterSourceBinding['resolve']>;
    resolve(request: Readonly<{
        source: PublicFilterSource;
        meaning: PublicFilterProjectionMeaning;
        capture: PublicFilterSourceCaptureInput;
        readOnly?: boolean;
    }>, context: PublicFilterConsumerContext): Promise<Readonly<{
        status: 'resolved';
        definition: PublicFilterSourceDefinition;
        cost: PublicFilterCost;
    }> | PublicFilterBindingFailure>;
    join(request: Readonly<{
        queried: PublicFilterQueriedObservation;
        execution?: string;
        /** The mixed page protocol checks current coverage at START and FINAL. */
        mixedCoveragePage?: true;
    }>, context: PublicFilterConsumerContext): Promise<Readonly<{
        status: 'joined';
        bookPopulation?: string;
        definition: PublicFilterSourceDefinition;
        queried: PublicFilterQueriedObservation;
        covered: PrivacyReductionStart;
        execution: SourceBindingCustodyExecution | null;
        cost: PublicFilterCost;
    }> | PublicFilterBindingFailure>;
}>;
/** Source-owned bootstrap state; the consumer and retained observation remain Search-owned. */
export type PublicSourceBootstrap = Readonly<{
    id: string;
    definition: PublicFilterSourceDefinition;
    consumer: PublicFilterConsumer;
    snapshot: 'pit' | 'prepared';
    covered: PrivacyReductionStart;
    /** An immutable parent job for this serving cut, resolved through native coverage. */
    coveragePublication?: string;
    /** Scheduling hint only. Grouped Source roles independently verify all persisted controls. */
    bookPopulation?: string;
}>;
export type PublicSourceBootstrapResult = Readonly<{
    status: 'begun';
    bootstrap: PublicSourceBootstrap;
    cost: PublicFilterCost;
}> | PublicFilterBindingFailure;
export type PublicSourceBootstrapRecovery = Readonly<{
    status: 'begun';
    bootstrap: PublicSourceBootstrap;
    queried: null;
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'adopted';
    bootstrap: PublicSourceBootstrap;
    queried: PublicFilterQueriedObservation;
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'pending';
    cost: PublicFilterCost;
}> | PublicFilterBindingFailure;
declare const nativeSourceRepairReceipt: unique symbol;
/** Durable original-module locator. Its fields locate evidence; none certifies completion. */
export type NativeSourceRepairLocator = Readonly<{
    bootstrap: string;
    execution: string;
    step: string;
    locatorDigest: string;
}>;
export type NativeSourceRepairReceipt = NativeSourceRepairLocator & Readonly<{
    [nativeSourceRepairReceipt]: true;
}>;
export type NativeSourceRepairRead = Readonly<{
    receipt: NativeSourceRepairLocator;
    queried: PublicFilterQueriedObservation;
    execution: string;
}>;
/** Exact retained native successor request. Locators identify Source evidence; they confer no authority. */
export type NativeSourceRepairStepRead = Readonly<{
    bootstrap: string;
    queried: PublicFilterQueriedObservation;
    execution: string;
    predecessor: string | null;
}>;
export type NativeSourceRepairStepVerification = Readonly<{
    status: 'verified';
    step: string;
    predecessor: string | null;
    frontier: string | null;
    complete: boolean;
    receipts: readonly NativeSourceRepairLocator[];
    cost: PublicFilterCost;
}> | PublicFilterBindingFailure;
export type NativeSourceRepairVerification = Readonly<{
    status: 'verified';
    repair: PublicSourceRepair;
    cost: PublicFilterCost;
}> | PublicFilterBindingFailure;
export type PublicSourceRepair = Readonly<{
    kind: 'local' | 'foreign';
    locator: PublicFilterRepairLocator;
    source: PublicFilterProjectionObservation;
    projection: PublicFilterProjectionPage;
    receipt: NativeSourceRepairReceipt;
}>;
export type PublicSourceRepairPage = Readonly<{
    status: 'progress';
    repairs: readonly PublicSourceRepair[];
    frontier: string;
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'complete';
    repairs: readonly PublicSourceRepair[];
    frontier: null;
    cost: PublicFilterCost;
}> | PublicFilterBindingFailure;
export type NativeBookPreparation = {
    source: PublicFilterSource;
    meaning: PublicFilterProjectionMeaning;
    capture: PublicFilterSourceCaptureInput;
    consumer: PublicFilterConsumer;
    snapshot: 'pit' | 'prepared';
    definition: PublicFilterSourceDefinition;
    inputLimit: number;
};
export type PublicFilterSourceBootstrapBinding = PublicFilterSourceBinding & Readonly<{
    readRepairStep(request: NativeSourceRepairStepRead, context: PublicFilterConsumerContext): Promise<NativeSourceRepairStepVerification>;
    /** Acyclic Source verification. Reads basic Search custody, never Search settlement. */
    readRepairReceipt(request: NativeSourceRepairRead, context: PublicFilterConsumerContext): Promise<NativeSourceRepairVerification>;
    begin(request: Readonly<{
        source: PublicFilterSource;
        meaning: PublicFilterProjectionMeaning;
        capture: PublicFilterSourceCaptureInput;
        consumer: PublicFilterConsumer;
        snapshot: 'pit' | 'prepared';
    }>, context: PublicFilterConsumerContext): Promise<PublicSourceBootstrapResult>;
    adopt(request: Readonly<{
        bootstrap: string;
        queried: PublicFilterQueriedObservation;
    }>, context: PublicFilterConsumerContext): Promise<Readonly<{
        status: 'adopted';
        bootstrap: PublicSourceBootstrap;
        queried: PublicFilterQueriedObservation;
        cost: PublicFilterCost;
    }> | PublicFilterBindingFailure>;
    abort(request: Readonly<{
        bootstrap: string;
    }>, context: PublicFilterConsumerContext): Promise<Readonly<{
        status: 'aborted' | 'pending';
        cost: PublicFilterCost;
    }> | PublicFilterBindingFailure>;
    recover(request: Readonly<{
        bootstrap: string;
    }>, context: PublicFilterConsumerContext): Promise<PublicSourceBootstrapRecovery>;
    repairPage(request: Readonly<{
        bootstrap: string;
        queried: PublicFilterQueriedObservation;
        execution: string;
        frontier: string | null;
        inputLimit: number;
        /** Separate home-scan allowance for the original Subject publication. */
        homeLimit?: number;
        /** Also fund one bounded scan of immutable held cut pages. */
        compactSubjectCuts?: true;
    }>, context: PublicFilterConsumerContext): Promise<PublicSourceRepairPage>;
    settleMixed?(request: Readonly<{
        bootstrap: string;
        queried: PublicFilterQueriedObservation;
        execution: string;
    }>, context: PublicFilterConsumerContext, spent: PublicFilterCost & Readonly<{
        bytes: number;
    }>): Promise<Awaited<ReturnType<PublicFilterSourceBinding['join']>> & {
        advanced?: boolean;
    }>;
    settle(request: Readonly<{
        bootstrap: string;
        queried: PublicFilterQueriedObservation;
        execution: string;
    }>, context: PublicFilterConsumerContext): ReturnType<PublicFilterSourceBinding['join']>;
}>;
/** Original Source operands retained for one Search generation job. No engine state is copied. */
export type NativePublicFilterPublication = Readonly<{
    job: string;
    bootstrap: string;
    queried: PublicFilterQueriedObservation;
    execution: string;
}>;
export type NativePublicFilterPublicationRequest = NativePublicFilterPublication | Readonly<{
    job: string;
}>;
type NativePublicationSpent = Readonly<Pick<BindingCost, 'inputKeys' | 'bytes'>>;
export type NativePublicFilterPublicationCompletion = Readonly<{
    status: 'pending';
    publication: NativePublicFilterPublication;
    reason: PublicFilterBindingFailure['reason'];
    advanced?: boolean;
    ackAttempted?: true;
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'complete';
    publication: NativePublicFilterPublication;
    definition: PublicFilterSourceDefinition;
    covered: PrivacyReductionStart;
    execution: NonNullable<Extract<Awaited<ReturnType<PublicFilterSourceBinding['join']>>, {
        status: 'joined';
    }>['execution']>;
    observation: Extract<PrivacyReductionObservation, {
        status: 'observed';
    }>;
    terminal: Readonly<{
        step: string;
        root: string;
    }>;
    settlement: SourceBindingRepairSettlement;
    cost: PublicFilterCost;
}> | PublicFilterBindingFailure;
/** Resolve the persisted original job/cut, then independently read its native completion.
 * Search calls this from its existing publication writer fence. The result grants no activation.
 */
/** Public constructor resolves through the application installed by Semantic composition. */
export declare function createPublicFilterSourceBinding(pool: Pool, routing: Uint8Array, access: Access): PublicFilterSourceBootstrapBinding;
export declare function readNativePublicFilterPublicationCompletion(binding: PublicFilterSourceBinding, request: NativePublicFilterPublicationRequest, context: PublicFilterConsumerContext, spent?: NativePublicationSpent): Promise<NativePublicFilterPublicationCompletion>;
/** Internal native preparation handoff; the bootstrap remains the original persisted Source cut. */
type NativePreparationInput = (Parameters<PublicFilterSourceBootstrapBinding['begin']>[0] & Readonly<{
    inputLimit?: number;
    usePublishedCoverage?: true | 'reconcile';
    definition?: PublicFilterSourceDefinition;
}>) | Readonly<{
    bootstrap: string;
    inputLimit?: number;
    subjectEnrollment?: Readonly<{
        consumer: PublicFilterConsumer;
        source: PublicFilterSourceDefinition['source'];
        registration: {
            partition: number;
            id: string;
        };
        capturingOnly?: true;
    }>;
}>;
export type NativePublicFilterPreparation = (Extract<PublicSourceBootstrapResult, {
    status: 'begun';
}> & {
    enrollmentAdvanced?: true;
    freshBook?: Readonly<{
        unopened(): Promise<{
            unopened: boolean;
            cost: PublicFilterCost;
        } | PublicFilterBindingFailure>;
        adopt(queried: PublicFilterQueriedObservation): ReturnType<PublicFilterSourceBootstrapBinding['adopt']>;
    }>;
}) | PublicFilterBindingFailure | Readonly<{
    status: 'repairing';
    bootstrapId: string;
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'preparing';
    bootstrap: PublicSourceBootstrap;
    enrollmentAdvanced: boolean;
    cost: PublicFilterCost;
}>;
type SubjectRepairWriterObligation = Pick<PublicFilterProjectionObservation, 'subject' | 'partition' | 'epoch' | 'position'>;
type NativeRepairEvidence = Readonly<{
    repairs: readonly PublicSourceRepair[];
    account: AccountDiscoveryRepairObservation | null;
    subject?: SubjectRepairWriterObligation;
}>;
export declare function nativePublicFilterRepairEvidence(binding: PublicFilterSourceBinding, step: Extract<NativeSourceRepairStepVerification, {
    status: 'verified';
}>): NativeRepairEvidence | undefined;
type NativeRepairStartInput = Readonly<{
    bootstrap: string;
    queried: PublicFilterQueriedObservation;
    publicationJob?: string;
}>;
type RepairAccountReadPlan = Readonly<{
    ids: readonly string[];
    charge(cost?: PublicFilterCost): void;
}>;
/** Share the immutable execution join within an independent Search settlement.
 * Each Source step still checks its predecessor, owner data and current cut.
 */
export declare function withNativePublicFilterRepairReadBatch<T>(binding: PublicFilterSourceBinding, input: Omit<NativeSourceRepairStepRead, 'predecessor'>, context: PublicFilterConsumerContext, read: () => Promise<T>, accounts?: RepairAccountReadPlan): Promise<T>;
export declare function joinNativePublicFilterRepair(binding: PublicFilterSourceBinding, request: Parameters<PublicFilterSourceBinding['join']>[0], context: PublicFilterConsumerContext): Promise<Readonly<{
    status: 'unready' | 'unavailable';
    reason: SourceBindingFailureReason;
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'joined';
    bookPopulation?: string;
    definition: PublicFilterSourceDefinition;
    queried: PublicFilterQueriedObservation;
    covered: PrivacyReductionStart;
    execution: SourceBindingCustodyExecution | null;
    cost: PublicFilterCost;
}> | null>;
export declare function readNativePublicFilterAccountRepair(binding: PublicFilterSourceBinding, request: NativeSourceRepairStepRead, context: PublicFilterConsumerContext): Promise<Readonly<{
    account: AccountDiscoveryRepairObservation | null;
    cost: PublicFilterCost;
}> | null>;
export declare function readNativePublicFilterRepairStart(binding: PublicFilterSourceBinding, request: NativeRepairStartInput, context: PublicFilterConsumerContext): Promise<Readonly<{
    start: PrivacyReductionStart;
    cost: PublicFilterCost;
}> | null>;
type BookPreparationGroup = {
    members: readonly NativeBookPreparation[];
};
/** A private factory association locates the native body. Each child still resolves its registration and cut. */
export declare function advanceNativePublicFilterPreparation(binding: PublicFilterSourceBinding, input: {
    pageObservation: PublicFilterQueriedObservation;
}, context: PublicFilterConsumerContext): Promise<Awaited<ReturnType<PublicFilterSourceBinding['join']>> | null>;
export declare function advanceNativePublicFilterPreparation(binding: PublicFilterSourceBinding, input: BookPreparationGroup, context: PublicFilterConsumerContext): Promise<NativePublicFilterPreparation[] | null>;
export declare function advanceNativePublicFilterPreparation(binding: PublicFilterSourceBinding, input: NativePreparationInput, context: PublicFilterConsumerContext): Promise<NativePublicFilterPreparation | null>;
type BindingCost = {
    -readonly [K in keyof PublicFilterCost]: number;
} & {
    statements: number;
    rows: number;
    bytes: number;
    engineRequests: number;
};
export declare class PublicFilterSourceDefinitionError extends Error {
    readonly reason: PublicFilterBindingFailure['reason'];
    constructor(reason: PublicFilterBindingFailure['reason']);
}
/** Load only an existing immutable read definition. The optional byte cap lets native callers
 * debit a fixed upper bound before the retained capture and dependency keys are read.
 */
export declare function readNativePublicFilterSourceDefinition(id: string, db: CommandTransaction, routeDigest: string, search: NativeSourceBindingPorts['search'], maxBytes?: number): Promise<Readonly<{
    definition: PublicFilterSourceDefinition;
    bytes: number;
}>>;
/** Native Source-owned registration; the origin association only locates the constructor configuration. */
export declare function createNativePublicFilterSourceBinding(pool: Pool, routing: Uint8Array, access: Access, ports: NativeSourceBindingPorts): PublicFilterSourceBootstrapBinding;
export {};
