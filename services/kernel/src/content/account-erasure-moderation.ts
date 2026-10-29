import type { Pool } from 'pg';
import { partyPartition, partyRoute } from './party-locator.ts';

type Key = { kind: 'decision' | 'operation'; due_at: string; owner_route: number; owner_id: string };
type Cursor = Pick<Key, 'kind' | 'due_at' | 'owner_id'>;
function decode(after: string | null): Cursor | null {
  if (after === null) return null;
  const cursor = JSON.parse(Buffer.from(after, 'base64url').toString()) as Cursor;
  if (!['decision', 'operation'].includes(cursor.kind) || !Number.isFinite(Date.parse(cursor.due_at)))
    throw new TypeError('Invalid moderation erasure cursor');
  partyRoute(cursor.owner_id);
  return cursor;
}
function next(keys: Key[]): string | null {
  if (keys.length < 50) return null;
  const { kind, due_at, owner_id } = keys.at(-1)!;
  return Buffer.from(JSON.stringify({ kind, due_at, owner_id })).toString('base64url');
}
function validTime(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError('Invalid erasure time');
  return value.toISOString();
}
async function page(pool: Pool, accountId: string, after: string | null, asOf?: Date, erasedAt?: Date) {
  const route = partyRoute(accountId);
  const cursor = decode(after);
  return partyPartition(pool, route, async (client) => {
    const {
      rows: [obligation],
    } = await client.query<{ at: Date }>('SELECT at FROM access.erasure WHERE route=$1 AND account_id=$2', [
      route,
      accountId,
    ]);
    if (!obligation || (erasedAt && obligation.at.getTime() !== erasedAt.getTime()))
      throw new Error('Committed account erasure obligation is required');
    // Separate ranges avoid an OR that could turn a keyset seek into a filter.
    const { rows } = await client.query<Key>(
      `SELECT kind,due_at::text,owner_route,owner_id FROM content.party_locator AS locator
      WHERE route=$1 AND account_id=$2 ${asOf ? "AND kind='decision' AND due_at <= $3::timestamptz" : ''}
      ${cursor ? `AND (kind,due_at,owner_id) > ($${asOf ? 4 : 3},$${asOf ? 5 : 4}::timestamptz,$${asOf ? 6 : 5}::uuid)` : ''}
      ORDER BY locator.kind,locator.due_at,locator.owner_id LIMIT 50`,
      [
        route,
        accountId,
        ...(asOf ? [validTime(asOf)] : []),
        ...(cursor ? [cursor.kind, cursor.due_at, cursor.owner_id] : []),
      ],
    );
    return rows;
  });
}
async function forget(pool: Pool, accountId: string, key: Key) {
  await partyPartition(pool, partyRoute(accountId), async (client) => {
    await client.query(
      `DELETE FROM content.party_locator WHERE route=$1 AND account_id=$2 AND kind=$3 AND due_at=$4 AND owner_id=$5`,
      [partyRoute(accountId), accountId, key.kind, key.due_at, key.owner_id],
    );
  });
}

/** Platform cleanup under the committed obligation; never restore the initiator.
 * At most fifty account-local keys and one point mutation per owner key. No
 * connection or transaction survives a partition boundary. Pending keys remain
 * for a later sweep after the account fence terminates their native workflow.
 */
export async function eraseAccountModerationPage(
  deps: { pool: Pool },
  accountId: string,
  input: { erasedAt: Date; after: string | null },
): Promise<{ next: string | null; found: number; pending: number; statementsKeptUntil: Date | null }> {
  validTime(input.erasedAt);
  const keys = await page(deps.pool, accountId, input.after, undefined, input.erasedAt);
  let pending = 0;
  let statementsKeptUntil: Date | null = null;
  for (const key of keys) {
    const disposition = await partyPartition(deps.pool, key.owner_route, async (client) => {
      if (key.kind === 'decision') {
        const {
          rows: [row],
        } = await client.query<{ kept: boolean }>(
          `UPDATE content.moderation_decision
          SET decider_account_id=NULL, statement=CASE WHEN decided_at+interval '183 days' > $4 THEN statement ELSE '' END
          WHERE route=$1 AND decision_id=$2 AND (decider_account_id=$3 OR decider_account_id IS NULL)
          RETURNING statement <> '' AND decided_at+interval '183 days' > $4 AS kept`,
          [key.owner_route, key.owner_id, accountId, validTime(input.erasedAt)],
        );
        return row?.kept ? 'kept' : 'done';
      }
      const {
        rows: [operation],
      } = await client.query<{ native_workflow_id: string | null }>(
        'SELECT native_workflow_id FROM content.operation WHERE route=$1 AND operation_id=$2 FOR UPDATE',
        [key.owner_route, key.owner_id],
      );
      if (!operation) return 'done';
      if (!operation.native_workflow_id) return 'pending';
      const {
        rows: [workflow],
      } = await client.query<{ status: string }>('SELECT status FROM dbos.workflow_status WHERE workflow_uuid=$1', [
        operation.native_workflow_id,
      ]);
      if (!workflow || !['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(workflow.status))
        return 'pending';
      await client.query(
        `UPDATE content.operation SET
        initiator_account_id=CASE WHEN initiator_account_id=$3 THEN NULL ELSE initiator_account_id END,
        author_account_id=CASE WHEN author_account_id=$3 THEN NULL ELSE author_account_id END,
        actor_account_id=CASE WHEN actor_account_id=$3 THEN NULL ELSE actor_account_id END,
        original_operator_account_id=CASE WHEN original_operator_account_id=$3 THEN NULL ELSE original_operator_account_id END,
        actor_client_id=NULL,actor_requested_by=NULL
        WHERE route=$1 AND operation_id=$2`,
        [key.owner_route, key.owner_id, accountId],
      );
      return 'done';
    });
    if (disposition === 'pending') pending++;
    else if (disposition === 'kept') {
      const due = new Date(key.due_at);
      if (!statementsKeptUntil || due > statementsKeptUntil) statementsKeptUntil = due;
    } else await forget(deps.pool, accountId, key);
  }
  return { next: next(keys), found: keys.length, pending, statementsKeptUntil };
}

export async function purgeAccountStatementsPage(
  deps: { pool: Pool },
  accountId: string,
  input: { asOf: Date; after: string | null },
): Promise<{ next: string | null; found: number; nextDueAt: Date | null }> {
  validTime(input.asOf);
  const keys = await page(deps.pool, accountId, input.after, input.asOf);
  for (const key of keys) {
    await partyPartition(deps.pool, key.owner_route, async (client) => {
      await client.query(
        `UPDATE content.moderation_decision SET statement='',decider_account_id=NULL
        WHERE route=$1 AND decision_id=$2 AND decided_at+interval '183 days' <= $3
        AND (decider_account_id=$4 OR decider_account_id IS NULL)`,
        [key.owner_route, key.owner_id, validTime(input.asOf), accountId],
      );
    });
    await forget(deps.pool, accountId, key);
  }
  const nextDueAt = await partyPartition(deps.pool, partyRoute(accountId), async (client) => {
    const {
      rows: [row],
    } = await client.query<{ due_at: Date }>(
      `SELECT due_at FROM content.party_locator
      WHERE route=$1 AND account_id=$2 AND kind='decision' ORDER BY due_at,owner_id LIMIT 1`,
      [partyRoute(accountId), accountId],
    );
    return row?.due_at ?? null;
  });
  return { next: next(keys), found: keys.length, nextDueAt };
}
