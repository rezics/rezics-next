/** Native target dispatch independent of bulk workflow registration. */
import { isDeepStrictEqual } from 'node:util';
import { withConnection } from '../database/pool.ts';
import type { CommandTransaction, CommandOutcome } from '../command/command.ts';
import type { BulkDependencies, TargetCommand, AttemptResult } from './bulk-contract.ts';
import { executeCollectionBulkStatus, reconcileCollectionBulkStatus } from './collection-bulk-status.ts';
import {
  executeCollectionRemoveTarget as removeCapturedOccurrence,
  reconcileCollectionRemoveTarget,
} from './collection-bulk-remove.ts';
import { reconcileCollectionAddTarget } from './collection-bulk-add.ts';
import { reconcileLibraryRemovalTarget } from './collection-bulk-library-removal.ts';
import { readCollectionBulk } from './collection-bulk-store.ts';
export async function executeStatusTarget(
  _dependencies: BulkDependencies,
  _command: TargetCommand,
): Promise<AttemptResult> {
  return executeCollectionBulkStatus(_dependencies, _command);
}

export async function executeCollectionRemoveTarget(
  dependencies: BulkDependencies,
  command: TargetCommand,
): Promise<AttemptResult> {
  return removeCapturedOccurrence(dependencies, command);
}

/** Private source-bound accounting; can recover prior commits after revocation,
 * cannot restore an initiator, issue personal effects or disclose target data.
 */
export async function reconcileBulkTarget(
  dependencies: BulkDependencies,
  command: TargetCommand,
): Promise<AttemptResult | null> {
  const key = {
    route: command.source.route,
    accountId: command.receipt.principalId,
    operationId: command.source.id,
  };
  const operation = await withConnection(dependencies.pool, (client) =>
    readCollectionBulk(client as CommandTransaction, key),
  );
  if (
    !operation ||
    operation.phase === 'preview' ||
    operation.sourceDigest !== command.sourceDigest ||
    !isDeepStrictEqual(operation.initiator.operation, command.source)
  )
    return { kind: 'stop', reason: 'evidence_missing' };
  switch (operation.request.action) {
    case 'set_status':
      return reconcileCollectionBulkStatus(dependencies, command);
    case 'add_to_collection':
      return reconcileCollectionAddTarget(dependencies, command);
    case 'remove_from_collection':
      return reconcileCollectionRemoveTarget(dependencies, command);
    case 'remove_from_library':
      return reconcileLibraryRemovalTarget(dependencies, command);
  }
}
