import { type AccountDiscoveryRepairObservation } from '../access/account-discovery-source.ts';
import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { CustodyDefinition } from '../search/public-filter-custody-contract.ts';
import { type DiscoveryConsumerCaptureInput } from '../search/discovery.ts';
import type { PublicFilterConsumerCaptureInput, PublicFilterConsumerContext, PublicCanonicalCaptureInput, PublicFilterConsumerUnavailable, PublicFilterQueriedObservation, PublicSuggestionCaptureInput } from '../search/public-filter-consumer-contract.ts';
import type { PublicFilterCost, PublicFilterDependencyKey, PublicFilterProjectionMeaning, PublicFilterSource, PublicFilterConsumer, PublicFilterProjectionObservation, PublicFilterProjectionPage, PublicFilterRepairLocator, PrivacyReductionStart, PrivacyReductionObservation, PrivacyReductionObservationRequest } from './public-filter-source-contract.ts';
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
export interface PublicFilterNativeSource extends PublicFilterSource {
    resolvePublicFilterDefinition(request: Readonly<{
        meaning: PublicFilterProjectionMeaning;
        capture: PublicCanonicalCaptureInput;
    }>, context: PublicFilterConsumerContext): Promise<Readonly<{
        status: 'bound';
        definition: CustodyDefinition<PublicCanonicalCaptureInput>;
        cost: PublicFilterCost;
    }> | PublicFilterConsumerUnavailable>;
    readPrivacyReductionHeads(request: PrivacyReductionObservationRequest): Promise<PrivacyReductionObservation>;
    readPrivacyReductionHeads(request: JoinedPopulationRequest, context: PublicFilterConsumerContext): Promise<PrivacyReductionObservation>;
}
export type { PublicFilterQueriedObservation } from '../search/public-filter-consumer-contract.ts';
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
    reason: 'source_missing' | 'configuration_changed' | 'definition_missing' | 'observation_lost' | 'execution_missing' | 'binding_mismatch' | 'owner_unavailable' | 'identity_pending' | 'deadline';
    cost: PublicFilterCost;
}>;
export type PublicFilterSourceBinding = Readonly<{
    /** Older basic bindings have no repair producer. Native bootstrap bindings always provide this method. */
    readRepairStep?(request: NativeSourceRepairStepRead, context: PublicFilterConsumerContext): Promise<NativeSourceRepairStepVerification>;
    readRepairReceipt?(request: NativeSourceRepairRead, context: PublicFilterConsumerContext): Promise<NativeSourceRepairVerification>;
    resolve(request: Readonly<{
        source: PublicFilterSource;
        meaning: PublicFilterProjectionMeaning;
        capture: PublicFilterSourceCaptureInput;
    }>, context: PublicFilterConsumerContext): Promise<Readonly<{
        status: 'resolved';
        definition: PublicFilterSourceDefinition;
        cost: PublicFilterCost;
    }> | PublicFilterBindingFailure>;
    join(request: Readonly<{
        queried: PublicFilterQueriedObservation;
        execution?: string;
    }>, context: PublicFilterConsumerContext): Promise<Readonly<{
        status: 'joined';
        definition: PublicFilterSourceDefinition;
        queried: PublicFilterQueriedObservation;
        covered: PrivacyReductionStart;
        execution: Readonly<{
            id: string;
            start: PrivacyReductionStart;
            ownRows: readonly Readonly<{
                original: string;
                terminal: string;
            }>[];
        }> | null;
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
    }>, context: PublicFilterConsumerContext): Promise<PublicSourceRepairPage>;
    settle(request: Readonly<{
        bootstrap: string;
        queried: PublicFilterQueriedObservation;
        execution: string;
    }>, context: PublicFilterConsumerContext): ReturnType<PublicFilterSourceBinding['join']>;
}>;
/** Internal native preparation handoff; the bootstrap remains the original persisted Source cut. */
type NativePreparationInput = Parameters<PublicFilterSourceBootstrapBinding['begin']>[0] | Readonly<{
    bootstrap: string;
}>;
export type NativePublicFilterPreparation = PublicSourceBootstrapResult | Readonly<{
    status: 'preparing';
    bootstrap: PublicSourceBootstrap;
    cost: PublicFilterCost;
}>;
export declare function joinNativePublicFilterRepair(binding: PublicFilterSourceBinding, request: Parameters<PublicFilterSourceBinding['join']>[0], context: PublicFilterConsumerContext): Promise<Readonly<{
    status: 'unready' | 'unavailable';
    reason: 'source_missing' | 'configuration_changed' | 'definition_missing' | 'observation_lost' | 'execution_missing' | 'binding_mismatch' | 'owner_unavailable' | 'identity_pending' | 'deadline';
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'joined';
    definition: PublicFilterSourceDefinition;
    queried: PublicFilterQueriedObservation;
    covered: PrivacyReductionStart;
    execution: Readonly<{
        id: string;
        start: PrivacyReductionStart;
        ownRows: readonly Readonly<{
            original: string;
            terminal: string;
        }>[];
    }> | null;
    cost: PublicFilterCost;
}> | null>;
export declare function readNativePublicFilterAccountRepair(binding: PublicFilterSourceBinding, request: NativeSourceRepairStepRead, context: PublicFilterConsumerContext): Promise<Readonly<{
    account: AccountDiscoveryRepairObservation | null;
    cost: PublicFilterCost;
}> | null>;
export declare function readNativePublicFilterRepairStart(binding: PublicFilterSourceBinding, request: Readonly<{
    bootstrap: string;
    queried: PublicFilterQueriedObservation;
}>, context: PublicFilterConsumerContext): Promise<Readonly<{
    start: PrivacyReductionStart;
    cost: PublicFilterCost;
}> | null>;
/** A private factory association locates the native body; it cannot grant coverage or open a PIT. */
export declare function advanceNativePublicFilterPreparation(binding: PublicFilterSourceBinding, input: NativePreparationInput, context: PublicFilterConsumerContext): Promise<NativePublicFilterPreparation | null>;
export declare class PublicFilterSourceDefinitionError extends Error {
    readonly reason: PublicFilterBindingFailure['reason'];
    constructor(reason: PublicFilterBindingFailure['reason']);
}
/** Load only an existing immutable read definition. The optional byte cap lets native callers
 * debit a fixed upper bound before the retained capture and dependency keys are read.
 */
export declare function readPublicFilterSourceDefinition(id: string, db: Pool, routeDigest: string, maxBytes?: number): Promise<Readonly<{
    definition: PublicFilterSourceDefinition;
    bytes: number;
}>>;
/** Native Source-owned registration; the origin association only locates the constructor configuration. */
export declare function createPublicFilterSourceBinding(pool: Pool, routing: Uint8Array, access: Access): PublicFilterSourceBootstrapBinding;
