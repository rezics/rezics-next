import { type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type FacetRequest, type FacetValue } from './facets.ts';
import { type SearchHit } from './hits.ts';
import { type OpenSearch } from './opensearch.ts';
import { type SearchPlan } from './query.ts';
import { type PublicRatingSource } from './rating-source.ts';
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
export declare function createSearchService({ pool, client, prefix, source, ratings, cursors, clock, facetSample, release, }: {
    pool: Pool;
    client: OpenSearch;
    prefix: string;
    source: SubjectSource;
    ratings?: PublicRatingSource;
    cursors: KeyRing;
    clock?: KernelClock;
    release?: () => Promise<FilterRelease | null>;
    facetSample?: number;
}): {
    search(principal: 'anonymous' | `account:${string}`, request: SearchRequest, now?: number): Promise<{
        subjects: SearchHit[];
        next: string | null;
        as_of: string;
    }>;
    facets(principal: 'anonymous' | `account:${string}`, request: FacetRequest & {
        languages?: string[];
    }, now?: number): Promise<{
        facets: {
            property: string;
            values: Omit<FacetValue, "count">[];
        }[];
        as_of: string;
    }>;
    suggest(q: string, limit?: number, languages?: string[]): Promise<{
        subjects: Result[];
        as_of: string;
    }>;
};
export {};
