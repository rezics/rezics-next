import { type FilterDocument, type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import type { WorkAllowance, WorkReceipt } from '../library/collection-source.ts';
import type { NativeOrdinalKey } from '../library/collection-source-order.ts';
import { type SearchScopeOrder, type SearchScopeOrdinalPrefix } from './service-scope-order.ts';
import type { LeafOptions, LeafProgress, LeafWork } from '../semantic/scope-leaf-evidence.ts';
import { type ScopeLeafPosition } from './scope-progress.ts';
import type { OpenSearch } from './opensearch.ts';
import type { SearchHit } from './query.ts';
import { type RelationFacetMatch, type SubjectSource } from './source.ts';
/** Independent native work reservation; none of these units are candidate keys. */
export type ScopeNativeBudget = Omit<LeafWork, 'keys'>;
/** One unfinished original/leaf; basis is the composite owner digest, never a native leaf basis. */
export type ScopeEvaluationProgress = Readonly<{
    subject: string;
    basis: string;
}> & Pick<NonNullable<ScopeLeafPosition>, 'leafOrdinal'> & Omit<LeafProgress, 'basis'>;
export type ScopeEvaluationReservation = Readonly<{
    /** Explicit remaining allowance in the caller's shared raw-key ledger, including alias and prefix work. */
    rawKeys: number;
    native: ScopeNativeBudget;
    progress?: ScopeEvaluationProgress | null;
    allowance?: WorkAllowance;
}>;
export type ScopeBasis = Readonly<{
    release: string;
    query: string;
    profile: string;
    canonical: string;
    generation: number;
    index: string;
}>;
/** Additive preparation controls; future metadata-budget fields belong on this same options object. */
export type ScopePrepareOptions = Readonly<{
    releaseDigest?: string;
    order?: SearchScopeOrder;
    /** Native caller's shared root; omitted legacy calls retain the bounded compatibility ceilings. */
    allowance?: WorkAllowance;
    /** Read an already published scope without retaining, preparing or saving reader progress. */
    readOnly?: boolean;
    /** Exact released projection type, when the source requires a selected catalogue profile. */
    type?: string;
}>;
declare const preparedScope: unique symbol;
/** Factory-local opaque state, never an Access or bearer allow claim. */
export type PreparedSearchScope = {
    readonly [preparedScope]: true;
    readonly readiness: 'ready';
    readonly basis: ScopeBasis;
};
export type SearchScopePrefix = {
    hits: readonly SearchHit[];
    basis: ScopeBasis;
    /** Last covered raw key, excluding unused lookahead; null only at the beginning. */
    coveredThrough: string | null;
    exhausted: boolean;
    usage: {
        candidates: number;
        work?: import('../library/collection-source.ts').WorkReceipt;
    };
};
export type SearchScopeEvaluation = {
    values: readonly RelationFacetMatch[];
    basis: ScopeBasis;
    usage: {
        keys: number;
        native: ScopeNativeBudget;
    };
    /** Native evidence references for final current revalidation, never allow tokens. */
    evidence: readonly string[];
    progress: ScopeEvaluationProgress | null;
};
/** Native service runtime, immutable admission and factory-local handles. Native producers
 * own structural capture, current authorization and evidence; this module owns execution.
 */
export declare function createSearchScopeSource({ pool, client, prefix, source: _source, release, evidence, clock, }: {
    pool: Pool;
    client: OpenSearch;
    prefix: string;
    source: SubjectSource;
    release?: () => Promise<FilterRelease | null>;
    evidence?: LeafOptions;
    clock?: KernelClock;
}): {
    /** Additive native caller accounting; opaque result shapes and the legacy evaluation ABI stay unchanged. */
    work(result: PreparedSearchScope | SearchScopeEvaluation): WorkReceipt;
    prepare(filter: FilterDocument, options?: ScopePrepareOptions): Promise<PreparedSearchScope>;
    prefix(prepared: PreparedSearchScope, request: {
        afterSubject: string | null;
        quota: number;
        budget: number;
        allowance?: WorkAllowance;
    }): Promise<SearchScopePrefix>;
    evaluate(prepared: PreparedSearchScope, subjects: readonly string[], reservation: ScopeEvaluationReservation): Promise<SearchScopeEvaluation>;
    sourcePrefix(prepared: PreparedSearchScope, request: {
        afterSubjectId: string | null;
        allowance: WorkAllowance;
    }): Promise<{
        basis: Readonly<{
            release: string;
            query: string;
            profile: string;
            canonical: string;
            generation: number;
            index: string;
        }>;
        work: WorkReceipt;
        kind: 'canonical_subject_prefix';
        candidates: readonly import("../library/collection-source.ts").CanonicalCollectionCandidate[];
        coveredThrough: string | null;
        exhausted: boolean;
        observation: import("../library/collection-source.ts").CollectionSourceObservation;
    }>;
    /** Raw native ordinal input, CURRENT canonical membership and native fact evidence are
     * consumed in order. This direct preview never truncates raw rows then post-sorts them.
     */
    ordinalPrefix(prepared: PreparedSearchScope, request: {
        after: NativeOrdinalKey | null;
        quota: number;
        allowance: WorkAllowance;
    }): Promise<SearchScopeOrdinalPrefix>;
};
export {};
