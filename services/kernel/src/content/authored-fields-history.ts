import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import read from './authored-fields-history.sql';
import type { RecordHistorySourceReference } from '../history/contract/index.ts';

/** Internal association data only: no disclosure, maintenance or completeness authority.
 * Missing native metadata returns null, including when historical custody is unknown.
 * The outer command owns the single declaration of all sources it actually copies.
 */
export async function readAuthoredFieldHistorySource(
  tx: CommandTransaction,
  documentId: string,
): Promise<Extract<RecordHistorySourceReference, { kind: 'contribution' }> | null> {
  const command = currentCommand(tx);
  const route = routeOf(documentId);
  if (route === null || partitionOf(route) !== command.partition)
    throw new RangeError('Authored field history requires the current document home command');
  const row = (await read.run(tx, { route, id: documentId }))[0];
  if (!row) return null;
  if (row.id !== documentId || routeOf(row.subject) !== route || routeOf(row.candidate) !== route)
    throw new RangeError('Invalid native authored field history source tuple');
  if (!Number.isSafeInteger(row.revision) || row.revision < 1)
    throw new RangeError('Invalid native authored field history source revision');
  return {
    kind: 'contribution',
    subjectId: row.subject,
    candidateId: row.candidate,
    revision: row.revision,
    documentId: row.id,
  };
}
