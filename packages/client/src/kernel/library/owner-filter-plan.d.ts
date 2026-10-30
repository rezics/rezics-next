import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { type KernelClock } from '../clock.ts';
import type { CommandAttempt } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { RelationFacetMatch } from '../search/source.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { LeafEvidence } from '../semantic/scope-leaf-evidence.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import { type PrepareCollectionSource, type PreparedCollectionSource } from './collection-source.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import { type CollectionMemberAdmission, type CollectionMemberQuery, type OwnerFilterFactLocator } from './owner-filter.ts';
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    routeKey?: Uint8Array;
    clock?: KernelClock;
    workClient?: () => Promise<WorkClient>;
};
type Unavailable = Readonly<{
    status: 'unavailable';
}>;
/** Private structural inputs to the Library matcher, never permission or an HTTP-supplied alias list.
 * The native Source binding must obtain the complete original population, including originals contributing
 * only exclusion/order evidence. A stored-ID point, returned candidate list or readMappings is not this closure.
 */
export type OwnerFilterCandidateClosure = Readonly<{
    subjectId: string;
    originals: readonly Readonly<{
        subjectId: string;
        facts: readonly OwnerFilterFactLocator[];
    }>[];
    releases: ReadonlyMap<string, Release>;
    catalogue: ReadonlyMap<string, LeafEvidence>;
}>;
export type OwnerFilterReadBinding = Readonly<{
    input: Extract<PrepareCollectionSource, {
        actor: Actor;
    }>;
    scope: IdentityScopeObservation;
}>;
/** Owned unavailable adapter for the common native read's existing T/reservation/scoped capture handoff.
 * A command consumer passes its actual attempt; the producer must bind that exact T and partition instead of
 * minting a read T. It must be replaced by the actual Source composition, not a Date, new budget or synthetic scope.
 */
export declare function bindOwnerFilterRead(_dependencies: Omit<Dependencies, 'tokens'>, _actor: Actor, _collectionId: string, _admission: CollectionMemberAdmission, _deadline: number, _attempt?: CommandAttempt): Promise<Unavailable | Readonly<{
    status: 'bound';
    binding: OwnerFilterReadBinding;
}>>;
/** The unavailable complete-original adapter is deliberately separate from candidate enumeration.
 * CollectionSource supplies candidates and current membership; neither implies complete private absence.
 * No positive native facts, empty closure, profile meaning or readiness is fabricated here.
 */
export declare function readOwnerFilterCandidateClosure(_binding: OwnerFilterReadBinding, _source: PreparedCollectionSource, _subjectId: string, _work: NativeCollectionWork): Promise<Unavailable | Readonly<{
    status: 'complete';
    closure: OwnerFilterCandidateClosure;
}>>;
/** All native points share the caller's snapshot and ledger. No Boolean branch skips authority or evidence. */
export declare function readOwnerFilterCandidate(client: Pick<PoolClient, 'query'>, admission: CollectionMemberAdmission, closure: OwnerFilterCandidateClosure, work: NativeCollectionWork): Promise<RelationFacetMatch>;
/** Full-page caller over the one Source and Search interpreter. An incomplete window is never a 200 page. */
export declare function readBoundOwnerFilterPage(deps: Dependencies, admission: CollectionMemberAdmission, options: CollectionMemberQuery, binding: OwnerFilterReadBinding): Promise<{
    members: {
        kind: 'dynamic';
        subjectId: string;
    }[];
    next: string | null;
} | {
    preparing: true;
}>;
export declare function readOwnerFilterPage(deps: Dependencies, actor: Actor, collectionId: string, options: CollectionMemberQuery, deadline: number): Promise<{
    members: {
        kind: 'dynamic';
        subjectId: string;
    }[];
    next: string | null;
} | {
    preparing: true;
}>;
export {};
