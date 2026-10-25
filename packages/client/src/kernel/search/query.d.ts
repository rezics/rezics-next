import type { Facet } from './facets.ts';
import type { OpenSearch } from './opensearch.ts';
export declare const SEARCH_TEMPLATE = "subjects-search-v1";
export declare const SUGGEST_TEMPLATE = "subjects-suggest-v1";
export declare const FACET_TEMPLATE = "subjects-facets-v1";
export declare const TOTAL_LIMIT = 10000;
type SortValue = string | number | null;
export type SearchPlan = {
    query?: Record<string, unknown>;
    filter?: Record<string, unknown>;
    boost?: string;
    sort: 'relevance' | 'name' | 'id' | 'collections';
    size: number;
    after?: readonly SortValue[];
};
export type SubjectHit = {
    id: string;
    index: string;
    partition: number;
    securityRevision: number;
};
export type SearchHit = SubjectHit & {
    matched: string[];
    sort: SortValue[];
};
export type SearchResult = {
    hits: SearchHit[];
    total: {
        value: number;
        relation: 'exact' | 'lower_bound';
    };
};
export declare function installTemplates(search: OpenSearch, prefix: string): Promise<void>;
export declare function searchSubjects(search: OpenSearch, prefix: string, plan: SearchPlan): Promise<SearchResult>;
export declare function suggestSubjects(search: OpenSearch, prefix: string, plan: {
    text: string;
    size: number;
}): Promise<SubjectHit[]>;
export declare function countFacets(search: OpenSearch, prefix: string, plan: {
    query?: Record<string, unknown>;
    filter?: Record<string, unknown>;
    facets: readonly Facet[];
    sample: number;
}): Promise<{
    total: {
        value: number;
        relation: 'exact' | 'lower_bound';
    };
    facets: {
        property: string;
        relation: SearchResult['total']['relation'];
        values: {
            value: string;
            count: number;
        }[];
    }[];
}>;
export {};
