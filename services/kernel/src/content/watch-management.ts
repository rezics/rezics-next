import { deadlineClient, within } from '../access/authenticate.ts';
import { noEffect, principalCommandIdentity, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { RequestContext } from './model.ts';
import { ContentNotFoundError, readBoard, readThread } from './reads.ts';
import type { WatchManagementItem, WatchManagementPage } from './schemas.ts';
import {
  declareWatchHistory,
  requireWatchOwner,
  watchAuthorization,
  watchOwner,
  watchReceipt,
  type WatchDependencies,
  type WatchKind,
} from './watch-authority.ts';

export const WATCH_MANAGEMENT_RAW_BUDGET = 100;
export const WATCH_MANAGEMENT_PRESENTATION_BUDGET = 20;
const LIST_ROUTE = 'GET /v1/accounts/{accountId}/watches';

type WatchRow = { watch_id: string; resource_id: string; created_at: string; revision: number };
export type ManagedWatch = WatchManagementItem;

type TargetObservation = Readonly<{
  presentation: Readonly<{ resourceId: string; title: string | null }> | null;
  witness: string | null;
}>;

function selection(kind: WatchKind) {
  if (kind === 'thread') return { table: 'content.thread_watch', resource: 'thread_id', active: '', revision: '1' };
  if (kind === 'board')
    return { table: 'content.board_watch', resource: 'board_id', active: ' AND watching', revision: 'revision' };
  throw new ProblemError('invalid_request');
}

/** A single mechanism over two explicit selections; never a manufactured mixed order. */
export async function listWatches(
  deps: WatchDependencies,
  actor: Actor,
  accountId: string,
  input: { kind: WatchKind; limit?: number; cursor?: string },
  deadline: number,
): Promise<WatchManagementPage> {
  const owner = await requireWatchOwner(deps, actor, deadline, accountId);
  const ownerObservation = {
    id: owner.id,
    route: owner.route,
    clientId: owner.actor.clientId,
    requestedBy: owner.actor.requestedBy,
    authnEpoch: owner.actor.authnEpoch,
  };
  const source = selection(input.kind);
  const limit = input.limit ?? WATCH_MANAGEMENT_PRESENTATION_BUDGET;
  if (!Number.isInteger(limit) || limit < 1 || limit > WATCH_MANAGEMENT_PRESENTATION_BUDGET)
    throw new ProblemError('invalid_request');
  const generation = await watchGeneration(deps, owner.route, deadline);
  const binding = {
    route: LIST_ROUTE,
    viewer: ownerObservation.id,
    query: {
      kind: input.kind,
      limit,
      clientId: ownerObservation.clientId,
      requestedBy: ownerObservation.requestedBy,
      authnEpoch: ownerObservation.authnEpoch,
    },
  };
  const now = deps.clock?.() ?? new Date();
  let after: [string, string] | null = null;
  if (input.cursor !== undefined) {
    const cursor = await decodeListCursor(deps.tokens, binding, input.cursor, now);
    if (
      !cursor.ok ||
      cursor.epoch !== generation ||
      cursor.after.length !== 2 ||
      typeof cursor.after[0] !== 'string' ||
      !Number.isFinite(Date.parse(cursor.after[0])) ||
      typeof cursor.after[1] !== 'string' ||
      routeOf(cursor.after[1]) !== owner.route
    )
      throw new ProblemError('invalid_cursor');
    after = [cursor.after[0], cursor.after[1]];
  }
  // Only the actor-home indexed range is selected. Its checkout ends before disclosure.
  const rows = await within(deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const statement =
        after === null
          ? `SELECT watch_id::text,${source.resource}::text AS resource_id,created_at::text,${source.revision} AS revision
             FROM ${source.table}
             WHERE route=$1 AND watcher_account_id=$2${source.active}
             ORDER BY created_at,watch_id LIMIT $3`
          : `SELECT watch_id::text,${source.resource}::text AS resource_id,created_at::text,${source.revision} AS revision
             FROM ${source.table}
             WHERE route=$1 AND watcher_account_id=$2${source.active}
               AND (created_at,watch_id)>($3::timestamptz,$4::uuid)
             ORDER BY created_at,watch_id LIMIT $5`;
      const values =
        after === null
          ? [owner.route, owner.id, WATCH_MANAGEMENT_RAW_BUDGET]
          : [owner.route, owner.id, after[0], after[1], WATCH_MANAGEMENT_RAW_BUDGET];
      const result = await deadlineClient(connection, deadline).query<WatchRow>(statement, values);
      return result.rows;
    }),
  );
  const retained: { row: WatchRow; initial: TargetObservation }[] = [];
  let scanned = 0;
  let last: WatchRow | undefined;
  for (const row of rows) {
    scanned++;
    last = row;
    const initial = await observeTarget(deps, input.kind, row.resource_id, actor, deadline);
    const current = await readActiveWatch(deps, source, owner.route, owner.id, row.watch_id, deadline);
    if (!current) continue;
    if (!sameWatchEpisode(row, current)) throw new ProblemError('dependency_unavailable');
    retained.push({ row, initial });
    if (retained.length === limit) break;
  }
  // Finish every retained key's ordinary native disclosure after all first-pass hydrations.
  const finalTargets: TargetObservation[] = [];
  for (const { row } of retained)
    finalTargets.push(await observeTarget(deps, input.kind, row.resource_id, actor, deadline));
  const finalItems: ManagedWatch[] = [];
  for (let index = 0; index < retained.length; index++) {
    const { row, initial } = retained[index]!;
    const final = finalTargets[index]!;
    if (initial.witness === null && final.witness !== null) throw new ProblemError('dependency_unavailable');
    if (initial.witness !== null && final.witness !== null && initial.witness !== final.witness)
      throw new ProblemError('dependency_unavailable');
    const current = await readActiveWatch(deps, source, owner.route, owner.id, row.watch_id, deadline);
    if (!current) continue;
    if (!sameWatchEpisode(row, current)) throw new ProblemError('dependency_unavailable');
    const identity = {
      id: row.watch_id,
      kind: input.kind,
      revision: row.revision,
      createdAt: new Date(row.created_at).toISOString(),
    };
    finalItems.push(
      final.presentation
        ? { ...identity, state: 'available', ...final.presentation }
        : { ...identity, state: 'unavailable' },
    );
  }
  const finalOwner = await requireWatchOwner(deps, actor, deadline, accountId);
  if (
    finalOwner.id !== ownerObservation.id ||
    finalOwner.route !== ownerObservation.route ||
    finalOwner.actor.clientId !== ownerObservation.clientId ||
    finalOwner.actor.requestedBy !== ownerObservation.requestedBy ||
    finalOwner.actor.authnEpoch !== ownerObservation.authnEpoch
  )
    throw new ProblemError('not_found');
  if ((await watchGeneration(deps, owner.route, deadline)) !== generation)
    throw new ProblemError('partition_unavailable');
  const next =
    last && (scanned < rows.length || rows.length === WATCH_MANAGEMENT_RAW_BUDGET)
      ? await encodeListCursor(
          deps.tokens,
          binding,
          { epoch: generation, after: [last.created_at, last.watch_id] },
          now,
        )
      : null;
  return { items: finalItems, next };
}

