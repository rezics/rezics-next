import type { Pool } from 'pg';
import { partyPartition, partyRoute } from './party-locator.ts';
import { noteAccountErasureFound, recordAccountErasureStatementExpiry } from './account-erasure-progress.ts';
import statementPage from './account-erasure-statements-page.sql';
import statementAfterPage from './account-erasure-statements-after-page.sql';
import deleteStatement from './account-erasure-statements-delete.sql';

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

/** Applies one content party locator's disposition for a late effect after the fence closes. */
export async function eraseAccountModerationItem(
  deps: { pool: Pool },
  accountId: string,
  input: { kind: 'decision' | 'operation'; dueAt: string; ownerRoute: number; ownerId: string },
  erasedAt: Date,
): Promise<{ pending: boolean; statementsKeptUntil: Date | null }> {
  validTime(erasedAt);
  if (partyRoute(input.ownerId) !== input.ownerRoute || !Number.isFinite(Date.parse(input.dueAt)))
    throw new TypeError('Invalid moderation erasure item');
  const key: Key = {
    kind: input.kind,
    due_at: input.dueAt,
    owner_route: input.ownerRoute,
    owner_id: input.ownerId,
  };
  const accountHome = partyRoute(accountId);
  const obligation = await partyPartition(deps.pool, accountHome, async (client) => {
    const {
      rows: [row],
    } = await client.query<{ at: Date }>('SELECT at FROM access.erasure WHERE route=$1 AND account_id=$2', [
      accountHome,
      accountId,
    ]);
    return row?.at ?? null;
  });
  if (!obligation || obligation.getTime() !== erasedAt.getTime())
    throw new Error('Committed account erasure obligation is required');
  const disposition = await partyPartition(deps.pool, key.owner_route, async (client) => {
    if (key.kind === 'decision') {
      const {
        rows: [row],
      } = await client.query<{ kept: boolean }>(
        `UPDATE content.moderation_decision
         SET decider_account_id=NULL,
             statement=CASE WHEN decided_at+interval '183 days' > $4 THEN statement ELSE '' END
         WHERE route=$1 AND decision_id=$2 AND (decider_account_id=$3 OR decider_account_id IS NULL)
         RETURNING statement <> '' AND decided_at+interval '183 days' > $4 AS kept`,
        [key.owner_route, key.owner_id, accountId, validTime(erasedAt)],
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
  if (disposition === 'pending') return { pending: true, statementsKeptUntil: null };
  if (disposition === 'kept') {
    const expiresAt = new Date(key.due_at);
    await recordAccountErasureStatementExpiry({ pool: deps.pool }, accountId, {
      expiresAt,
      dueAt: key.due_at,
      ownerRoute: key.owner_route,
      decisionId: key.owner_id,
    });
    await forget(deps.pool, accountId, key);
    return { pending: false, statementsKeptUntil: expiresAt };
  }
  await forget(deps.pool, accountId, key);
  return { pending: false, statementsKeptUntil: null };
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
  if (keys.length) await noteAccountErasureFound(deps, accountId, 'content');
  let pending = 0;
  let statementsKeptUntil: Date | null = null;
  for (const key of keys) {
    const disposition = await eraseAccountModerationItem(
      deps,
      accountId,
      { kind: key.kind, dueAt: key.due_at, ownerRoute: key.owner_route, ownerId: key.owner_id },
      input.erasedAt,
    );
    if (disposition.pending) pending++;
    if (
      disposition.statementsKeptUntil &&
      (!statementsKeptUntil || disposition.statementsKeptUntil > statementsKeptUntil)
    )
      statementsKeptUntil = disposition.statementsKeptUntil;
  }
  return { next: next(keys), found: keys.length, pending, statementsKeptUntil };
}

export async function purgeAccountStatementsPage(
  deps: { pool: Pool },
  accountId: string,
  input: { asOf: Date; after: string | null },
): Promise<{ next: string | null; found: number; nextDueAt: Date | null }> {
  validTime(input.asOf);
  const accountRoute = partyRoute(accountId);
  const cursor =
    input.after === null
      ? null
      : (JSON.parse(Buffer.from(input.after, 'base64url').toString()) as { due_at: string; decision_id: string });
  if (cursor) {
    if (!Number.isFinite(Date.parse(cursor.due_at))) throw new TypeError('Invalid retained statement cursor');
    partyRoute(cursor.decision_id);
  }
  const keys = await partyPartition(deps.pool, accountRoute, async (client) => {
    const { rows: obligation } = await client.query('SELECT 1 FROM access.erasure WHERE route=$1 AND account_id=$2', [
      accountRoute,
      accountId,
    ]);
    if (!obligation.length) throw new Error('Committed account erasure obligation is required');
    const query = cursor ? statementAfterPage : statementPage;
    const result = await client.query<{
      due_at: string;
      owner_route: number;
      decision_id: string;
    }>(
      query.sql,
      query.params.map((name) => {
        const values = {
          route: accountRoute,
          account_id: accountId,
          as_of: validTime(input.asOf),
          after_due_at: cursor?.due_at ?? null,
          after_decision_id: cursor?.decision_id ?? null,
        };
        return values[name as keyof typeof values];
      }),
    );
    return result.rows;
  });
  for (const key of keys) {
    await partyPartition(deps.pool, key.owner_route, async (client) => {
      await client.query(
        `UPDATE content.moderation_decision SET statement='',decider_account_id=NULL
        WHERE route=$1 AND decision_id=$2 AND decided_at+interval '183 days' <= $3
        AND decider_account_id IS NULL`,
        [key.owner_route, key.decision_id, validTime(input.asOf)],
      );
    });
    await partyPartition(deps.pool, accountRoute, async (client) => {
      await deleteStatement.run(client, {
        route: accountRoute,
        account_id: accountId,
        due_at: key.due_at,
        decision_id: key.decision_id,
      });
    });
  }
  const nextDueAt = await partyPartition(deps.pool, accountRoute, async (client) => {
    const {
      rows: [row],
    } = await client.query<{ due_at: Date }>(
      `SELECT due_at FROM content.account_erasure_statement
      WHERE route=$1 AND account_id=$2 ORDER BY due_at,decision_id LIMIT 1`,
      [accountRoute, accountId],
    );
    return row?.due_at ?? null;
  });
  const next =
    keys.length < 50
      ? null
      : Buffer.from(JSON.stringify({ due_at: keys.at(-1)!.due_at, decision_id: keys.at(-1)!.decision_id })).toString(
          'base64url',
        );
  return { next, found: keys.length, nextDueAt };
}
