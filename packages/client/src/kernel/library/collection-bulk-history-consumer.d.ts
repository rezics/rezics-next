import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { LibraryBulkReceiptBinding, LibraryBulkReceiptDisposition } from '../history/contract/index.ts';
export type CollectionBulkHistoryDisposition = Readonly<{
    binding: LibraryBulkReceiptBinding;
    disposition: LibraryBulkReceiptDisposition;
}>;
/** Prepare exact target-home closures before opening the source-home cleanup command. */
export declare function prepareCollectionBulkHistoryDispositions(pool: Pool, route: number, accountId: string): Promise<readonly CollectionBulkHistoryDisposition[]>;
/** Capabilities are checked against the locked source rows before SQL receives only their keys. */
export declare function verifyCollectionBulkHistoryDispositions(tx: CommandTransaction, route: number, accountId: string, prepared: readonly CollectionBulkHistoryDisposition[]): Promise<readonly Readonly<{
    operation_id: string;
    ordinal: string;
}>[]>;
