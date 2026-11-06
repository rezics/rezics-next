import type { WorkAllowance, WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import type { SearchHit } from './query.ts';
import type { ScopeBasis } from './scope-source.ts';
import type { PublicFilterConsumerJob, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
/** Native output order, independent of structural Collection id/ordinal traversal. */
export type ScopeNativeOrder = 'name' | 'collections';
export type ScopeNameSortTuple = readonly [name: string | null, id: string];
/** Actual public_collection_count DESC (missing zero), then name_sort/id ASC. */
export type ScopeCollectionsSortTuple = readonly [count: number, name: string | null, id: string];
/** Immutable retained output definition. Structural Source traversal keeps its own order. */
export type ScopeOrderedDefinition = Readonly<{
    nativeOrder: ScopeNativeOrder;
    pageSize: number;
    index: string;
    uuid: string;
    generation: number;
}>;
/** Native custody locators only; no Actor, permission or reconstructed start evidence. */
export type ScopeOrderedPreparation = Readonly<{
    queried: PublicFilterQueriedObservation | null;
    repair: PublicFilterConsumerJob | null;
    execution: string | null;
    populationFrontier?: string | null;
    populationComplete?: boolean;
}>;
export type ScopeOrderedPrefixRequest = ({
    order: 'name';
    after: ScopeNameSortTuple | null;
} | {
    order: 'collections';
    after: ScopeCollectionsSortTuple | null;
}) & {
    quota: number;
    budget: number;
    allowance: WorkAllowance;
};
type OrderedPrefix<Order extends ScopeNativeOrder, Tuple> = {
    order: Order;
    hits: readonly (Omit<SearchHit, 'sort'> & {
        sort: Tuple;
    })[];
    basis: ScopeBasis;
    /** Last settled raw tuple; unused lookahead never advances this frontier. */
    coveredThrough: Tuple | null;
    exhausted: boolean;
    usage: {
        candidates: number;
        /** Caller-root settlement; public is its native breakdown, never another charge/refund. */
        work: WorkReceipt;
        public: PublicFilterCost;
    };
};
export type SearchScopeOrderedPrefix = OrderedPrefix<'name', ScopeNameSortTuple> | OrderedPrefix<'collections', ScopeCollectionsSortTuple>;
/** Ordered preparation cannot fall back to the legacy compatibility reservation or size. */
export declare function validateScopeOrderedPrepare(options: {
    nativeOrder?: ScopeNativeOrder;
    pageSize?: number;
    allowance?: WorkAllowance;
}): void;
export declare function scopeOrderedNameKey(name: string | null): Buffer;
/** Native Lucene keyword order, including supplementary scalars and missing-last. */
export declare function compareScopeOrderedTuple(order: ScopeNativeOrder, left: readonly (string | number | null)[], right: readonly (string | number | null)[]): number;
/** Check actual native values without normalizing, canonicalizing or synthesizing a Hit. */
export declare function validateScopeOrderedHit(order: ScopeNativeOrder, hit: SearchHit, index: string): void;
export declare function emptyScopePublicCost(): PublicFilterCost;
export declare function addScopePublicCost(a: PublicFilterCost, b: PublicFilterCost): PublicFilterCost;
export declare function validateScopeOrderedPrefix(request: ScopeOrderedPrefixRequest): void;
export {};
