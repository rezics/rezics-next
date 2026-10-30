import { currentCommand, type CommandTransaction } from '../command/command.ts';
import type { ContextRoleProvenance } from '../access/shared-history-context.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { recordSemanticSourceCommit } from './erasure-producer.ts';

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
  input: Readonly<{ route: number; occurrence: ContextRoleProvenance }>,
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
  await recordSemanticSourceCommit(tx, command.transactionId);
  const result = await tx.query<{ state: string; context_key: string | null }>(
    `SELECT state,context_key::text FROM semantic.enroll_context_role_provenance(
      $1::integer,$2::bigint,$3::uuid,$4::uuid,$5::uuid,$6::text,$7::text,$8::text,$9::uuid,$10::uuid)`,
    [
      input.route,
      occurrence.occurrence,
      occurrence.resourceId,
      occurrence.originalCreator,
      occurrence.accountId,
      occurrence.grantRole,
      occurrence.valid,
      occurrence.side,
      occurrence.grantTransaction,
      occurrence.sourceTransaction,
    ],
  );
  const row = result.rows[0];
  if (row?.state === 'enrolled' && row.context_key !== null) {
    if (!/^[1-9][0-9]*$/.test(row.context_key)) throw new TypeError('Invalid native Context erasure key');
    return { state: 'enrolled', contextKey: row.context_key };
  }
  if (row?.state === 'not-applicable') return { state: 'not-applicable' };
  return { state: 'pending' };
}
