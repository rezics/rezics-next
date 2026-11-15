import type { LibraryBulkReceiptBinding, LibraryBulkReceiptDisposition, LibraryBulkReceiptDispositionPort } from '../contract/index.ts';
import type { HistoryPool, HistoryTransaction } from '../contract/transaction.ts';
/** Worker composition installs the native History adapter before Library work registration. */
export declare function installLibraryBulkReceiptDispositionPort(port: LibraryBulkReceiptDispositionPort): void;
export declare function settleLibraryBulkReceiptDisposition(pool: HistoryPool, binding: LibraryBulkReceiptBinding): Promise<LibraryBulkReceiptDisposition | null>;
export declare function verifyLibraryBulkReceiptDisposition(tx: HistoryTransaction, binding: LibraryBulkReceiptBinding, disposition: LibraryBulkReceiptDisposition): Promise<boolean>;
