import type { Pool } from 'pg';
import type { DiscoveryConsumerCaptureInput } from '../search/discovery.ts';
import type { Access } from '../request/access.ts';
import type { CustodyDefinition } from '../search/public-filter-custody-contract.ts';
import type { PublicCanonicalCaptureInput, PublicFilterConsumerCaptureInput, PublicSuggestionCaptureInput, PublicFilterConsumerContext, PublicFilterConsumerUnavailable, PublicFilterQueriedObservation } from '../search/public-filter-consumer-contract.ts';
import type { PrivacyReductionStart, PublicFilterDependencyKey, PublicFilterConsumer, PublicFilterProjectionObservation, PublicFilterProjectionPage, PublicFilterRepairLocator, PrivacyReductionObservation, PrivacyReductionObservationRequest, PublicFilterCost, PublicFilterProjectionMeaning, PublicFilterSource } from './public-filter-source-contract.ts';
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
export type PublicSourceCaptureInput = PublicFilterConsumerCaptureInput | DiscoveryConsumerCaptureInput | PublicSuggestionCaptureInput;
export type NativePublicSource = Readonly<{
    id: string;
    partition: number;
    epoch: number;
    configuration: string;
}>;
export type PublicFilterSourceDefinition = Readonly<{
    source: NativePublicSource;
    readDefinition: string;
    meaning: PublicFilterProjectionMeaning;
    capture: PublicSourceCaptureInput;
    dependencyKeys: readonly PublicFilterDependencyKey[];
}>;
export type PublicFilterBindingFailure = Readonly<{
    status: 'unready' | 'unavailable';
    reason: 'source_missing' | 'configuration_changed' | 'definition_missing' | 'observation_lost' | 'execution_missing' | 'binding_mismatch' | 'owner_unavailable' | 'identity_pending' | 'deadline';
    cost: PublicFilterCost;
}>;
export type PublicFilterSourceBinding = Readonly<{
    resolve(request: Readonly<{
        source: PublicFilterSource;
        meaning: PublicFilterProjectionMeaning;
        capture: PublicSourceCaptureInput;
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
export type NativeSourceRepairReceipt = Readonly<{
    [nativeSourceRepairReceipt]: true;
}>;
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
    begin(request: Readonly<{
        source: PublicFilterSource;
        meaning: PublicFilterProjectionMeaning;
        capture: PublicSourceCaptureInput;
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
/** PROVISIONAL agreed producer adapter. The owning native implementation replaces this module on landing.
 * No local registry, caller object, or structural Source can establish native binding here. */
export declare function createPublicFilterSourceBinding(_pool: Pool, _routing: Uint8Array, _access: Access): PublicFilterSourceBootstrapBinding;
