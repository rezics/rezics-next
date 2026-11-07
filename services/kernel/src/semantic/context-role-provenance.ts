import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { contextAccess, type ContextRoleOccurrenceInput } from './context-access-port.ts';
import enroll from './context-role-provenance.sql';

export type ContextRoleEnrollmentResult =
  | Readonly<{ state: 'enrolled'; contextKey: string }>
  | Readonly<{ state: 'pending' }>
  | Readonly<{ state: 'not-applicable' }>;

/** Access must lock and validate its native occurrence before calling this Source port.
 * Enrollment shares the caller's command and its deferred native commit constraint.
 * It grants no permission and acknowledges no history receiving or account closure.
 */
export async function enrollContextRoleProvenance(
  tx: CommandTransaction,
  input: Readonly<{ route: number; occurrence: ContextRoleOccurrenceInput }>,
): Promise<ContextRoleEnrollmentResult> {
  const command = currentCommand(tx);
  const occurrence = input.occurrence;
  if (
    command.partition !== partitionOf(input.route) ||
    routeOf(occurrence.resourceId) !== input.route ||
    occurrence.resourceType !== 'semantic.context'
  )
    return { state: 'pending' };
  if (!/^[1-9][0-9]{0,18}$/.test(occurrence.occurrence) || BigInt(occurrence.occurrence) > 9223372036854775807n)
    throw new TypeError('Invalid native Context role occurrence');
  const port = contextAccess();
  await tx.query('SAVEPOINT semantic_context_role_enrollment');
  await port.recordSourceCommit(tx, command.transactionId);
  const result = await enroll.run(tx, {
    route: input.route,
    occurrence: occurrence.occurrence,
    resource_id: occurrence.resourceId,
    original_creator: occurrence.originalCreator,
    account_id: occurrence.accountId,
    grant_role: occurrence.grantRole,
    valid: occurrence.valid,
    side: occurrence.side,
    grant_transaction: occurrence.grantTransaction,
    source_transaction: occurrence.sourceTransaction,
  });
  const row = result[0];
  if (row?.state !== 'enrolled') await tx.query('ROLLBACK TO SAVEPOINT semantic_context_role_enrollment');
  await tx.query('RELEASE SAVEPOINT semantic_context_role_enrollment');
  if (row?.state === 'enrolled' && row.contextKey !== null) {
    if (!/^[1-9][0-9]*$/.test(row.contextKey)) throw new TypeError('Invalid native Context erasure key');
    return { state: 'enrolled', contextKey: row.contextKey };
  }
  if (row?.state === 'not-applicable') return { state: 'not-applicable' };
  return { state: 'pending' };
}
