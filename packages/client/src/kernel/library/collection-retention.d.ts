import type { CollectionCleanupPage, CollectionDeletionKey } from './contract/index.ts';
export type { CollectionCleanupPage, CollectionDeletionKey } from './contract/index.ts';
import type { Pool, PoolClient } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type CommandTransaction } from '../command/command.ts';
import type { WorkContext } from '../work/registry.ts';
export declare const COLLECTION_RETENTION_WORKFLOW = "library.collectionRetention";
export declare const COLLECTION_RETENTION_SCHEDULE = "library.collectionRetention.every-10-minutes";
type Cursor = {
    partition: number;
    after: {
        purgeAfter: string;
        route: number;
        collectionId: string;
    } | null;
};
export declare function pageDueCollectionDeletions(connection: Pick<PoolClient, 'query'>, input: {
    partition: number;
    cutoff: string;
    after: Cursor['after'];
}): Promise<CollectionDeletionKey[]>;
/** One ordinary physical transaction. No user Actor, grant or receipt authority is fabricated.
 * An interrupted step repeats the remaining keys; restore/redelete is checked before every page.
 */
export declare function purgeExpiredCollectionPage({ pool, clock, deadline }: {
    pool: Pool;
    clock?: KernelClock;
    deadline?: number;
}, key: CollectionDeletionKey): Promise<CollectionCleanupPage>;
/** Exact local seam for the existing terminal participant, inside its receipted command.
 * This never returns an Access ACK, source disposition, or global erasure certificate.
 */
export declare function purgeTerminalCollectionPage(tx: CommandTransaction, input: {
    accountId: string;
    collectionId: string;
}): Promise<CollectionCleanupPage>;
/** Installs on the one default Library runtime and existing bounded maintenance queue. */
export declare function registerCollectionRetention({ pool, client, clock }: WorkContext): Promise<void>;
