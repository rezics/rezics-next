import type { RealmPresentationImage } from '../content/realm-media.ts';
import type { Access } from '../request/access.ts';
import type { Pool } from 'pg';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { type SpaceDiscoveryInvalidation } from './space-discovery-events.ts';
import type { CommunityAmbient } from './ambient.ts';
import { type SpaceDiscoveryDependencyReadiness } from './space-discovery-dependencies.ts';
import { type SpaceDiscoveryTupleWitness, type SpaceDiscoveryTupleWitnessInput } from './space-discovery-source-fences.ts';
export type { SpaceDiscoveryTupleWitness, SpaceDiscoveryTupleWitnessInput } from './space-discovery-source-fences.ts';
export declare const SPACE_DISCOVERY_NATIVE_EVENTS: string[];
/** Consumes committed native events only. The reader/bootstrap task owns population and hydration.
 * Removed identities must still resolve: an active-only Realm read would lose the removal delta.
 */
export declare function spaceDiscoveryInvalidation(pool: Pool, event: CloudEvent): Promise<SpaceDiscoveryInvalidation | null>;
/** Generic effects retain the original event and retry after a crash. A command receipt coalesces
 * repeat delivery; after receipt retention, another invalidation is safe because consumers reread truth.
 * Dependency targets represent one durable scope obligation, never a census in a mutation/effect.
 */
export declare function createSpaceDiscoveryEffect(pool: Pool): Effect;
export declare const SPACE_DISCOVERY_BATCH_SIZE = 100;
export type SpaceDiscoveryKey = Readonly<{
    route: number;
    id: string;
}>;
export type SpaceDiscoverySummary = Readonly<{
    id: string;
    realmId: string | null;
    address: string | null;
    title: string;
    realmTitle: string | null;
    name: string;
    description: string;
    avatar: RealmPresentationImage | null;
}>;
export type IndexedSpace = Omit<SpaceDiscoverySummary, 'avatar'> & Readonly<{
    revision: string;
}>;
export type SpaceDiscoverySnapshot = Readonly<{
    partition: number;
    position: bigint;
    spaces: readonly IndexedSpace[];
}>;
export type SpaceDiscoveryDependencies = Readonly<{
    pool: Pool;
    access: Access;
    clock: () => Date;
} & CommunityAmbient>;
export interface SpaceDiscoverySource {
    /** Dependency capability is separate from census and current hydration. */
    dependencies(): Promise<SpaceDiscoveryDependencyReadiness>;
    /** Exact Content source-fence provenance for selected current Space keys. */
    tupleWitnesses?(partition: number, ids: readonly string[]): Promise<ReadonlyMap<string, SpaceDiscoveryTupleWitness>>;
    /** Explicit source-owner census cut; an empty page is never registration evidence. */
    registerTupleProducer?(input: Readonly<{
        generation: string;
        cut: string;
        complete: true;
    }>): Promise<void>;
    /** Producer seam for an authoritative owner's exact current tuple witness. */
    publishTupleWitness?(input: SpaceDiscoveryTupleWitnessInput): Promise<SpaceDiscoveryTupleWitness>;
    read(partition: number, ids: readonly string[]): Promise<SpaceDiscoverySnapshot>;
    /** Internal generation census of retained native candidates, including ineligible identities. */
    count(partition: number): Promise<Readonly<{
        partition: number;
        position: bigint;
        count: number;
    }>>;
    /** At most limit candidates, without refill. next is the last examined native key. */
    page(partition: number, after: SpaceDiscoveryKey | null, limit: number): Promise<SpaceDiscoverySnapshot & Readonly<{
        next: SpaceDiscoveryKey | null;
    }>>;
}
/** Concrete native factory result with the complete source-tuple capability. */
export interface SpaceDiscoveryTupleSource extends SpaceDiscoverySource {
    tupleWitnesses: NonNullable<SpaceDiscoverySource['tupleWitnesses']>;
    registerTupleProducer: NonNullable<SpaceDiscoverySource['registerTupleProducer']>;
    publishTupleWitness: NonNullable<SpaceDiscoverySource['publishTupleWitness']>;
}
/** Producer-owned bootstrap interface. Search owns registration and generations;
 * neither this census nor an index hit supplies current disclosure authority.
 */
export declare function spaceDiscoverySource(deps: SpaceDiscoveryDependencies, context?: Readonly<{
    deadline: number;
}>): SpaceDiscoveryTupleSource;
/** Fixed current candidate hydration, always anonymous even for privileged Search callers. */
export declare function readSpaceDiscoverySummaries(deps: SpaceDiscoveryDependencies, ids: readonly string[], context: Readonly<{
    deadline: number;
}>): Promise<ReadonlyMap<string, SpaceDiscoverySummary>>;
