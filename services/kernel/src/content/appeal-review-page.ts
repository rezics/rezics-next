import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { readPublicIdentities, type PublicIdentity } from '../access/account-data.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, AccessClient, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { BoardId, ThreadId } from './model.ts';
import { readBoard, readThread } from './reads.ts';
import type { BoardView, ThreadView } from './model.ts';
import targets from './appeal-review-page-targets.sql';

export type AppealReviewAnchor = Readonly<{ partition: number; epoch: number; position: bigint }>;
export type AppealReviewDependencies = Readonly<{ pool: Pool; access: Access; tokens?: KeyRing }>;
export type AppealReviewIdentity = Readonly<
  | {
      state: 'available';
      kind: 'actor' | 'organization';
      handle: string | null;
      displayName: string | null;
      automated: boolean;
    }
  | { state: 'deleted' }
  | { state: 'concealed' }
  | { state: 'unavailable' }
>;
export type AppealReviewDestination =
  | Readonly<{ kind: 'board'; id: BoardId }>
  | Readonly<{ kind: 'thread'; id: ThreadId; boardId: BoardId }>;
export type AppealReviewTargetContext =
  | Readonly<{ state: 'available'; destination: AppealReviewDestination }>
  | Readonly<{ state: 'concealed' }>
  | Readonly<{ state: 'unavailable' }>;
export type AppealReviewTarget = Readonly<{ kind: 'board' | 'thread' | 'post'; id: string }>;
export type AppealReviewReadContext = Readonly<{ actor: Actor; deadline: number }>;

type TargetLocation = Readonly<{
  kind: string;
  target_id: string;
  board_id: string | null;
  thread_id: string | null;
  present: boolean;
}>;

/** One current, read-only source snapshot. It never promotes a context read to write authority. */
export async function appealReviewSnapshot<T>(
  pool: Pool,
  route: number,
  deadline: number,
  work: (client: AccessClient) => Promise<T>,
): Promise<{ value: T; anchor: AppealReviewAnchor }> {
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partitionNo = partitionOf(route);
        const partition = await readPartition(client, partitionNo);
        if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
        const value = await work(client);
        await client.query('COMMIT');
        return { value, anchor: { partition: partitionNo, epoch: partition.epoch, position: partition.position } };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollback) {
          discardConnection(connection, rollback as Error);
        }
        throw error;
      }
    }),
  );
}

/** Only public allowlisted identity fields are projected. Missing, erased and unavailable stay distinct. */
export async function readAppealReviewIdentities(
  deps: Pick<AppealReviewDependencies, 'pool'>,
  appellantIds: readonly string[],
  deadline: number,
): Promise<ReadonlyMap<string, AppealReviewIdentity>> {
  const unique = [...new Set(appellantIds)].filter((id) => routeOf(id) !== null);
  const groups = new Map<number, string[]>();
  for (const id of unique) {
    const home = partitionOf(routeOf(id)!);
    const values = groups.get(home) ?? [];
    values.push(id);
    groups.set(home, values);
  }
  const result = new Map<string, AppealReviewIdentity>(appellantIds.map((id) => [id, { state: 'concealed' }]));
  await Promise.all(
    [...groups.values()].map(async (ids) => {
      const routes = ids.map((id) => routeOf(id)!);
      try {
        const { value } = await appealReviewSnapshot(deps.pool, routes[0]!, deadline, (client) =>
          readPublicIdentities(client, routes, ids),
        );
        const found = new Map(value.map((identity) => [identity.id, identity]));
        for (const id of ids) {
          const identity = found.get(id);
          result.set(id, identity ? safeIdentity(identity) : { state: 'concealed' });
        }
      } catch {
        for (const id of ids) result.set(id, { state: 'unavailable' });
      }
    }),
  );
  return result;
}

function safeIdentity(identity: PublicIdentity): AppealReviewIdentity {
  if (identity.state === 'deleted') return { state: 'deleted' };
  return {
    state: 'available',
    kind: identity.kind,
    handle: identity.handle,
    displayName: identity.displayName,
    automated: identity.automated,
  };
}

