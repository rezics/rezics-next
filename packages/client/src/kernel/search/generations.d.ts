import { type IndexAction, type SubjectDocument } from './document.ts';
import type { DiscoveryKey, DiscoveryRegistry, DiscoveryIndexAction } from './discovery.ts';
import type { SubjectListingSource } from './source.ts';
import { type DiscoveryTarget } from './account-discovery.ts';
import type { Pool } from 'pg';
import type { SpaceDiscoveryDependencyReadiness } from '../community/space-discovery-dependencies.ts';
import { observedWrite } from './indices.ts';
import { type OpenSearch } from './opensearch.ts';
export { observedWrite };
import type { SubjectSource } from './source.ts';
import type { SecondScopeDiscoveryKey, SecondScopeDiscoveryRecord } from './discovery-documents.ts';
export { discoveryConsumer } from './consumer-name.ts';
export { MAX_SUBJECT_GENERATIONS } from './generation-limit.ts';
export type RebuildReason = 'timeout' | 'mismatch' | 'busy' | 'running' | 'limit';
export type PartitionCount = {
    partition: number;
    indexed: number;
    source: number;
};
export declare class RebuildError extends Error {
    readonly reason: RebuildReason;
    readonly generation: number;
    readonly partitions: PartitionCount[];
    constructor(reason: RebuildReason, generation: number, partitions?: PartitionCount[]);
}
export declare function rebuildSubjects(options: {
    pool: Pool;
    search: OpenSearch;
    source: SubjectSource;
    prefix: string;
    runner: {
        refresh(): Promise<void>;
    };
    /** The real default worker owns identified reconciliation and alias activation. */
    publication?: 'native';
    /** Successor date projection. Omit to prepare the calendar format; null retains the legacy writer shape. */
    calendarFormat?: 1 | null;
    pollMs?: number;
    rounds?: number;
    timeoutMs?: number;
}): Promise<{
    generation: number;
    previous: number | null;
}>;
export type DiscoveryCapabilityBinding = Readonly<{
    physicalTarget: string;
    uuid: string;
    incarnation: string;
    witnesses: Readonly<Record<string, Extract<SpaceDiscoveryDependencyReadiness, {
        state: 'ready';
    }>>>;
}>;
export type DiscoveryGeneration = DiscoveryTarget & {
    state: string;
    kinds: string[];
    capability: DiscoveryCapabilityBinding | null;
};
/** Required public metadata kinds for a complete second-scope discovery generation. */
export declare const SECOND_SCOPE_PUBLIC_METADATA_KINDS: readonly ["collection", "review", "space"];
export type DiscoveryMetadataKind = (typeof SECOND_SCOPE_PUBLIC_METADATA_KINDS)[number];
export type DiscoveryMetadataProducer = Readonly<{
    kind: DiscoveryMetadataKind;
    owner: 'commerce' | 'content';
    readiness(): Promise<'ready' | 'preparing' | 'unavailable' | SpaceDiscoveryDependencyReadiness>;
    page(partition: number, after: Readonly<{
        route: number;
        id: string;
    }> | null, continuation: string | null, limit: number): Promise<Readonly<{
        position: bigint;
        epoch?: number;
        next: Readonly<{
            route: number;
            id: string;
        }> | null;
        continuation: string | null;
        keys: readonly SecondScopeDiscoveryKey[];
        records: readonly SecondScopeDiscoveryRecord[];
    }>>;
    read(partition: number, ids: readonly string[]): Promise<Readonly<{
        position: bigint;
        epoch?: number;
        keys: readonly SecondScopeDiscoveryKey[];
        records: readonly SecondScopeDiscoveryRecord[];
    }>>;
    position(partition: number): Promise<bigint>;
}>;
export type DiscoveryMetadataProducers = Readonly<Partial<Record<DiscoveryMetadataKind, DiscoveryMetadataProducer>>>;
/** Preserve the native witness verbatim; neither a position nor adapter installation is an epoch. */
export declare function discoveryCapabilityWitnesses(producers: DiscoveryMetadataProducers): Promise<Record<string, Readonly<{
    state: 'ready';
    generation: string;
    cut: string;
    capabilities: Readonly<{
        context: 'connected';
        media: 'connected';
        exposure: 'connected';
        'source-fence': "connected";
    }>;
}>>>;
export declare function discoveryCapabilityMatches(target: DiscoveryTarget, binding: DiscoveryCapabilityBinding | null | undefined, witnesses: DiscoveryCapabilityBinding['witnesses']): boolean;
/** Used before and after native work, including final disclosure on a retained physical target. */
export declare function assertDiscoveryCapabilityBinding(pool: Pool, target: DiscoveryTarget, producers: DiscoveryMetadataProducers): Promise<void>;
export type DiscoveryProducerRegistration = Readonly<{
    kind: string;
    owner: string;
}>;
/** A candidate cannot be populated or published from an incomplete native producer set. */
export declare class DiscoveryProducerCoverageError extends Error {
    readonly missingKinds: readonly string[];
    readonly unsupportedKinds: readonly string[];
    readonly duplicateKinds: readonly string[];
    constructor(input: {
        missingKinds: readonly string[];
        unsupportedKinds: readonly string[];
        duplicateKinds: readonly string[];
    });
}
/** A signed owner continuation was invalidated; never retry its retired cut forever. */
export declare class DiscoveryPopulationCutChangedError extends DiscoveryProducerCoverageError {
    constructor(kind: DiscoveryMetadataKind);
}
/** Validate readiness before allocation can create a physical target or population rows. */
export declare function assertDiscoveryProducerCoverage(registrations: readonly DiscoveryProducerRegistration[], requiredKinds?: readonly string[], producerKinds?: readonly string[]): void;
/** Descending primary-key seek for the historical high water, independent of retired-row count. */
export declare const DISCOVERY_GENERATION_HIGH_WATER_SQL = "SELECT generation::text FROM search.discovery_generation WHERE partition_no=0 AND prefix=$1 ORDER BY partition_no DESC, prefix DESC, generation DESC LIMIT 1";
/** Partial live index plus overflow LIMIT; a fourth live row is corrupt evidence. */
export declare const DISCOVERY_LIVE_GENERATIONS_SQL = "SELECT prefix,generation::float8 AS generation,index_uuid AS uuid,\n    incarnation::text,state,kinds,capability FROM search.discovery_generation WHERE partition_no=0 AND prefix=$1 AND state <> 'retired' ORDER BY partition_no, prefix, generation LIMIT 4";
export declare function discoveryGenerations(pool: Pool, prefix: string): Promise<DiscoveryGeneration[]>;
/** Short allocation transaction registers replay before any native population observation. */
export declare function allocateDiscovery(pool: Pool, prefix: string, registry: DiscoveryRegistry, requiredKinds?: readonly string[], producerKinds?: readonly string[]): Promise<void>;
/** One bounded maintenance step; failed external work leaves its actual frontier replayable. */
export declare function advanceDiscovery(options: {
    pool: Pool;
    search: OpenSearch;
    prefix: string;
    registry: DiscoveryRegistry;
    listing: SubjectListingSource;
    requiredKinds?: readonly string[];
    metadataProducers?: DiscoveryMetadataProducers;
}): Promise<void>;
/** CLI uses the same native factories and lifecycle as the default worker. */
export declare function rebuildDiscovery(options: {
    pool: Pool;
    search: OpenSearch;
    source: SubjectSource;
    listing: SubjectListingSource;
    prefix: string;
    routeKey: Uint8Array;
    requiredKinds?: readonly string[];
}): Promise<{
    generation: number;
    previous: number | null;
}>;
/** Shared native keyed observations for publication; no census or prepared output is completeness evidence. */
export declare function nativeGenerationActions(options: {
    pool: Pool;
    search: OpenSearch;
    index: string;
    partition: number;
    ids: readonly string[];
    obligation: bigint;
    registry?: DiscoveryRegistry;
    keys?: readonly DiscoveryKey[];
}): Promise<readonly (DiscoveryIndexAction | IndexAction<SubjectDocument>)[]>;
export declare class GenerationReconciliationMismatch extends Error {
    constructor();
}
/** Search-visible keyed evidence shared by ordinary and mixed physical generations.
 * Ordinary bodies belong to the supplied native writer (including foreign fences and rating decoration);
 * native mixed producers additionally provide their exact full projection for comparison here.
 */
export declare function assertNativeGenerationActionsVisible(search: OpenSearch, index: string, actions: readonly (DiscoveryIndexAction | IndexAction<SubjectDocument>)[]): Promise<number>;
