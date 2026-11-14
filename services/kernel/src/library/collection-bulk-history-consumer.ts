import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { settleLibraryBulkReceiptDisposition, verifyLibraryBulkReceiptDisposition } from '../history/application/library-bulk-receipts.ts';
import type { LibraryBulkReceiptBinding, LibraryBulkReceiptDisposition } from '../history/contract/index.ts';
import { routeOf } from '../route/route.ts';
import type { BulkAdmission } from './bulk-contract.ts';
import type { LibraryBulkReceiptLocator } from '../history/contract/index.ts';

export type CollectionBulkHistoryDisposition = Readonly<{
  binding: LibraryBulkReceiptBinding;
  disposition: LibraryBulkReceiptDisposition;
}>;

type SourceTarget = Readonly<{
  operationId: string;
  ordinal: string;
  sourceDigest: string;
  request: BulkAdmission;
  target: { kind: 'subject' | 'occurrence'; collectionId?: string };
  receipt: LibraryBulkReceiptLocator;
}>;

function isRemoteTarget(row: SourceTarget, route: number): boolean {
  const remoteAction =
    (row.request.action === 'add_to_collection' && row.target.kind === 'subject') ||
    (row.request.action === 'remove_from_collection' && row.target.kind === 'occurrence');
  const collectionId = row.target.collectionId ?? ('collectionId' in row.request ? row.request.collectionId : undefined);
  const collectionRoute = typeof collectionId === 'string' ? routeOf(collectionId) : null;
  return remoteAction && collectionRoute !== null && collectionRoute !== route;
}

/** Prepare exact target-home closures before opening the source-home cleanup command. */
export async function prepareCollectionBulkHistoryDispositions(
  pool: Pool,
  route: number,
  accountId: string,
): Promise<readonly CollectionBulkHistoryDisposition[]> {
  const rows = await withConnection(pool, async (client) =>
    (
      await client.query<SourceTarget>(
        `SELECT target.operation_id AS "operationId",target.ordinal::text AS ordinal,
          operation.source_digest AS "sourceDigest",operation.request,target.target,target.receipt
         FROM library.bulk_operation operation
         JOIN library.bulk_target target ON target.route=operation.route
           AND target.operation_id=operation.operation_id AND target.account_id=operation.account_id
         WHERE operation.route=$1 AND operation.account_id=$2
         ORDER BY target.operation_id,target.ordinal LIMIT 100`,
        [route, accountId],
      )
    ).rows,
  );
  const settled: CollectionBulkHistoryDisposition[] = [];
  for (const row of rows) {
    if (!isRemoteTarget(row, route) || row.receipt.principalId !== accountId) continue;
    const binding: LibraryBulkReceiptBinding = {
      accountRoute: route,
      accountId,
      operationId: row.operationId,
      sourceDigest: row.sourceDigest,
      ordinal: row.ordinal,
      receipt: row.receipt,
    };
    const disposition = await settleLibraryBulkReceiptDisposition(pool, binding);
    if (disposition) settled.push({ binding, disposition });
  }
  return settled;
}

/** Capabilities are checked against the locked source rows before SQL receives only their keys. */
export async function verifyCollectionBulkHistoryDispositions(
  tx: CommandTransaction,
  route: number,
  accountId: string,
  prepared: readonly CollectionBulkHistoryDisposition[],
): Promise<readonly Readonly<{ operation_id: string; ordinal: string }>[]> {
  const verified: { operation_id: string; ordinal: string }[] = [];
  for (const item of prepared.slice(0, 100)) {
    if (
      item.binding.accountRoute === route &&
      item.binding.accountId === accountId &&
      (await verifyLibraryBulkReceiptDisposition(tx, item.binding, item.disposition))
    )
      verified.push({ operation_id: item.binding.operationId, ordinal: item.binding.ordinal });
  }
  return verified;
}
