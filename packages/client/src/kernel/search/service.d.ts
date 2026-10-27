import { type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
import { type FacetRequest, type FacetValue } from './facets.ts';
import { type SearchHit } from './hits.ts';
import { type OpenSearch } from './opensearch.ts';
import { type SearchPlan } from './query.ts';
import type { SubjectSource } from './source.ts';
export type SearchRequest = {
    text?: string;
    filter?: unknown;
    sort?: SearchPlan['sort'];
    limit?: number;
    cursor?: string;
    descriptions?: boolean;
    languages?: string[];
    properties?: string[];
};
type Result = {
    id: string;
    type: string;
    labels: Record<string, string>;
};
export declare function createSearchService({ pool, client, prefix, source, cursors, facetSample, release, }: {
    pool: Pool;
    client: OpenSearch;
    prefix: string;
    source: SubjectSource;
    cursors: KeyRing;
    release?: () => Promise<FilterRelease | null>;
    facetSample?: number;
}): {
    search(principal: 'anonymous' | `account:${string}`, request: SearchRequest, now?: number): Promise<{
        subjects: SearchHit[];
        total: {
            value: number;
            relation: 'exact' | 'lower_bound';
        };
        next: string | null;
        as_of: string;
    }>;
    facets(principal: 'anonymous' | `account:${string}`, request: FacetRequest & {
        languages?: string[];
    }, now?: number): Promise<{
        facets: {
            property: string;
            relation: "exact" | "lower_bound";
            values: FacetValue[];
        }[];
        total: {
            value: number;
            relation: 'exact' | 'lower_bound';
        };
        as_of: string;
    }>;
    suggest(q: string, limit?: number, languages?: string[]): Promise<{
        subjects: Result[];
        as_of: string;
    }>;
};
export {};
