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
import type { NativeOwnerFilterCeilings } from './owner-filter-native-binding.ts';
import { type CollectionSourceObservation, type PrepareCollectionSource, type PreparedCollectionSource } from './collection-source.ts';
import { NativeCollectionWork } from './collection-native-work.ts';
import { type CollectionMemberAdmission, type CollectionMemberQuery, type OwnerFilterFactLocator } from './owner-filter.ts';
import { type OrdinaryCollectionPagePlan } from './ordinary-read-bounds.ts';
import type { MembersPreparation, PreparationDefinitionInput } from './members-preparation.ts';
import type { NativeOwnerFilterCapability } from './contract/members-preparation.ts';
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    routeKey?: Uint8Array;
    clock?: KernelClock;
    workClient?: () => Promise<WorkClient>;
};
export type OwnerFilterPlanDependencies = Dependencies;
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
export type OwnerFilterReservation = Readonly<{
    reserve(dependencies: Readonly<{
        pool: Pool;
        access: Access;
        workClient: WorkClient;
    }>, actor: Actor, collectionId: string, definitions: readonly PreparationDefinitionInput[], options?: Parameters<MembersPreparation['reserve']>[3]): ReturnType<MembersPreparation['reserve']>;
}>;
export type OwnerFilterNativeOperations = NativeOwnerFilterCapability<Omit<Dependencies, 'tokens'>, Actor, CollectionMemberAdmission, OwnerFilterReadBinding, PreparedCollectionSource, NativeCollectionWork, OwnerFilterCandidateClosure, RelationFacetMatch, CommandAttempt, OrdinaryCollectionPagePlan, NativeOwnerFilterCeilings, CollectionSourceObservation, Pick<PoolClient, 'query'>, import('./owner-filter-native-binding.ts').NativeOwnerFilterBinding>;
export type OwnerFilterPlan = Readonly<{
    bindOwnerFilterRead(actor: Actor, collectionId: string, admission: CollectionMemberAdmission, deadline: number, attempt?: CommandAttempt, pagePlan?: OrdinaryCollectionPagePlan, ceilings?: NativeOwnerFilterCeilings): Promise<Unavailable | Readonly<{
        status: 'bound';
        binding: OwnerFilterReadBinding;
    }>>;
    readOwnerFilterCandidateClosure(binding: OwnerFilterReadBinding, source: PreparedCollectionSource, subjectId: string, work: NativeCollectionWork, deferDisclosure?: boolean): ReturnType<typeof readOwnerFilterCandidateClosureNative>;
    readOwnerFilterCandidate(client: Pick<PoolClient, 'query'>, admission: CollectionMemberAdmission, closure: OwnerFilterCandidateClosure, work: NativeCollectionWork): ReturnType<typeof readOwnerFilterCandidateNative>;
    readBoundOwnerFilterPage(admission: CollectionMemberAdmission, options: CollectionMemberQuery, binding: OwnerFilterReadBinding): Promise<{
        members: {
            kind: 'dynamic';
            subjectId: string;
        }[];
        next: string | null;
    } | {
        preparing: true;
    }>;
    readOwnerFilterPage(actor: Actor, collectionId: string, options: CollectionMemberQuery, deadline: number): ReturnType<typeof readOwnerFilterPageNative>;
}>;
declare function readOwnerFilterCandidateClosureNative(native: OwnerFilterNativeOperations, binding: OwnerFilterReadBinding, source: PreparedCollectionSource, subjectId: string, work: NativeCollectionWork, deferDisclosure?: boolean): Promise<Readonly<{
    status: 'unavailable';
} | {
    status: 'complete';
    closure: Readonly<{
        subjectId: string;
        originals: readonly Readonly<{
            subjectId: string;
            facts: readonly OwnerFilterFactLocator[];
        }>[];
        releases: ReadonlyMap<string, Release>;
        catalogue: ReadonlyMap<string, LeafEvidence>;
    }>;
}>>;
declare function readOwnerFilterCandidateNative(native: OwnerFilterNativeOperations, client: Pick<PoolClient, 'query'>, admission: CollectionMemberAdmission, closure: OwnerFilterCandidateClosure, work: NativeCollectionWork): Promise<RelationFacetMatch>;
declare function readOwnerFilterPageNative(deps: Dependencies, native: OwnerFilterNativeOperations, reservation: OwnerFilterReservation, actor: Actor, collectionId: string, options: CollectionMemberQuery, deadline: number): Promise<{
    members: {
        kind: 'dynamic';
        subjectId: string;
    }[];
    next: string | null;
} | {
    preparing: true;
}>;
/** All operations in this plan share the supplied native implementation and reservation capability. */
export declare function createOwnerFilterPlan(dependencies: Dependencies, native: OwnerFilterNativeOperations, reservation: OwnerFilterReservation): OwnerFilterPlan;
/** Compatibility operations used by Search delegate to the application installed by Library composition. */
export declare function bindOwnerFilterRead(dependencies: Omit<Dependencies, 'tokens'>, actor: Actor, collectionId: string, admission: CollectionMemberAdmission, deadline: number, attempt?: CommandAttempt, pagePlan?: OrdinaryCollectionPagePlan, ceilings?: NativeOwnerFilterCeilings): Promise<Readonly<{
    status: 'unavailable';
} | {
    status: 'bound';
    binding: Readonly<{
        input: Extract<PrepareCollectionSource, {
            actor: Actor;
        }>;
        scope: IdentityScopeObservation;
    }>;
}>>;
export declare function readOwnerFilterCandidateClosure(binding: OwnerFilterReadBinding, source: PreparedCollectionSource, subjectId: string, work: NativeCollectionWork, deferDisclosure?: boolean): Promise<Readonly<{
    status: 'unavailable';
} | {
    status: 'complete';
    closure: Readonly<{
        subjectId: string;
        originals: readonly Readonly<{
            subjectId: string;
            facts: readonly OwnerFilterFactLocator[];
        }>[];
        releases: ReadonlyMap<string, Release>;
        catalogue: ReadonlyMap<string, LeafEvidence>;
    }>;
}>>;
export declare function readOwnerFilterCandidate(client: Pick<PoolClient, 'query'>, admission: CollectionMemberAdmission, closure: OwnerFilterCandidateClosure, work: NativeCollectionWork): Promise<RelationFacetMatch>;
export declare function readBoundOwnerFilterPage(dependencies: Dependencies, admission: CollectionMemberAdmission, options: CollectionMemberQuery, binding: OwnerFilterReadBinding): Promise<{
    members: {
        kind: 'dynamic';
        subjectId: string;
    }[];
    next: string | null;
} | {
    preparing: true;
}>;
export declare function readOwnerFilterPage(dependencies: Dependencies, actor: Actor, collectionId: string, options: CollectionMemberQuery, deadline: number): Promise<{
    members: {
        kind: 'dynamic';
        subjectId: string;
    }[];
    next: string | null;
} | {
    preparing: true;
}>;
export {};
