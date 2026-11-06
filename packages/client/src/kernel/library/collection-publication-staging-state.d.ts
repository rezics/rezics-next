import type { CanonicalCollectionPrefix } from './collection-source.ts';
import type { ScopeEvaluationProgress, SearchScopeEvaluation } from '../search/scope-source.ts';
export type CollectionPublicationFrontier = Readonly<{
    after: string | null;
    pending: Readonly<{
        subject: string;
        coveredThrough: string;
        lastInPage: boolean;
        sourceExhausted: boolean;
        progress: ScopeEvaluationProgress | null;
    }> | null;
    exhausted: boolean;
}>;
export declare const initialCollectionPublicationFrontier: () => CollectionPublicationFrontier;
/** Matching catalogue subjects are already the admitted population; Search applied the predicate. */
export declare function enterCataloguePublicationMembers(frontier: CollectionPublicationFrontier, subjects: readonly string[], exhausted: boolean): CollectionPublicationFrontier;
/** Consume a genuine unfiltered canonical Source prefix. Unused suffix/lookahead is charged but not settled.
 * A later step seeks again after the last settled key; no population array is retained in a work intent.
 */
export declare function enterCollectionPublicationPrefix(frontier: CollectionPublicationFrontier, page: CanonicalCollectionPrefix): CollectionPublicationFrontier;
/** All leaves, including negative/excluded leaves, must settle before the canonical key can advance.
 * Native raw exhaustion is deliberately held on the unfinished subject rather than promoted to query exhaustion.
 */
export declare function settleCollectionPublicationSubject(frontier: CollectionPublicationFrontier, evaluation: SearchScopeEvaluation): Readonly<{
    frontier: CollectionPublicationFrontier;
    included: boolean | null;
}>;