async function watchGeneration(deps: WatchDependencies, route: number, deadline: number): Promise<number> {
  return within(deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const state = await readPartition(deadlineClient(connection, deadline), partitionOf(route));
      if (!state || state.writeState === 'moved') throw new ProblemError('partition_unavailable');
      return state.epoch;
    }),
  );
}

async function observeTarget(
  deps: WatchDependencies,
  kind: WatchKind,
  resourceId: string,
  actor: Actor,
  deadline: number,
): Promise<TargetObservation> {
  try {
    const result =
      kind === 'thread'
        ? await readThread(deps, resourceId, { actor, deadline })
        : await readBoard(deps, resourceId, { actor, deadline });
    if (!result.value) return { presentation: null, witness: null };
    return {
      presentation: { resourceId: result.value.id, title: result.value.title },
      // The native view and its partition epoch are the observation. A refreshed boolean cannot replace it.
      witness: nativeTargetWitness(kind, result),
    };
  } catch (error) {
    if (!(error instanceof ContentNotFoundError)) throw error;
    return { presentation: null, witness: null };
  }
}

function nativeTargetWitness(
  kind: WatchKind,
  result: Awaited<ReturnType<typeof readThread>> | Awaited<ReturnType<typeof readBoard>>,
): string {
  const value = result.value!;
  return JSON.stringify([
    result.anchor.partition.partitionNo,
    result.anchor.epoch,
    value.id,
    value.route,
    value.title,
    value.visibility,
    value.securityRevision,
    value.availability,
    value.createdAt,
    kind === 'thread' && 'boardId' in value ? value.boardId : null,
    kind === 'board' && 'realmId' in value ? value.realmId : null,
    'firstPost' in value && 'revisionId' in value.firstPost ? value.firstPost.revisionId : null,
  ]);
}

