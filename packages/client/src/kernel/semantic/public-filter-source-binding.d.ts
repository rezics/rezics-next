import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { CustodyDefinition } from '../search/public-filter-custody-contract.ts';
import type { PublicCanonicalCaptureInput, PublicFilterConsumerCaptureInput, PublicFilterConsumerContext, PublicFilterConsumerUnavailable, PublicFilterQueriedObservation } from '../search/public-filter-consumer-contract.ts';
import type { PrivacyReductionStart, PublicFilterDependencyKey, PrivacyReductionObservation, PrivacyReductionObservationRequest, PublicFilterCost, PublicFilterProjectionMeaning, PublicFilterSource } from './public-filter-source-contract.ts';
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
export type PublicFilterSourceDefinition = Readonly<{
    source: NativePublicSource;
    readDefinition: string;
    meaning: PublicFilterProjectionMeaning;
    capture: PublicFilterConsumerCaptureInput;
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
        capture: PublicFilterConsumerCaptureInput;
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
/** PROVISIONAL agreed producer adapter. The owning native implementation replaces this module on landing.
 * No local registry, caller object, or structural Source can establish native binding here. */
export declare function createPublicFilterSourceBinding(_pool: Pool, _routing: Uint8Array, _access: Access): PublicFilterSourceBinding;
