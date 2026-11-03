import type { DiscoveryFilterDocument, FilterDocument, OwnerLeaf } from '@rezics/filter';
import type { FactClause } from './disclosure/check.ts';
import type { RelationFacetMatch } from './source.ts';
/** The current Boolean expression over deduplicated, first-occurrence-ordered leaves. */
type CurrentPlan<Leaf> = {
    leaves: Leaf[];
    indices: Map<string, number>;
    /** Leaves with at least one occurrence under an even number of NOT nodes. */
    positive: Set<number>;
    /** Require exactly one true/false/not_proven result per leaf before evaluating any Boolean node. */
    evaluate(values: readonly RelationFacetMatch[]): RelationFacetMatch;
};
export type CurrentFilterPlan = CurrentPlan<FactClause>;
export type CurrentNativeLeaf = Readonly<{
    kind: 'catalogue';
    clause: FactClause;
}> | Readonly<{
    kind: 'owner';
    leaf: OwnerLeaf;
}>;
export type CurrentOwnerFilterPlan = CurrentPlan<CurrentNativeLeaf>;
export type CurrentRealmLeaf = CurrentNativeLeaf | Readonly<{
    kind: 'realm';
    id: string;
}>;
export type CurrentRealmFilterPlan = CurrentPlan<CurrentRealmLeaf>;
/** Request-only Realm leaves share the current three-valued Boolean interpreter. */
export declare function compileCurrentRealmFilter(filter: DiscoveryFilterDocument): CurrentRealmFilterPlan;
/** OR current evidence, preserving not_proven when no alternative is true; empty evidence is false. */
export declare function anyCurrentMatch(values: readonly RelationFacetMatch[]): RelationFacetMatch;
/** The existing disclosure clause key, including set-normalized values and qualifier clauses. */
export declare function currentClauseKey(clause: FactClause): string;
/** Tagged native keys preserve exact owner pins; only state.in has set semantics. */
export declare function currentOwnerClauseKey(leaf: CurrentNativeLeaf): string;
/** Catalogue compilation rejects owner predicates at every depth, before any source I/O. */
export declare function compileCurrentFilter(filter: FilterDocument): CurrentFilterPlan;
/** Native callers authorize and resolve every leaf; scalar evidence is not permission. No source reads. */
export declare function compileCurrentOwnerFilter(filter: FilterDocument): CurrentOwnerFilterPlan;
export {};
