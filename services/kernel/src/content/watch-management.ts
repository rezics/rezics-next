import { deadlineClient, within } from '../access/authenticate.ts';
import { principalCommandIdentity, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { RequestContext } from './model.ts';
import { ContentNotFoundError, readBoard, readThread } from './reads.ts';
import { requireWatchOwner, watchAuthorization, watchOwner, watchReceipt, type WatchDependencies, type WatchKind } from './watch-authority.ts';

export const WATCH_MANAGEMENT_RAW_BUDGET = 100;
export const WATCH_MANAGEMENT_PRESENTATION_BUDGET = 20;
const LIST_ROUTE = 'GET /v1/accounts/{accountId}/watches';

type WatchRow = { watch_id: string; resource_id: string; created_at: string; revision: number };
type Identity = Readonly<{ id: string; kind: WatchKind; createdAt: string; revision: number }>;
export type ManagedWatch = Identity & (
  | Readonly<{ state: 'available'; resourceId: string; title: string }>
  | Readonly<{ state: 'unavailable' }>
);

function selection(kind: WatchKind) {
  if (kind === 'thread') return { table: 'content.thread_watch', resource: 'thread_id', active: '', revision: '1' };
  if (kind === 'board') return { table: 'content.board_watch', resource: 'board_id', active: ' AND watching', revision: 'revision' };
  throw new ProblemError('invalid_request');
}

/** A single mechanism over two explicit selections; never a manufactured mixed order. */
export async function listWatches(
  deps: WatchDependencies,
  actor: Actor,
  accountId: string,
  input: { kind: WatchKind; limit?: number; cursor?: string },
  deadline: number,
): Promise<{ items: ManagedWatch[]; next: string | null }> {
  const owner = await requireWatchOwner(deps, actor, deadline, accountId);
  const source = selection(input.kind);
  const limit = input.limit ?? WATCH_MANAGEMENT_PRESENTATION_BUDGET;
  if (!Number.isInteger(limit) || limit < 1 || limit > WATCH_MANAGEMENT_PRESENTATION_BUDGET)
    throw new ProblemError('invalid_request');
  const generation = await within(deadline, () => withConnection(deps.pool, async (connection) => {
    const state = await readPartition(deadlineClient(connection, deadline), partitionOf(owner.route));
    if (!state || state.writeState === 'moved') throw new ProblemError('partition_unavailable');
    return state.epoch;
  }));
  const binding = { route: LIST_ROUTE, viewer: owner.id, query: {
    kind: input.kind, limit, clientId: owner.actor.clientId, requestedBy: owner.actor.requestedBy,
    authnEpoch: owner.actor.authnEpoch,
  } };
  const now = deps.clock?.() ?? new Date();
  let after: [string, string] | null = null;
  if (input.cursor !== undefined) {
    const cursor = await decodeListCursor(deps.tokens, binding, input.cursor, now);
    if (!cursor.ok || cursor.epoch !== generation || cursor.after.length !== 2 ||
        typeof cursor.after[0] !== 'string' || !Number.isFinite(Date.parse(cursor.after[0])) ||
        typeof cursor.after[1] !== 'string' || routeOf(cursor.after[1]) !== owner.route)
      throw new ProblemError('invalid_cursor');
    after = [cursor.after[0], cursor.after[1]];
  }
  // Only the actor-home indexed range is selected. Its checkout ends before disclosure.
  const rows = await within(deadline, () => withConnection(deps.pool, async (connection) => {
    const result = await deadlineClient(connection, deadline).query<WatchRow>(
      `SELECT watch_id::text,${source.resource}::text AS resource_id,created_at::text,${source.revision} AS revision
       FROM ${source.table}
       WHERE route=$1 AND watcher_account_id=$2${source.active}
         AND ($3::timestamptz IS NULL OR (created_at,watch_id)>($3::timestamptz,$4::uuid))
       ORDER BY created_at,watch_id LIMIT $5`,
      [owner.route, owner.id, after?.[0] ?? null, after?.[1] ?? null, WATCH_MANAGEMENT_RAW_BUDGET],
    );
    return result.rows;
  }));
  const items: ManagedWatch[] = [];
  let scanned = 0;
  let last: WatchRow | undefined;
  for (const row of rows) {
    scanned++;
    last = row;
    let presentation: { resourceId: string; title: string } | undefined;
    try {
      const result = input.kind === 'thread'
        ? await readThread(deps, row.resource_id, { actor, deadline })
        : await readBoard(deps, row.resource_id, { actor, deadline });
      if (result.value) presentation = { resourceId: result.value.id, title: result.value.title };
    } catch (error) {
      if (!(error instanceof ContentNotFoundError)) throw error;
    }
    // Removal between range selection and disclosure must not return stale presentation.
    const stillOwned = await within(deadline, () => withConnection(deps.pool, async (connection) =>
      (await deadlineClient(connection, deadline).query(
        `SELECT 1 FROM ${source.table} WHERE route=$1 AND watcher_account_id=$2 AND watch_id=$3${source.active}`,
        [owner.route, owner.id, row.watch_id],
      )).rowCount === 1,
    ));
    if (!stillOwned) continue;
    const identity = { id: row.watch_id, kind: input.kind, revision: row.revision, createdAt: new Date(row.created_at).toISOString() };
    items.push(presentation ? { ...identity, state: 'available', ...presentation } : { ...identity, state: 'unavailable' });
    if (items.length === limit) break;
  }
  const next = last && (scanned < rows.length || rows.length === WATCH_MANAGEMENT_RAW_BUDGET)
    ? await encodeListCursor(deps.tokens, binding, { epoch: generation, after: [last.created_at, last.watch_id] }, now)
    : null;
  return { items, next };
}

/** The opaque personal identity remains sufficient for removal after a ban or deletion. */
export async function removeWatch(
  deps: WatchDependencies,
  actor: Actor,
  accountId: string,
  input: { kind: WatchKind; watchId: string; expectedRevision: number },
  context: RequestContext,
) {
  const owner = watchOwner(actor, accountId);
  const source = selection(input.kind);
  if (routeOf(input.watchId) !== owner.route || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
    throw new ProblemError('invalid_request');
  return runCommand(deps.pool, {
    ...principalCommandIdentity(actor),
    partition: partitionOf(owner.route), deadline: context.deadline, clock: deps.clock,
    authorization: watchAuthorization(deps, actor, context.deadline),
    receipt: watchReceipt(actor, 'content.watch.remove', context.idempotencyKey,
      [input.kind, input.watchId, input.expectedRevision]),
  }, async (tx) => {
    const result = await tx.query<{ revision: number }>(
      `SELECT ${source.revision} AS revision FROM ${source.table}
       WHERE route=$1 AND watcher_account_id=$2 AND watch_id=$3${source.active} FOR UPDATE`,
      [owner.route, owner.id, input.watchId],
    );
    const current = result.rows[0];
    if (current && current.revision !== input.expectedRevision) throw new ProblemError('conflict');
    if (current) {
      await tx.query(input.kind === 'thread'
        ? 'DELETE FROM content.thread_watch WHERE route=$1 AND watcher_account_id=$2 AND watch_id=$3'
        : 'UPDATE content.board_watch SET watching=false,revision=revision+1 WHERE route=$1 AND watcher_account_id=$2 AND watch_id=$3',
      [owner.route, owner.id, input.watchId]);
    }
    return { value: { removed: true }, events: current ? [{ type: 'com.rezics.content.watch.removed.v1',
      subject: owner.id, data: { accountId: owner.id, kind: input.kind, watchId: input.watchId } }] : [] };
  });
}
