import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type AuthoritativeTime, type CommandAttempt } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, AccessContext, Actor } from '../request/access.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { type CanonicalAllowance, type CanonicalWork } from './canonical-source-store.ts';
import { type CollectionSourceObservation, type WorkAllowance, type WorkDimensions } from './collection-source.ts';
import { type NativeCollectionMetadata } from './collection-source-native.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import { type CollectionMemberAdmission } from './owner-filter.ts';
import type { OwnerFilterReadBinding } from './owner-filter-plan.ts';
import type { PublicFilterQueriedObservation } from '../search/public-filter-consumer-contract.ts';
import type { PublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import type { PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import type { FilterDocument } from '@rezics/filter';
import type { OrdinaryCollectionPagePlan } from './ordinary-read-bounds.ts';
type Dependencies = {
    pool: Pool;
    access: Access;
    routeKey?: Uint8Array;
    clock?: KernelClock;
};
/** References to an existing native execution, never a caller-issued safety assertion. */
export type OwnerFilterQueryRead = Readonly<{
    filter: FilterDocument;
    source: PublicFilterSource;
    binding: PublicFilterSourceBinding;
    queried: PublicFilterQueriedObservation;
    execution: string;
}>;
type NativeRead = Readonly<{
    actor: Actor;
    at: AuthoritativeTime;
    work: NativeCollectionWork;
    query?: OwnerFilterQueryRead;
}>;
/** Additive accounting port for an enclosing native reader, with no new binder or allowance.
 * The callback still calls bindOwnerFilterRead with its CLOSED arguments. The enclosing reader settles work.
 */
export declare function withOwnerFilterNativeRead<T>(input: NativeRead, read: () => Promise<T>): Promise<T>;
export type NativeOwnerFilterBinding = Readonly<{
    dependencies: Dependencies;
    admission: CollectionMemberAdmission;
    metadata: NativeCollectionMetadata;
    observation: CollectionSourceObservation;
    attempt?: CommandAttempt;
    ownsTime: boolean;
    ownerFence: string | null;
    query?: OwnerFilterQueryRead;
    pagePlan?: OrdinaryCollectionPagePlan;
    originals: Map<string, string>;
}>;
export type NativeOwnerFilterCeilings = Readonly<{
    /** Whole finite operation reservation; not an additional allocation or proof. */
    total: WorkDimensions;
    /** Static prefix retained by this binding phase before its remainder is transferred. */
    binding: WorkDimensions;
}>;
/** Only a direct ordinary read owns its minted read time. Commands/Search keep their caller's lifetime. */
export declare function releaseNativeOwnerFilterRead(binding: OwnerFilterReadBinding): void;
export declare function nativeOwnerFilterBinding(binding: OwnerFilterReadBinding): NativeOwnerFilterBinding | undefined;
export declare function nativeOwnerFilterPagePlan(binding: OwnerFilterReadBinding): OrdinaryCollectionPagePlan | undefined;
/** Every declared consumer reenters with its actual immutable binding and transferred ledger. */
export declare function withNativeOwnerFilterSource<T>(binding: OwnerFilterReadBinding, work: NativeCollectionWork, body: () => Promise<T>): Promise<T>;
export declare function sameOwnerFilterSource(left: CollectionSourceObservation, right: CollectionSourceObservation): boolean;
export declare const ownerFilterUnavailable: () => ProblemError;
/** Keep every original actually used, including rejected and order-only support, until final disclosure. */
export declare function retainOwnerFilterOriginal(binding: OwnerFilterReadBinding, original: string, terminal: string): void;
export declare function revalidateOwnerFilterDisclosure(binding: OwnerFilterReadBinding, work: NativeCollectionWork): Promise<void>;
export declare function ownerFilterAllowance(work: NativeCollectionWork): WorkAllowance;
export declare function ownerFilterCanonicalAllowance(allowance: WorkAllowance): CanonicalAllowance;
export declare function ownerFilterCanonical<T extends {
    work: CanonicalWork;
}>(work: NativeCollectionWork, read: (allowance: CanonicalAllowance) => Promise<T>): Promise<T>;
/** Reserve before dispatch, including failure and control work. No result size substitutes for row work. */
export declare function ownerFilterBounded<T>(work: NativeCollectionWork, cost: Partial<WorkDimensions>, read: () => Promise<T>): Promise<T>;
export declare function ownerFilterQuery<R extends QueryResultRow>(client: Pick<PoolClient, 'query'>, work: NativeCollectionWork, query: {
    sql: string;
    params: readonly string[];
}, input: Record<string, unknown>, cost: Partial<WorkDimensions>): Promise<R[]>;
export declare function ownerFilterAccessContext(dependencies: Dependencies, deadline: number, attempt?: CommandAttempt): AccessContext;
export declare function revalidateNativeOwnerFilter(binding: OwnerFilterReadBinding, work: NativeCollectionWork): Promise<void>;
/** No capture creation or repair occurs in a read. Only current native producer evidence can bind. */
export declare function bindNativeOwnerFilterRead(dependencies: Dependencies, actor: Actor, collectionId: string, admission: CollectionMemberAdmission, deadline: number, attempt?: CommandAttempt, pagePlan?: OrdinaryCollectionPagePlan, ceilings?: NativeOwnerFilterCeilings): Promise<{
    readonly status: 'unavailable';
    readonly binding?: never;
} | {
    readonly status: 'bound';
    readonly binding: Readonly<{
        input: Extract<import("./collection-source.ts").PrepareCollectionSource, {
            actor: Actor;
        }>;
        scope: IdentityScopeObservation;
    }>;
}>;
export {};
