import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type CollectionSourceObservation, type CollectionAliasProgress, type PreparedCollectionSource, type WorkAllowance, type WorkReceipt } from '../library/collection-source.ts';
import type { NativeOrdinalFrontier, NativeOrdinalKey, RawOrdinalCollectionPrefix } from '../library/collection-source-order.ts';
import { type NativeSourceIdentity } from '../library/native-source-custody.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
/** Internal Source locator, never an authority assertion or public Search sort. */
export type SearchScopeOrder = Readonly<{
    kind: 'id';
    source?: NativeSourceIdentity;
}> | Readonly<{
    kind: 'ordinal';
    source: NativeSourceIdentity;
}>;
export type SearchScopeOrdinalPrefix = Readonly<{
    subjects: readonly Readonly<{
        subject: string;
        after: NativeOrdinalKey;
    }>[];
    frontier: NativeOrdinalFrontier;
    exhausted: boolean;
    observation: CollectionSourceObservation;
    work: WorkReceipt;
}>;
export type SearchScopeCollection = Readonly<{
    order: SearchScopeOrder;
    source: PreparedCollectionSource;
    observation: CollectionSourceObservation;
}>;
/** CLOSED adapter API. Native rows/frontiers/work keep their Library type home.
 * Raw ordinal exhaustion describes input only. Search preparation resolves identity,
 * current disclosure and DISTINCT before selecting an output page.
 */
export declare function createSearchScopeOrder(config: Readonly<{
    pool: Pool;
    options: LeafOptions;
    clock: KernelClock;
}>): {
    prepare(order: SearchScopeOrder, allowance: WorkAllowance): Promise<{
        collection: SearchScopeCollection;
        work: WorkReceipt;
    }>;
    rawOrdinal(collection: SearchScopeCollection, after: NativeOrdinalKey | null, limit: number, allowance: WorkAllowance): Promise<RawOrdinalCollectionPrefix>;
    prefix(collection: SearchScopeCollection, afterSubjectId: string | null, allowance: WorkAllowance): Promise<import("../library/collection-source.ts").CanonicalCollectionPrefix>;
    contains(collection: SearchScopeCollection, subjectId: string, allowance: WorkAllowance, progress?: CollectionAliasProgress): Promise<import("../library/collection-source.ts").CollectionSubjectMembership>;
};
/** Full scoped observation comparison; a committed revision alone is not a Source identity. */
export declare function sameScopeObservation(a: IdentityScopeObservation, b: IdentityScopeObservation): boolean;
