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
/** Bind the current native Source and scoped capture at the caller's actual authoritative time.
 * Commands retain their executor time and partition; Search transfers its existing reservation and read time.
 */
export declare function bindOwnerFilterRead(dependencies: Omit<Dependencies, 'tokens'>, actor: Actor, collectionId: string, admission: CollectionMemberAdmission, deadline: number, attempt?: CommandAttempt): Promise<Unavailable | Readonly<{
    status: 'bound';
    binding: OwnerFilterReadBinding;
}>>;
/** Complete native original/fact closure, independently of positive candidate enumeration.
 * Missing coverage never supplies private absence, even underneath a negative filter branch.
 */
export declare function readOwnerFilterCandidateClosure(binding: OwnerFilterReadBinding, source: PreparedCollectionSource, subjectId: string, work: NativeCollectionWork, deferDisclosure?: boolean): Promise<Unavailable | Readonly<{
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
