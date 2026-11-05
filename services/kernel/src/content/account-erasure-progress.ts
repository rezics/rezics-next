import type { Pool } from 'pg';
import { noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';

/** Records a late decision's retention deadline in the participant's durable progress. */
export async function recordAccountErasureStatementExpiry(
  deps: { pool: Pool },
  accountId: string,
  input: { expiresAt: Date; dueAt: string; ownerRoute: number; decisionId: string },
): Promise<void> {
  const route = routeOf(accountId);
  if (
    route === null ||
    !(input.expiresAt instanceof Date) ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    !Number.isFinite(Date.parse(input.dueAt)) ||
    routeOf(input.decisionId) !== input.ownerRoute
  )
    throw new TypeError('Invalid account erasure statement expiry');
  await runCommand(deps.pool, { partition: partitionOf(route) }, async (tx) => {
    const result = await tx.query(
      `UPDATE content.account_erasure_progress
       SET statements_kept_until=GREATEST(COALESCE(statements_kept_until,$3),$3)
       WHERE route=$1 AND account_id=$2`,
      [route, accountId, input.expiresAt.toISOString()],
    );
    if (!result.rowCount) throw new Error('Content account-erasure progress is missing for a late statement');
    await tx.query(
      `INSERT INTO content.account_erasure_statement(route,account_id,due_at,owner_route,decision_id)
       VALUES ($1,$2,$3::timestamptz,$4,$5) ON CONFLICT DO NOTHING`,
      [route, accountId, input.dueAt, input.ownerRoute, input.decisionId],
    );
    return noEffect(null);
  });
}

/** Mark a phase key before its source partition is changed, so a replay after a partial commit
 * cannot lose the participant's outcome or delivery evidence.
 */
export async function markAccountErasureFound(
  tx: CommandTransaction,
  accountId: string,
  kind: 'content' | 'delivery',
): Promise<void> {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid account erasure identity');
  await tx.query(
    `UPDATE content.account_erasure_progress SET
       content_found=content_found OR $3,
       delivery_found=delivery_found OR $4
     WHERE route=$1 AND account_id=$2`,
    [route, accountId, true, kind === 'delivery'],
  );
}

export async function noteAccountErasureFound(
  deps: { pool: Pool },
  accountId: string,
  kind: 'content' | 'delivery',
): Promise<void> {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid account erasure identity');
  await runCommand(deps.pool, { partition: partitionOf(route) }, async (tx) => {
    await markAccountErasureFound(tx, accountId, kind);
    return noEffect(null);
  });
}
