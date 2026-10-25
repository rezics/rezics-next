import type { Pool } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
import { type OpenSearch } from './opensearch.ts';
import { type SearchPlan } from './query.ts';
import type { SubjectSource } from './source.ts';
export type SearchRequest = {
    text?: string;
    filter?: unknown;
    sort?: SearchPlan['sort'];
    page_size?: number;
    page_token?: string;
};
type Result = {
    id: string;
    type: string;
    labels: Record<string, string>;
};
export declare function createSearchService({ pool, client, prefix, source, cursors, }: {
    pool: Pool;
    client: OpenSearch;
    prefix: string;
    source: SubjectSource;
    cursors: KeyRing;
}): {
    search(principal: 'anonymous' | `account:${string}`, request: SearchRequest, now?: number): Promise<{
        results: Result[];
        total: {
            value: number;
            relation: 'exact' | 'lower_bound';
        };
        next_page_token: string | null;
        as_of: string;
    }>;
    suggest(q: string, limit?: number): Promise<{
        results: Result[];
        as_of: string;
    }>;
};
export {};
