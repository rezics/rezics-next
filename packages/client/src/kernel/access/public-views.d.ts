import type { Pool, PoolClient } from 'pg';
export type PublicViews = Readonly<{
    posts: boolean;
    reviews: boolean;
    collections: boolean;
}>;
/** Presentation visibility only: callers still enforce each item's own visibility. */
export declare function readPublicViews(client: Pick<Pool | PoolClient, 'query'>, accountIds: readonly string[]): Promise<Map<string, PublicViews>>;
