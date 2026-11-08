import type { Pool, PoolClient } from 'pg';
import type { Item } from './contract/item-values.ts';
export type RelatedState = {
    id: string;
    visibility: string;
    security_revision: string;
    redirect: string | null;
    labels: Item['labels'];
};
/** Loads current related state; callers may reuse it only within their bounded read episode. */
export declare function loadRelated(client: object, ids: readonly string[]): Promise<Map<string, RelatedState>>;
/** Labels of the requested ids, following one redirect, from this related-read episode. */
export declare function readRelated(db: Pool | PoolClient, ids: readonly string[]): Promise<Record<string, {
    labels: Item['labels'];
    redirect?: string;
}>>;
