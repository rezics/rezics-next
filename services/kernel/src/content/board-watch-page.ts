import { isDeepStrictEqual } from 'node:util';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { BoardWatchState } from './board-watch.ts';
import { ContentNotFoundError, readBoard } from './reads.ts';
import { requireWatchOwner, type WatchDependencies } from './watch-authority.ts';

type WatchAdvice = 'available' | 'denied' | 'not-applicable';
export type BoardWatchPage = Readonly<{
  boardId: string;
  accountId: string;
  viewer: Readonly<{ state: 'current'; watching: boolean; revision: number }>;
  actions: Readonly<{ watch: WatchAdvice; unwatch: WatchAdvice }>;
  source: Readonly<{ epoch: number; position: string }>;
}>;

/** Private companion only: no personal fields are added to the public Board transfer. */
export async function readBoardWatchPage(deps: WatchDependencies, actor: Actor, boardId: string, deadline: number) {
  if (routeOf(boardId) === null) throw new ContentNotFoundError();
  // Owner admission precedes disclosure and never turns failed authentication into revision zero.
  const owner = await requireWatchOwner(deps, actor, deadline);
  const initialBoard = await readBoard(deps, boardId, { actor, deadline });
  if (!initialBoard.value) throw new ContentNotFoundError();

  async function observe() {
    await requireWatchOwner(deps, actor, deadline);
    const update = await accessCheck(deps.access, actor, 'account:update', owner, { pool: deps.pool, deadline });
    return within(deadline, () => withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const result = await client.query<BoardWatchState>(
        'SELECT watching, revision FROM content.board_watch WHERE route=$1 AND watcher_account_id=$2 AND board_id=$3',
        [owner.route, owner.id, boardId],
      );
      const allowed = await update(client);
      return { state: result.rows[0] ?? { watching: false, revision: 0 }, allowed };
    }));
  }

  const initial = await observe();
  const current = await observe();
  const finalBoard = await readBoard(deps, boardId, { actor, deadline });
  if (!finalBoard.value) throw new ContentNotFoundError();
  if (!isDeepStrictEqual(initialBoard.value, finalBoard.value) || !isDeepStrictEqual(initial, current))
    throw new ProblemError('conflict');
  const advice = current.allowed ? 'available' : 'denied';
  const value: BoardWatchPage = {
    boardId,
    accountId: owner.id,
    viewer: { state: 'current', ...current.state },
    actions: {
      watch: current.state.watching ? 'not-applicable' : advice,
      unwatch: current.state.watching ? advice : 'not-applicable',
    },
    source: { epoch: finalBoard.anchor.epoch, position: String(finalBoard.anchor.position) },
  };
  return { value, anchor: finalBoard.anchor };
}