/**
 * Read current destination metadata in one Content-owner query per routed home,
 * then use the ordinary exact board/thread readers for disclosure. No target body
 * or moderation-only target text is included in the returned context.
 */
export async function readAppealReviewTargetContexts(
  deps: AppealReviewDependencies,
  reviewTargets: readonly AppealReviewTarget[],
  context: AppealReviewReadContext,
): Promise<ReadonlyMap<string, AppealReviewTargetContext>> {
  const unique = new Map<string, AppealReviewTarget>();
  for (const target of reviewTargets) unique.set(targetKey(target), target);
  const groups = new Map<number, AppealReviewTarget[]>();
  for (const target of unique.values()) {
    const home = routeOf(target.id);
    if (home === null) continue;
    const group = groups.get(home) ?? [];
    group.push(target);
    groups.set(home, group);
  }
  const locations = new Map<string, TargetLocation>();
  const failedHomes = new Set<number>();
  await Promise.all(
    [...groups].map(async ([home, group]) => {
      try {
        const { value } = await appealReviewSnapshot(deps.pool, home, context.deadline, (client) =>
          targets.run(client, {
            route: home,
            target_kinds: group.map((target) => target.kind),
            target_ids: group.map((target) => target.id),
          }),
        );
        for (const row of value) locations.set(`${row.kind}:${row.target_id}`, row);
      } catch {
        failedHomes.add(home);
      }
    }),
  );
  const result = new Map<string, AppealReviewTargetContext>();
  const tokens = deps.tokens;
  if (!tokens) {
    for (const target of unique.values()) result.set(targetKey(target), { state: 'unavailable' });
    return result;
  }
  const readers = { pool: deps.pool, access: deps.access, tokens };
  const threads = new Map<string, Promise<ThreadView | null>>();
  const boards = new Map<string, Promise<BoardView | null>>();
  const readCurrentThread = (id: string) => {
    let pending = threads.get(id);
    if (!pending) {
      pending = readThread(readers, id as ThreadId, context).then((read) => read.value);
      threads.set(id, pending);
    }
    return pending;
  };
  const readCurrentBoard = (id: string) => {
    let pending = boards.get(id);
    if (!pending) {
      pending = readBoard(readers, id as BoardId, context).then((read) => read.value);
      boards.set(id, pending);
    }
    return pending;
  };
  await Promise.all(
    [...unique.values()].map(async (target) => {
      const key = targetKey(target);
      const home = routeOf(target.id);
      if (home === null || failedHomes.has(home)) {
        result.set(key, { state: 'unavailable' });
        return;
      }
      const location = locations.get(key);
      if (!location?.present) {
        result.set(key, { state: 'unavailable' });
        return;
      }
      try {
        if (target.kind === 'board') {
          const board = await readCurrentBoard(target.id);
          result.set(
            key,
            board && board.availability === 'available' && board.visibility !== 'taken_down'
              ? { state: 'available', destination: { kind: 'board', id: board.id } }
              : { state: 'concealed' },
          );
          return;
        }
        const threadId = target.kind === 'thread' ? target.id : location.thread_id;
        if (!threadId || routeOf(threadId) !== home) {
          result.set(key, { state: 'unavailable' });
          return;
        }
        const thread = await readCurrentThread(threadId);
        result.set(
          key,
          thread &&
            thread.availability === 'available' &&
            thread.visibility !== 'taken_down' &&
            thread.firstPost.availability === 'available'
            ? { state: 'available', destination: { kind: 'thread', id: thread.id, boardId: thread.boardId } }
            : { state: 'concealed' },
        );
      } catch {
        result.set(key, { state: 'unavailable' });
      }
    }),
  );
  return result;
}

export function targetKey(target: AppealReviewTarget): string {
  return `${target.kind}:${target.id}`;
}
