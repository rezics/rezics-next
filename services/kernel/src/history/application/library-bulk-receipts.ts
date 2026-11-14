import type {
  LibraryBulkReceiptBinding,
  LibraryBulkReceiptDisposition,
  LibraryBulkReceiptDispositionPort,
} from '../contract/index.ts';
import type { HistoryPool, HistoryTransaction } from '../contract/transaction.ts';

let installed: LibraryBulkReceiptDispositionPort | undefined;

/** Worker composition installs the native History adapter before Library work registration. */
export function installLibraryBulkReceiptDispositionPort(port: LibraryBulkReceiptDispositionPort): void {
  if (installed && installed !== port) throw new TypeError('Library bulk receipt disposition already installed');
  installed = port;
}

function port(): LibraryBulkReceiptDispositionPort {
  if (!installed) throw new TypeError('Library bulk receipt disposition is unavailable');
  return installed;
}

export function settleLibraryBulkReceiptDisposition(
  pool: HistoryPool,
  binding: LibraryBulkReceiptBinding,
): Promise<LibraryBulkReceiptDisposition | null> {
  return port().settle(pool, binding);
}

export function verifyLibraryBulkReceiptDisposition(
  tx: HistoryTransaction,
  binding: LibraryBulkReceiptBinding,
  disposition: LibraryBulkReceiptDisposition,
): Promise<boolean> {
  return port().verify(tx, binding, disposition);
}
