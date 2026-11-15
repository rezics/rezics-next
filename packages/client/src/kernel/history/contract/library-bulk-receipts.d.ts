import type { HistoryPool, HistoryTransaction } from './transaction.ts';
export declare const LIBRARY_BULK_TARGET_COMMAND_KIND = "library.collectionBulk.target";
export declare const LIBRARY_BULK_TARGET_COMMAND_KIND_ID = 4000;
export type LibraryBulkReceiptLocator = Readonly<{
    partition: number;
    principalKind: 'account';
    principalId: string;
    commandKind: typeof LIBRARY_BULK_TARGET_COMMAND_KIND;
    key: string;
    digest: string;
}>;
export type LibraryBulkReceiptBinding = Readonly<{
    accountRoute: number;
    accountId: string;
    operationId: string;
    sourceDigest: string;
    ordinal: string;
    receipt: LibraryBulkReceiptLocator;
}>;
declare const libraryBulkReceiptDisposition: unique symbol;
export type LibraryBulkReceiptDisposition = {
    readonly [libraryBulkReceiptDisposition]: true;
};
export type LibraryBulkReceiptDispositionPort = Readonly<{
    /** Settle one exact remote receipt under its source account's committed erasure barrier. */
    settle(pool: HistoryPool, binding: LibraryBulkReceiptBinding): Promise<LibraryBulkReceiptDisposition | null>;
    /** Verify the returned capability against the still-locked source manifest row. */
    verify(tx: HistoryTransaction, binding: LibraryBulkReceiptBinding, disposition: LibraryBulkReceiptDisposition): Promise<boolean>;
}>;
export {};
