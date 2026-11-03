import { authoritativeTimeValue, principalCommandIdentity, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type { RequestContext } from './model.ts';
import { ContentNotFoundError, readBoard } from './reads.ts';
import {
  declareWatchHistory,
  requireWatchOwner,
  watchAuthorization,
  watchOwner,
  watchReceipt,
  type WatchDependencies,
} from './watch-authority.ts';

export type BoardWatchState = Readonly<{ watching: boolean; revision: number }>;

async function readableBoard(deps: WatchDependencies, actor: Actor, boardId: string, deadline: number) {
  if (routeOf(boardId) === null) throw new ContentNotFoundError();
  const result = await readBoard(deps, boardId, { actor, deadline });
  if (!result.value) throw new ContentNotFoundError();
  return result;
}

export async function readBoardWatchState(deps: WatchDependencies, actor: Actor, boardId: string, deadline: number) {
  const owner = await requireWatchOwner(deps, actor, deadline);
  const board = await readableBoard(deps, actor, boardId, deadline);
  const state = await within(deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const result = await deadlineClient(connection, deadline).query<BoardWatchState>(
        'SELECT watching, revision FROM content.board_watch WHERE route=$1 AND watcher_account_id=$2 AND board_id=$3',
        [owner.route, owner.id, boardId],
      );
      return result.rows[0] ?? { watching: false, revision: 0 };
    }),
  );
  return { ...state, anchor: board.anchor };
}

/** Retain a revision tombstone. Rewatch rotates the send identity and publication cutoff. */
export async function setBoardWatch(
  deps: WatchDependencies,
  actor: Actor,
  input: { boardId: string; watching: boolean; expectedRevision: number },
  context: RequestContext,
) {
  const owner = watchOwner(actor);
  if (routeOf(input.boardId) === null) throw new ContentNotFoundError();
  if (
    typeof input.watching !== 'boolean' ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision > 2147483646
  )
    throw new ProblemError('invalid_request');
  const base = watchAuthorization(deps, actor, context.deadline);
  const authorization = {
    ...base,
    async prepare(attempt: Parameters<NonNullable<typeof base.prepare>>[0]) {
      // Even an exact retry must prove current authority before its receipt lookup.
      if (input.watching) await readableBoard(deps, actor, input.boardId, context.deadline);
      return base.prepare!(attempt);
    },
  };
  return runCommand(
    deps.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(owner.route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization,
      receipt: watchReceipt(actor, 'content.board.watch', context.idempotencyKey, [
        input.boardId,
        input.watching,
        input.expectedRevision,
      ]),
    },
    async (tx, command) => {
      const result = await tx.query<BoardWatchState>(
        'SELECT watching,revision FROM content.board_watch WHERE route=$1 AND watcher_account_id=$2 AND board_id=$3 FOR UPDATE',
        [owner.route, owner.id, input.boardId],
      );
      const current = result.rows[0] ?? { watching: false, revision: 0 };
      if (current.revision !== input.expectedRevision) throw new ProblemError('conflict');
      await declareWatchHistory(tx, 'content.board.watch', owner, current.watching !== input.watching);
      if (current.watching === input.watching) return { value: current, events: [] };
      const revision = current.revision + 1;
      await tx.query(
        `INSERT INTO content.board_watch(route,watcher_account_id,board_id,watch_id,watching,revision,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz)
       ON CONFLICT(route,watcher_account_id,board_id) DO UPDATE
       SET watching=EXCLUDED.watching,revision=EXCLUDED.revision,
           watch_id=CASE WHEN EXCLUDED.watching THEN EXCLUDED.watch_id ELSE board_watch.watch_id END,
           created_at=CASE WHEN EXCLUDED.watching THEN EXCLUDED.created_at ELSE board_watch.created_at END`,
        [
          owner.route,
          owner.id,
          input.boardId,
          newId(owner.route),
          input.watching,
          revision,
          authoritativeTimeValue(command.time),
        ],
      );
      return {
        value: { watching: input.watching, revision },
        events: [
          {
            type: 'com.rezics.content.board.watch.changed.v1',
            subject: owner.id,
            data: { accountId: owner.id, boardId: input.boardId, watching: input.watching, revision },
          },
        ],
      };
    },
  );
}
