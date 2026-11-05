import type { Pool } from 'pg';
import { type SourceFenceTuple } from '../content/source-fences.ts';
import type { SpaceDiscoveryInvalidation } from './space-discovery-events.ts';
export type SpaceDiscoveryTupleWitnessInput = Readonly<{
    spaceId: string;
    spaceRevision: string;
    realmId: string | null;
    realmRevision: string | null;
    producerGeneration: string;
    producerEpoch: string;
    sourcePosition: string;
    /** Native publishers bind their released source snapshot again at installation. */
    native?: Readonly<{
        epoch: number;
        position: string;
    }>;
    tuples: readonly SourceFenceTuple[];
    origin: SpaceDiscoveryInvalidation['origin'];
}>;
export type SpaceDiscoveryTupleWitness = Readonly<{
    state: 'preparing' | 'unavailable' | 'ready';
    /** Only a current owner read, with complete expected/reference coverage, can certify this. */
    complete?: true;
    native?: Readonly<{
        partition: number;
        generation: string;
        cut: string;
        epoch: number;
        position: string;
    }>;
    spaceId: string;
    spaceRevision?: string;
    realmId?: string | null;
    realmRevision?: string | null;
    producerGeneration?: string;
    producerEpoch?: string;
    sourcePosition?: string;
    witnessGeneration?: string;
    generation: string | null;
    cut: string | null;
    tuples: readonly SourceFenceTuple[];
}>;
/** Search registers one explicit, complete source census before its per-Space witnesses can be accepted. */
export declare function registerSpaceDiscoveryTupleProducer(pool: Pool, input: Readonly<{
    generation: string;
    cut: string;
    complete: true;
}>): Promise<void>;
/** Publish an exact current source-owner witness. Tuple inverse edges are installed at tuple home later. */
export declare function publishSpaceDiscoveryTupleWitness(pool: Pool, rawInput: SpaceDiscoveryTupleWitnessInput): Promise<SpaceDiscoveryTupleWitness>;
export type SpaceDiscoveryTupleWorkLocator = Readonly<{
    route: number;
    spaceId: string;
}>;
/** Indexed maintenance locator for tuple-home work; history never supplies a cursor. */
export declare function nextSpaceDiscoveryTupleWitnessWork(pool: Pool): Promise<SpaceDiscoveryTupleWorkLocator | null>;
/** Apply at most fifty inverse edges, each in tuple home, then acknowledge from the Space home. */
export declare function repairSpaceDiscoveryTupleWitness(pool: Pool, partition: number, spaceId: string, limit?: number): Promise<boolean>;
/** Exact current tuple witnesses with a pre/final fence read and capability cut recheck. */
export declare function readSpaceDiscoveryTupleWitnesses(pool: Pool, ids: readonly string[]): Promise<ReadonlyMap<string, SpaceDiscoveryTupleWitness>>;
