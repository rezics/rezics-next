import type { CommandTransaction } from '../command/command.ts';
import { authoritativeTimeValue, currentCommand } from '../command/command.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { readSemanticLifecycle } from './lifecycle-state.ts';
import deleteContribution from './contribution-lifecycle-delete.sql';
import restoreContribution from './contribution-lifecycle-restore.sql';

/** Native source writer for the ordinary contribution command, after its existing original-revision
 * authorization. No actor, authorization callback, timestamp, disposition or document IDs are accepted.
 * Slot suppression/events stay with the contribution command and commit in this same transaction.
 */
export async function writeContributionRetentionLifecycle(
  tx: CommandTransaction,
  input: Readonly<{ subject: string; candidate: string; state: 'active' | 'deleted'; transactionId: string }>,
): Promise<boolean> {
  const command = currentCommand(tx);
  const route = routeOf(input.subject);
  const accountId = command.basis?.actorAccountId;
  const action = input.state === 'deleted' ? 'statement:delete' : 'statement:restore';
  if (
    route === null ||
    routeOf(input.candidate) !== route ||
    command.partition !== partitionOf(route) ||
    command.authorization?.mode !== 'execute' ||
    command.authorization.action !== action ||
    command.authorization.resource.route !== route ||
    input.transactionId !== command.transactionId ||
    !accountId
  )
    throw new TypeError('Ordinary record lifecycle requires its native authorized contribution command');
  await tx.query('SELECT subject_id FROM semantic.subject WHERE route=$1 AND subject_id=$2 FOR UPDATE', [
    route,
    input.subject,
  ]);
  const evidence = await readSemanticLifecycle(tx, {
    target: { kind: 'candidate', subject: input.subject, candidate: input.candidate },
    accountId,
    nativeT: command.time,
  });
  if (evidence?.owner?.kind !== 'write_basis')
    throw new TypeError('Contribution has no exact original author evidence');
  const candidate = (
    await tx.query<{ revision: number; statement: unknown }>(
      'SELECT revision,statement FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3 FOR UPDATE',
      [route, input.subject, input.candidate],
    )
  ).rows[0];
  if (!candidate) return false;
  if (evidence.state === input.state) return false;
  const at = authoritativeTimeValue(command.time);
  if (input.state === 'active') {
    const result = await restoreContribution.run(tx, {
      route,
      subject_id: input.subject,
      candidate_id: input.candidate,
      at,
    });
    if (!result.length) throw new Error('record_restore_expired');
    return true;
  }
  if (evidence.state !== 'active') throw new Error('record_restore_expired');
  const changed = await deleteContribution.run(tx, {
    route,
    subject_id: input.subject,
    candidate_id: input.candidate,
    revision: candidate.revision,
    transaction_id: command.transactionId,
    at,
  });
  if (!changed.length) throw new Error('record_lifecycle_changed');
  const generation = (
    await tx.query<{ deletion_generation: string }>(
      `SELECT deletion_generation::text FROM semantic.record_lifecycle
     WHERE route=$1 AND subject_id=$2 AND candidate_id=$3`,
      [route, input.subject, input.candidate],
    )
  ).rows[0]!.deletion_generation;
  // These are Content's stored native reference positions, never a search for arbitrary embedded UUIDs.
  await tx.query(
    `INSERT INTO semantic.record_retention_document
    (route,subject_id,candidate_id,deletion_generation,document_id)
    SELECT $1,$2,$3,$4,document::uuid FROM (
      SELECT statement#>>'{value,content,document}' AS document FROM semantic.candidate
       WHERE route=$1 AND subject_id=$2 AND candidate_id=$3
      UNION SELECT q#>>'{value,content,document}' FROM semantic.candidate c,
       LATERAL jsonb_array_elements(coalesce(c.statement->'qualifiers','[]')) q
       WHERE route=$1 AND subject_id=$2 AND candidate_id=$3
      UNION SELECT p#>>'{value,content,document}' FROM semantic.candidate c,
       LATERAL jsonb_array_elements(coalesce(c.statement->'references','[]')) r,
       LATERAL jsonb_array_elements(coalesce(r->'parts','[]')) p
       WHERE route=$1 AND subject_id=$2 AND candidate_id=$3
    ) documents WHERE document IS NOT NULL ON CONFLICT DO NOTHING`,
    [route, input.subject, input.candidate, generation],
  );
  return true;
}