async function readActiveWatch(
  deps: WatchDependencies,
  source: ReturnType<typeof selection>,
  route: number,
  accountId: string,
  watchId: string,
  deadline: number,
): Promise<WatchRow | null> {
  return within(deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const result = await deadlineClient(connection, deadline).query<WatchRow>(
        `SELECT watch_id::text,${source.resource}::text AS resource_id,created_at::text,${source.revision} AS revision
         FROM ${source.table}
         WHERE route=$1 AND watcher_account_id=$2 AND watch_id=$3${source.active}`,
        [route, accountId, watchId],
      );
      return result.rows[0] ?? null;
    }),
  );
}

function sameWatchEpisode(original: WatchRow, current: WatchRow): boolean {
  return (
    original.watch_id === current.watch_id &&
    original.resource_id === current.resource_id &&
    original.created_at === current.created_at &&
    original.revision === current.revision
  );
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
  if (
    routeOf(input.watchId) !== owner.route ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  )
    throw new ProblemError('invalid_request');
  return runCommand(
    deps.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(owner.route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization: watchAuthorization(deps, actor, context.deadline),
      receipt: watchReceipt(actor, 'content.watch.remove', context.idempotencyKey, [
        input.kind,
        input.watchId,
        input.expectedRevision,
      ]),
    },
    async (tx) => {
      const result = await tx.query<{ revision: number }>(
        `SELECT ${source.revision} AS revision FROM ${source.table}
       WHERE route=$1 AND watcher_account_id=$2 AND watch_id=$3${source.active} FOR UPDATE`,
        [owner.route, owner.id, input.watchId],
      );
      const current = result.rows[0];
      if (current && current.revision !== input.expectedRevision) throw new ProblemError('conflict');
      await declareWatchHistory(tx, 'content.watch.remove', owner, !!current);
      if (!current) return noEffect({ removed: true });
      if (current) {
        await tx.query(
          input.kind === 'thread'
            ? 'DELETE FROM content.thread_watch WHERE route=$1 AND watcher_account_id=$2 AND watch_id=$3'
            : 'UPDATE content.board_watch SET watching=false,revision=revision+1 WHERE route=$1 AND watcher_account_id=$2 AND watch_id=$3',
          [owner.route, owner.id, input.watchId],
        );
      }
      return {
        value: { removed: true },
        events: current
          ? [
              {
                type: 'com.rezics.content.watch.removed.v1',
                subject: owner.id,
                data: { accountId: owner.id, kind: input.kind, watchId: input.watchId },
              },
            ]
          : [],
      };
    },
  );
}
