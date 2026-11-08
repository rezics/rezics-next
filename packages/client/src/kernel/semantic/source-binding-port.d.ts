import type { Pool } from 'pg';
import type { Access, AccessCheck, Actor, Resource } from '../access/index.ts';
import type { AccountDiscoveryRepairObservation } from '../access/account-discovery-source.ts';
import type { AccountDiscoveryEnrollment, enrollAccountDiscoveryHome } from '../access/adapters/index.ts';
import type { PublicCanonicalCaptureInput, PublicFilterConsumerCaptureInput, PublicSuggestionCaptureInput } from '../search/index.ts';
import type { PrivacyReductionStart, PublicFilterConsumer, PublicFilterCost, PublicFilterDependencyKey, PublicFilterProjectionMeaning, PublicFilterSource, PublicFilterSourceFactory } from './public-filter-source-contract.ts';
export type SourceBindingCaptureInput = PublicFilterConsumerCaptureInput | PublicCanonicalCaptureInput | PublicSuggestionCaptureInput;
/** Shared request identity used by Semantic Source and Search consumer custody. */
export type PublicFilterConsumerContext = Readonly<{
    deadline: number;
}>;
export type PublicFilterQueriedObservation = Readonly<{
    consumer: PublicFilterConsumer;
    snapshot: Readonly<{
        kind: 'pit';
        observation: string;
        pit: string;
    }> | Readonly<{
        kind: 'prepared';
        observation: string;
        build: string;
        generation: bigint;
    }>;
}>;
export type PublicFilterConsumerUnavailable = Readonly<{
    status: 'unready' | 'unavailable';
    reason: 'registration_missing' | 'incarnation_changed' | 'observation_lost' | 'source_pending' | 'routing_incomplete' | 'deadline' | 'dependency_unavailable';
    cost: PublicFilterCost;
}>;
export type SourceBindingFailure = Readonly<{
    status: 'unready' | 'unavailable';
    reason: SourceBindingFailureReason;
    cost: PublicFilterCost;
}>;
export type SourceBindingFailureReason = 'source_missing' | 'configuration_changed' | 'definition_missing' | 'observation_lost' | 'execution_missing' | 'binding_mismatch' | 'owner_unavailable' | 'identity_pending' | 'deadline';
export type SourceBindingCustodyDefinition<Capture extends PublicCanonicalCaptureInput = PublicCanonicalCaptureInput> = Readonly<{
    source: Readonly<{
        id: string;
        partition: number;
        epoch: number;
        configuration: string;
    }>;
    readDefinition: string;
    meaning: PublicFilterProjectionMeaning;
    capture: Capture;
    dependencyKeys: readonly PublicFilterDependencyKey[];
}>;
export type SourceBindingRetainedDefinition = Omit<SourceBindingCustodyDefinition<PublicCanonicalCaptureInput>, 'meaning'> & Readonly<{
    meaning: Omit<PublicFilterProjectionMeaning, 'release'> & Readonly<{
        release: PublicFilterProjectionMeaning['release'] | Readonly<{
            authority: 'semantic.readRelease';
            digest: string;
        }>;
    }>;
}>;
export type SourceBindingCustodyExecution = Readonly<{
    id: string;
    start: PrivacyReductionStart;
    ownRows: readonly Readonly<{
        original: string;
        terminal: string;
    }>[];
}>;
export type SourceBindingCustodyResult = Readonly<{
    status: 'found';
    definition: SourceBindingRetainedDefinition;
    queried: PublicFilterQueriedObservation;
    covered: PrivacyReductionStart;
    execution: SourceBindingCustodyExecution | null;
    cost: PublicFilterCost;
}> | SourceBindingFailure;
export type SourceBindingGenerationResult = Readonly<{
    definition: SourceBindingRetainedDefinition;
    registration: Readonly<{
        partition: number;
        id: string;
    }>;
    queried: PublicFilterQueriedObservation | null;
    cost: PublicFilterCost;
}> | SourceBindingFailure;
export type SourceBindingSettlementResult = Readonly<{
    status: 'settled';
    definition: SourceBindingRetainedDefinition;
    queried: PublicFilterQueriedObservation;
    execution: SourceBindingCustodyExecution;
    settlement: Readonly<{
        id: string;
    }>;
    cost: PublicFilterCost;
}> | SourceBindingFailure;
export type SourceBindingRepairSettlement = Readonly<{
    id: string;
}>;
/** Search owns filter/text planning, retained consumer custody and generation evidence. */
export type PublicFilterSearchBindingPort = Readonly<{
    deriveDependencyKeys(meaning: PublicFilterProjectionMeaning, input: SourceBindingCaptureInput): readonly PublicFilterDependencyKey[];
    catalogue(consumer: PublicFilterConsumer, mixed: boolean): unknown;
    encodeConsumer(consumer: PublicFilterConsumer): string;
    encodeState(value: unknown): string;
    decodeState<T>(value: string): T;
    coverageStart(context: PublicFilterConsumerContext): string | null;
    readConsumerCustody(pool: Pool, request: Readonly<{
        queried: PublicFilterQueriedObservation;
        execution?: string;
    }>, context: PublicFilterConsumerContext): Promise<SourceBindingCustodyResult>;
    readGenerationPublicationCustody(pool: Pool, consumer: PublicFilterConsumer, sourceHome: number | undefined, context: PublicFilterConsumerContext, observation?: string): Promise<SourceBindingGenerationResult>;
    readRepairSettlement(pool: Pool, request: Readonly<{
        queried: PublicFilterQueriedObservation;
        execution: string;
    }>, context: PublicFilterConsumerContext): Promise<SourceBindingSettlementResult>;
    withRepairAllowance<T>(spent: PublicFilterCost, work: () => Promise<T>): Promise<T>;
}>;
/** Access supplies current Account repair inputs, authorization and deadline classification. */
export type PublicFilterAccessBindingPort = Readonly<{
    readAccountRepair(pool: Pool, id: string, context: PublicFilterConsumerContext): Promise<AccountDiscoveryRepairObservation>;
    enrollAccountHome(pool: Pool, input: Parameters<typeof enrollAccountDiscoveryHome>[1], context: PublicFilterConsumerContext): Promise<AccountDiscoveryEnrollment>;
    classifyUnavailability(error: unknown): string | undefined;
    requireDeadline(deadline: number): void;
    isUnavailable(error: unknown): boolean;
    checkSubjectRead(access: Access, actor: Actor, action: string, resource: Resource, context: Readonly<{
        pool: Pool;
        deadline: number;
    }>): Promise<AccessCheck>;
}>;
export type SourceBindingConfiguration = Parameters<PublicFilterSourceFactory>[0];
export type SourceBindingFactory = (pool: Pool, routing: Uint8Array, access: Access) => import('./public-filter-source-binding.ts').PublicFilterSourceBootstrapBinding;
/** Capabilities consumed by the native Semantic binding producer. */
export type NativeSourceBindingPorts = Readonly<{
    search: PublicFilterSearchBindingPort;
    access: PublicFilterAccessBindingPort;
    sourceOrigin(source: PublicFilterSource): SourceBindingConfiguration | undefined;
    sourceFactory(config: SourceBindingConfiguration): PublicFilterSource;
}>;
/** The constructed Semantic application installs the real native, Search and Access producers together. */
export type SourceBindingNativeOwner = Readonly<{
    createBinding(pool: Pool, routing: Uint8Array, access: Access, ports: NativeSourceBindingPorts): import('./public-filter-source-binding.ts').PublicFilterSourceBootstrapBinding;
    createSource(config: SourceBindingConfiguration, bindingFactory: SourceBindingFactory, search: PublicFilterSearchBindingPort, access: PublicFilterAccessBindingPort): PublicFilterSource;
    readDefinition(id: string, pool: Pool, routeDigest: string, search: PublicFilterSearchBindingPort, maxBytes?: number): Promise<Readonly<{
        definition: import('./public-filter-source-binding.ts').PublicFilterSourceDefinition;
        bytes: number;
    }>>;
}>;
export type SourceBindingApplicationPorts = Readonly<{
    native: SourceBindingNativeOwner;
    search: PublicFilterSearchBindingPort;
    access: PublicFilterAccessBindingPort;
}>;
export type SourceBindingApplication = Readonly<{
    createBinding(pool: Pool, routing: Uint8Array, access: Access): import('./public-filter-source-binding.ts').PublicFilterSourceBootstrapBinding;
    createSource(config: SourceBindingConfiguration): PublicFilterSource;
    sourceOrigin(source: PublicFilterSource): SourceBindingConfiguration | undefined;
    readDefinition(id: string, pool: Pool, routeDigest: string, maxBytes?: number): ReturnType<SourceBindingNativeOwner['readDefinition']>;
}>;
