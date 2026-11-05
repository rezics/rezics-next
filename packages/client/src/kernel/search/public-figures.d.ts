import type { Pool } from 'pg';
import { type PublicFigureView } from '../rating/public-figure-http.ts';
import type { SearchHit } from './hits.ts';
export type PublicSearchHit = SearchHit & {
    figure: PublicFigureView;
};
/** Project only kept hits, on the backend that owns their native anchor partitions. */
export declare function publicHitFigures(pool: Pool, hits: readonly SearchHit[]): Promise<PublicSearchHit[]>;
