import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { SearchLibraryScopePort } from './library-scope-port.ts';
/** Fixed selected-work schedule for one raw ordinal continuation. This bounds work; it grants no dispatch authority. */
export declare function SEARCH_SCOPE_ORDINAL_OPERATION(library: SearchLibraryScopePort): Readonly<{
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
/** Bind the Search application orchestration to the supplied Library capability. */
export declare function createSearchScopeOrder(config: Readonly<{
    pool: Pool;
    options: LeafOptions;
    clock: KernelClock;
    library: SearchLibraryScopePort;
}>): {
    prepare(order: import("./library-scope-port.ts").SearchScopeOrder, allowance: import("./scope-execution.ts").WorkAllowance): Promise<Readonly<{
        collection: import("./library-scope-port.ts").SearchScopeCollection;
        work: WorkReceipt;
    }>>;
    rawOrdinal(collection: import("./library-scope-port.ts").SearchScopeCollection, after: import("./library-scope-port.ts").NativeOrdinalKey | null, limit: number, allowance: import("./scope-execution.ts").WorkAllowance): Promise<Readonly<{
        kind: 'raw_curated_ordinal_prefix';
        rows: readonly import("../library/contract/source.ts").NativeOrdinalRow[];
        frontier: import("./library-scope-port.ts").NativeOrdinalFrontier;
        exhausted: boolean;
        observation: import("../library/collection-source.ts").CollectionSourceObservation;
        work: WorkReceipt;
    }>>;
    prefix(collection: import("./library-scope-port.ts").SearchScopeCollection, afterSubjectId: string | null, allowance: import("./scope-execution.ts").WorkAllowance, candidateLimit?: number): Promise<import("../library/collection-source.ts").CanonicalCollectionPrefix>;
    contains(collection: import("./library-scope-port.ts").SearchScopeCollection, subjectId: string, allowance: import("./scope-execution.ts").WorkAllowance, progress?: import("./library-scope-port.ts").CollectionAliasProgress): Promise<import("../library/collection-source.ts").CollectionSubjectMembership>;
};
export { sameScopeObservation } from './scope-application.ts';
export type { SearchScopeCollection, SearchScopeOrder, SearchScopeOrdinalPrefix } from './library-scope-port.ts';
