import type { FilterRelease } from '@rezics/filter';
import type { Facet } from './facets.ts';
import { type OpenSearch, type SearchRequestWork } from './opensearch.ts';
import type { RatingPhase } from './rating-cursor.ts';
import type { PublicRatingEpoch } from './rating-source.ts';
export declare const HIT_TEMPLATE = "subjects-hits-v1";
export declare const SCOPE_HIT_TEMPLATE = "subjects-scope-hits-v1";
export declare const SEARCH_TEMPLATE = "subjects-search-v2";
export declare const SUGGEST_TEMPLATE = "subjects-suggest-v1";
export declare const FACET_TEMPLATE = "subjects-facets-v1";
export declare const TOTAL_LIMIT = 10000;
type SortValue = string | number | null;
export type SearchPlan = {
    query?: Record<string, unknown>;
    filter?: Record<string, unknown>;
    boost?: string;
    sort: 'relevance' | 'name' | 'id' | 'collections' | 'rating';
    /** Internal native planner metadata, never HTTP body selectors. */
    rating?: PublicRatingEpoch;
    ratingPhase?: RatingPhase;
    generation?: number;
    size: number;
    after?: readonly SortValue[];
    /** Distinct statement properties in the admitted filter. */
    overflowProperties?: readonly string[];
    /** Internal native request allowance; never a public query or sort. */
    work?: SearchRequestWork;
};
export type SubjectHit = {
    id: string;
    index: string;
    partition: number;
    securityRevision: number;
};
export type SearchHit = SubjectHit & {
    ratingPhase?: RatingPhase;
    matched: string[];
    sort: SortValue[];
};
export type SearchResult = {
    generation?: number;
    hits: SearchHit[];
    total: {
        value: number;
        relation: 'exact' | 'lower_bound';
    };
    overflow?: boolean;
};
export type HitResult = Omit<SearchResult, 'total'>;
export declare function installTemplates(search: OpenSearch, prefix: string): Promise<void>;
export declare function searchSubjects(search: OpenSearch, prefix: string, plan: SearchPlan): Promise<SearchResult>;
export declare function searchSubjectHits(search: OpenSearch, prefix: string, plan: SearchPlan): Promise<HitResult>;
export declare function suggestSubjects(search: OpenSearch, prefix: string, plan: {
    text: string;
    size: number;
    generation?: number;
}): Promise<SubjectHit[]>;
export declare function countFacets(search: OpenSearch, prefix: string, plan: {
    query?: Record<string, unknown>;
    filter?: Record<string, unknown>;
    /** Distinct statement properties in the admitted filter. */
    overflowProperties?: readonly string[];
    generation?: number;
    facets: readonly Facet[];
    sample: number;
}): Promise<{
    total: {
        value: number;
        relation: 'exact' | 'lower_bound';
    };
    facets: {
        property: string;
        relation: "exact" | "lower_bound";
        values: {
            value: string;
            count: number;
        }[];
    }[];
}>;
type PublicLabel = {
    value: string;
    language: string;
};
export type KindValue = {
    value: string;
    label: PublicLabel;
    icon: string | null;
    count?: {
        value: number;
        exact: false;
    };
};
export type KindSnapshot = {
    digest: string;
    label: (kind: string, languages: readonly string[]) => PublicLabel;
    page: (after: string | undefined, languages: readonly string[], witnesses?: ReadonlyMap<string, number>) => {
        values: KindValue[];
        after: string | null;
    };
};
/** Four live entries, covering the three-generation admission cap. Eviction drops cache ownership only. */
export declare const CURRENT_METADATA_RETENTION = 4;
export declare function retainCurrent<K, V>(cache: Map<K, V>, key: K, create: () => V): V;
/** Mutable injected releases have no identity authority. Native callers supply the immutable release digest. */
export declare function kindDigest(release: FilterRelease): string;
/** Own every row and label map; request work is one direct lookup plus at most eight rows. */
export declare function compileKinds(release: FilterRelease, digest: string): KindSnapshot;
export {};
