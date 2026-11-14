import { installLibraryBulkReceiptDispositionPort } from '../application/index.ts';
import type { CommandTransaction } from '../../command/command.ts';
import type { HistoryRegistry } from '../contract/index.ts';
import { createLibraryBulkReceiptDispositionPort, libraryBulkReceiptReadiness } from './library-bulk-receipts.ts';

export function registerLibraryBulkReceiptConsumer(input: Readonly<{ history: HistoryRegistry }>): void {
  const port = createLibraryBulkReceiptDispositionPort(input.history);
  installLibraryBulkReceiptDispositionPort(port);
  input.history.registerOwner({
    name: 'library.collectionBulk.target',
    artifactType: 'command-receipt/v1',
    version: 1,
    async readiness(tx, artifact, barrier) {
      return libraryBulkReceiptReadiness(tx as CommandTransaction, artifact, barrier);
    },
  });
}
