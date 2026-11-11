import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { RecordHistorySourceReference } from '../history/contract/index.ts';
import read from './imported-fields-history.sql';

/** Content-owned immutable association data only; disclosure and source authority remain separate. */
export async function readImportedFieldHistorySource(
  tx: CommandTransaction,
  documentId: string,
): Promise<Extract<RecordHistorySourceReference, { kind: 'contribution' }> | null> {
  const command = currentCommand(tx);
  const route = routeOf(documentId);
  if (route === null || partitionOf(route) !== command.partition)
    throw new RangeError('Imported field history requires the current document home command');
  const row = (await read.run(tx, { route, id: documentId }))[0];
  if (!row) return null;
  if (row.id !== documentId || routeOf(row.subject) !== route || routeOf(row.candidate) !== route)
    throw new RangeError('Invalid native imported field history source tuple');
  if (!Number.isSafeInteger(row.revision) || row.revision < 1)
    throw new RangeError('Invalid native imported field history source revision');
  return {
    kind: 'contribution',
    subjectId: row.subject,
    candidateId: row.candidate,
    revision: row.revision,
    documentId: row.id,
  };
}
