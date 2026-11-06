import type { Pool } from 'pg';
import type { ScopeWorkContext } from '../search/scope-work-context.ts';
import type { Access } from '../request/access.ts';
export { COLLECTION_SOURCE_WORK_GROUP_LIMIT } from './canonical-source-limits.ts';
import { type CanonicalBasis, type CanonicalRawKey } from './canonical-source-store.ts';
import { type NativeCollectionMetadata } from './collection-source-native.ts';
import type { CollectionSourceObservation } from './collection-source.ts';
import type { WorkReceipt } from './contract/work-dimensions.ts';
export type CollectionSourceWorkDefinition = Awaited<ReturnType<(typeof import('../search/scope-work-context.ts'))['readScopeWorkDefinition']>>;
export type CollectionSourceWorkState = Readonly<{
    metadata: NativeCollectionMetadata;
    basis: CanonicalBasis;
    generation: string;
    observation: CollectionSourceObservation;
    definition: CollectionSourceWorkDefinition;
    /** Static work evidence only. It is never accepted as an allowance or commit token. */
    work: WorkReceipt;
}>;
/** Upper bounds follow the exact indexed statements in the canonical Source plan. */
export declare function COLLECTION_SOURCE_WORK_COST(): Readonly<{
    metadata: import("./canonical-source-bounds.ts").CanonicalSourceSqlBound;
    sourceScope: import("./canonical-source-bounds.ts").CanonicalSourceSqlBound;
    sourceHead: import("./canonical-source-bounds.ts").CanonicalSourceSqlBound;
    sourceGeneration: import("./canonical-source-bounds.ts").CanonicalSourceSqlBound;
    seek: import("./canonical-source-bounds.ts").CanonicalSourceSqlBound;
    group(limit: number): import("./canonical-source-bounds.ts").CanonicalSourceSqlBound;
    state: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
}>;
/** Rereads native admission before IO, then verifies the same source and current indexed generation. */
export declare function readCollectionSourceWorkState(pool: Pool, work: ScopeWorkContext, options: Readonly<{
    access: Access;
    deadline: number;
}>): Promise<CollectionSourceWorkState>;
/** Exact seek in the already admitted COMPLETE generation; empty seeks are part of the fixed declaration. */
export declare function seekCollectionSourceWorkGroup(work: ScopeWorkContext, state: CollectionSourceWorkState, after: string | null, options: Readonly<{
    deadline: number;
}>): Promise<{
    subjectId: string | null;
    work: WorkReceipt;
}>;
export declare function readCollectionSourceWorkGroup(work: ScopeWorkContext, state: CollectionSourceWorkState, subjectId: string, after: CanonicalRawKey | null, limit: number, options: Readonly<{
    deadline: number;
}>): Promise<{
    rows: {
        key: CanonicalRawKey;
    }[];
    exhausted: boolean;
    work: WorkReceipt;
}>;
