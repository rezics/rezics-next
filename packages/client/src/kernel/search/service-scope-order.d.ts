import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type CollectionSourceObservation, type CollectionAliasProgress, type PreparedCollectionSource } from '../library/collection-source.ts';
import { type WorkAllowance, type WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { NativeOrdinalFrontier, NativeOrdinalKey, RawOrdinalCollectionPrefix } from '../library/collection-source-order.ts';
import { type NativeSourceIdentity } from '../library/native-source-custody.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
/** Fixed selected-work schedule for one raw ordinal continuation. This bounds work; it grants no dispatch authority. */
export declare function SEARCH_SCOPE_ORDINAL_OPERATION(): Readonly<{
    axes: readonly ["candidateKeys", "nativeRows", "identityMetadataRows", "emptySeeks", "nativePoints", "witnessKeys", "statements", "bytes", "engineRequests"];
    rawLimit: 1;
    schedule: Readonly<{
        definitionGetters: 11;
        membersSnapshots: 4;
        orderCurrentnessReads: 2;
        sourcePrepare: 1;
        ordinalPrefix: 1;
        rawOrdinalRowsMaximum: 1;
        terminalQueriesBeforeEvaluationMaximum: 1;
        distinctGroupQueries: 1;
        earliestOrdinalProbesMaximum: 99;
        evaluatedSubjectsMaximum: 1;
        closurePasses: 2;
        terminalQueriesPerClosureMaximum: 49;
        factQueriesPerClosureMaximum: 50;
        ownerFactReadsPerClosureMaximum: 98;
        pinnedReleaseReadsPerClosureMaximum: 98;
        ownerCandidateReads: 2;
    }>;
    nativeStatement: Readonly<{
        limit: number;
        requestBytes: number;
        resultBytes: number;
        work: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    }>;
    terms: Readonly<{
        metadataPrefix: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        searchBody: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        collectionState: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        nativeOrdinal: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
        sourceTransaction: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    }>;
    cost: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    ceiling: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
}>;
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
    prefix(collection: SearchScopeCollection, afterSubjectId: string | null, allowance: WorkAllowance, candidateLimit?: number): Promise<import("../library/collection-source.ts").CanonicalCollectionPrefix>;
    contains(collection: SearchScopeCollection, subjectId: string, allowance: WorkAllowance, progress?: CollectionAliasProgress): Promise<import("../library/collection-source.ts").CollectionSubjectMembership>;
};
/** Full scoped observation comparison; a committed revision alone is not a Source identity. */
export declare function sameScopeObservation(a: IdentityScopeObservation, b: IdentityScopeObservation): boolean;
