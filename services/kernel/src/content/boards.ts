import { deadlineClient, within } from '../access/authenticate.ts';
import { accessCheck, type AccessCheck, type Actor } from '../request/access.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import { realmReadEligibility } from '../community/realm.ts';
import {
  decodeBoardCursor,
  decodeBoardRankCursor,
  encodeBoardCursor,
  encodeBoardRankCursor,
  normalizeBoardQuery,
  type BoardCursorBinding,
  type BoardCursorSort,
} from './board-cursor.ts';
import { pageActiveBoardCandidates, pageBoardCandidates } from './board-projection.ts';
import boardRankPage from './board-rank-page.sql';
import match from './match-thread-text.sql';
import { isErasedPlaceholder } from './model.ts';
import type { Anchored, AnchoredPosition, BoardView, Page, ReadContext } from './model.ts';
import {
  ContentNotFoundError,
  discloseThreads,
  readBoard,
  type ContentReadDependencies,
  type ThreadView,
} from './reads.ts';
import pageRealmBoardIds from './board-realm-page.sql';

export type ContentBoardDependencies = ContentReadDependencies & {
  /** Trusted service configuration, independent of authentication's wall clock. */
  cursorNow?: () => number;
};
export type BoardPageInput = { cursor?: string; limit?: number; sort?: BoardCursorSort; query?: string };
export type BoardThreadPage = Page<ThreadView> & {
  anchors: readonly AnchoredPosition[];
  /** The oldest returned active-rank row's materialization time, or null when no active row was returned. */
  rankRefreshedAt: string | null;
};
export type RealmBoardPageInput = { cursor?: string; limit?: number };
export type RealmBoardPage = { items: readonly BoardView[]; next: string | null; anchors: readonly AnchoredPosition[] };

function realmBinding(realmId: string, actor: Actor): CursorBinding {
  return {
    operation: 'realm.boards.list',
    parameters: { realmId, viewer: actor.kind === 'account' ? actor.accountId : null },
  };
}

type BoardPageAfter =
  | { kind: 'created'; createdAt: string; threadId: string }
  | { kind: 'rank'; rank: number; threadId: string };
type ListedBoardCandidate = {
  id: string;
  createdAt?: string;
  rank?: number;
  rankRefreshedAt?: string;
};
type BoardCandidateSelection = {
  candidates: readonly ListedBoardCandidate[];
  hasMore: boolean;
  epoch: number;
  position: bigint;
};

type HotRankCandidate = { id: string; rank: number; rankRefreshedAt: string };
type HotRankCandidatePage = {
  candidates: readonly HotRankCandidate[];
  next: { rank: number; threadId: string } | null;
  epoch: number;
  position: bigint;
};

async function pageHotBoardCandidates(
  pool: ContentBoardDependencies['pool'],
  boardId: string,
  after: { rank: number; threadId: string } | null,
  limit: number,
): Promise<HotRankCandidatePage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Candidate limit must be 1 to 200');
  const boardRoute = routeOf(boardId);
  if (boardRoute === null) throw new ContentNotFoundError();
  if (after && (routeOf(after.threadId) === null || !Number.isFinite(after.rank) || after.rank < 0))
    throw new RangeError('Invalid hot rank cursor');

  return withConnection(pool, async (connection) => {
    try {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const partitionNo = partitionOf(boardRoute);
      const anchor = await readPartition(connection, partitionNo);
      if (!anchor) throw new CommandUnavailableError('deadline', partitionNo);
      if (anchor.writeState === 'moved') throw new CommandUnavailableError('moved', partitionNo, anchor.movedTo);
      const parameters = {
        route: boardRoute,
        board_id: boardId,
        active_rank: after?.rank ?? 0,
        thread_id: after?.threadId ?? '00000000-0000-0000-0000-000000000000',
        has_after: after !== null,
        limit,
      };
      const hotPageSql = boardRankPage.sql.replaceAll('candidate.active_rank', 'candidate.hot_rank');
      const { rows } = await connection.query<{
        thread_id: string;
        hot_rank: number;
        rank_refreshed_at: string | null;
      }>(
        hotPageSql,
        boardRankPage.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      const candidates = rows.map((row) => {
        if (row.rank_refreshed_at === null) throw new Error('Board rank freshness is missing');
        return { id: row.thread_id, rank: row.hot_rank, rankRefreshedAt: row.rank_refreshed_at };
      });
      await connection.query('COMMIT');
      const last = candidates.at(-1);
      return {
        candidates,
        next: candidates.length === limit && last ? { rank: last.rank, threadId: last.id } : null,
        epoch: anchor.epoch,
        position: anchor.position,
      };
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(connection, rollbackError as Error);
      }
      throw error;
    }
  });
}

async function prepareRealmRead(
  dependencies: ContentBoardDependencies,
  actor: Actor,
  realmId: string,
  deadline: number,
): Promise<AccessCheck | null> {
  const route = routeOf(realmId);
  if (route === null) return null;
  const identity = { route, id: realmId };
  return accessCheck(
    dependencies.access,
    actor,
    'realm:read',
    { ...identity, eligibility: realmReadEligibility(identity) },
    { pool: dependencies.pool, deadline },
  );
}

/** A Realm is the read container for every Realm-owned board. Legacy boards
 * have no Realm and retain their existing board-only disclosure behavior. */
export async function readRealmBoard(
  dependencies: ContentBoardDependencies,
  boardId: string,
  context: ReadContext,
): Promise<Anchored<BoardView | null>> {
  const board = await readBoard(dependencies, boardId, context);
  if (!board.value) return board;
  const realmId = board.value.realmId;
  if (realmId === null) return board;

  const check = await prepareRealmRead(dependencies, context.actor, realmId, context.deadline);
  if (!check) return { ...board, value: null };
  const visible = await withConnection(dependencies.pool, async (connection) => {
    const client = deadlineClient(connection, context.deadline);
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const allowed = await check(client);
      await client.query('COMMIT');
      return allowed;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(connection, rollbackError as Error);
      }
      throw error;
    }
  });
  return visible ? board : { ...board, value: null };
}

/** Keyset page of one Realm's boards. Candidate ids carry no authority; each
 * returned item goes through the current board and Realm disclosure checks. */
export async function listRealmBoards(
  dependencies: ContentBoardDependencies,
  realmId: string,
  context: ReadContext,
  input: RealmBoardPageInput = {},
): Promise<RealmBoardPage> {
  const realmRoute = routeOf(realmId);
  const limit = input.limit ?? 20;
  if (realmRoute === null) throw new ContentNotFoundError();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Page limit must be 1 to 100');
  const check = await prepareRealmRead(dependencies, context.actor, realmId, context.deadline);
  if (!check) throw new ContentNotFoundError();

  const now = (dependencies.cursorNow ?? Date.now)();
  if (!Number.isSafeInteger(now)) throw new TypeError('Invalid content cursor');
  const binding = realmBinding(realmId, context.actor);
  const result = await within(context.deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout = '3000ms'");
        const partition = await readPartition(client, partitionOf(realmRoute));
        if (!partition || partition.writeState === 'moved') throw new Error('Content partition unavailable');
        if (!(await check(client))) throw new ContentNotFoundError();

        let after: string | null = null;
        if (input.cursor !== undefined) {
          const decoded = decodeCursor(dependencies.tokens, binding, input.cursor, now);
          if (
            !decoded.ok ||
            decoded.epoch !== partition.epoch ||
            decoded.after.length !== 1 ||
            typeof decoded.after[0] !== 'string' ||
            routeOf(decoded.after[0]) !== realmRoute
          )
            throw new TypeError('Invalid content cursor');
          after = decoded.after[0];
        }

        const rows = await pageRealmBoardIds.run(client, {
          route: realmRoute,
          realm_id: realmId,
          after_board: after,
          limit: limit + 1,
        });
        await client.query('COMMIT');
        return {
          partition,
          candidates: rows.map((row) => row.board_id),
        };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );

  const anchors: AnchoredPosition[] = [
    { partition: result.partition, epoch: result.partition.epoch, position: result.partition.position },
  ];
  const items: BoardView[] = [];
  let after: string | null = null;
  let scanned = 0;
  for (const candidate of result.candidates) {
    if (items.length >= limit) break;
    after = candidate;
    scanned++;
    const visible = await readRealmBoard(dependencies, candidate, context);
    anchors.push(visible.anchor);
    if (visible.value) items.push(visible.value);
  }
  const more = scanned < result.candidates.length || result.candidates.length > limit;
  return {
    items,
    next:
      more && after
        ? encodeCursor(dependencies.tokens, binding, { epoch: result.partition.epoch, after: [after] }, now)
        : null,
    anchors,
  };
}

/** Exact current head only; this separately anchored snapshot never holds a
 * board checkout or searches a board/history relation before its candidate bound. */
async function matchesCurrentText(
  dependencies: ContentBoardDependencies,
  thread: ThreadView,
  query: string,
  context: ReadContext,
): Promise<Anchored<boolean>> {
  return within(context.deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partitionNo = partitionOf(thread.route);
        const partition = await readPartition(client, partitionNo);
        if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
        const parameters = {
          route: thread.route,
          thread_id: thread.id,
          post_id: thread.firstPost.id,
          revision_id: isErasedPlaceholder(thread.firstPost) ? null : thread.firstPost.revisionId,
          query,
        };
        const result = await client.query<(typeof match)['~reylo']['element']>(
          match.sql,
          match.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        await client.query('COMMIT');
        return {
          value: result.rows[0]?.matches === true,
          anchor: { partition, epoch: partition.epoch, position: partition.position },
        };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

/** Candidate references carry no authority. Only the shared final reader can
 * supply view fields, the public floor, or the grant/scope/denial decision. */
export async function listBoardThreads(
  dependencies: ContentBoardDependencies,
  boardId: string,
  context: ReadContext,
  input: BoardPageInput = {},
): Promise<BoardThreadPage> {
  const limit = input.limit ?? 20;
  const sort = input.sort ?? 'newest';
  const query = normalizeBoardQuery(input.query ?? '');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Page limit must be 1 to 100');
  if (sort !== 'newest' && sort !== 'oldest' && sort !== 'active' && sort !== 'hot')
    throw new TypeError('Invalid content cursor');
  const board = await readBoard(dependencies, boardId, context);
  if (!board.value) throw new ContentNotFoundError();
  const binding: BoardCursorBinding = {
    boardId,
    query,
    sort,
    viewer: context.actor,
  };
  const now = (dependencies.cursorNow ?? Date.now)();
  let after: BoardPageAfter | null = null;
  if (input.cursor !== undefined) {
    if (sort === 'active' || sort === 'hot') {
      const decoded = decodeBoardRankCursor(dependencies.tokens, binding, input.cursor, board.anchor.epoch, now);
      if (!decoded.ok || routeOf(decoded.after.threadId) === null) throw new TypeError('Invalid content cursor');
      after = { kind: 'rank', rank: decoded.after.rank, threadId: decoded.after.threadId };
    } else {
      const decoded = decodeBoardCursor(dependencies.tokens, binding, input.cursor, board.anchor.epoch, now);
      if (!decoded.ok) throw new TypeError('Invalid content cursor');
      after = { kind: 'created', createdAt: decoded.after.createdAt, threadId: decoded.after.threadId };
    }
  }
  // One indexed range, Q <= 200, independent of how many candidates are hidden.
  let selected: BoardCandidateSelection;
  if (sort === 'active') {
    const page = await pageActiveBoardCandidates(
      dependencies.pool,
      boardId,
      after?.kind === 'rank' ? { activeRank: after.rank, threadId: after.threadId } : null,
      200,
    );
    selected = {
      candidates: page.candidates.map(({ id, activeRank, rankRefreshedAt }) => ({
        id,
        rank: activeRank,
        rankRefreshedAt,
      })),
      hasMore: page.next !== null,
      epoch: page.epoch,
      position: page.position,
    };
  } else if (sort === 'hot') {
    const page = await pageHotBoardCandidates(
      dependencies.pool,
      boardId,
      after?.kind === 'rank' ? { rank: after.rank, threadId: after.threadId } : null,
      200,
    );
    selected = {
      candidates: page.candidates,
      hasMore: page.next !== null,
      epoch: page.epoch,
      position: page.position,
    };
  } else {
    const page = await pageBoardCandidates(
      dependencies.pool,
      boardId,
      after?.kind === 'created' ? { createdAt: after.createdAt, id: after.threadId } : null,
      200,
      sort === 'oldest' ? 'asc' : 'desc',
    );
    selected = {
      candidates: page.candidates,
      hasMore: page.next !== null,
      epoch: page.epoch,
      position: page.position,
    };
  }
  if (selected.epoch !== board.anchor.epoch) throw new TypeError('Invalid content cursor');
  const candidates: readonly ListedBoardCandidate[] = selected.candidates;
  const rankFreshness = new Map<string, string>();
  for (const candidate of selected.candidates) {
    if ('rankRefreshedAt' in candidate) rankFreshness.set(candidate.id, candidate.rankRefreshedAt);
  }
  const anchors: AnchoredPosition[] = [
    board.anchor,
    { partition: board.anchor.partition, epoch: selected.epoch, position: selected.position },
  ];
  const entries: ThreadView[] = [];
  const entryPositions: BoardPageAfter[] = [];
  let lastScanned: BoardPageAfter | null = null;
  let scanned = 0;
  while (scanned < candidates.length && entries.length <= limit) {
    const batch = candidates.slice(scanned, scanned + Math.max(1, limit + 1 - entries.length));
    const disclosed = await discloseThreads(
      dependencies,
      batch.map((candidate) => candidate.id),
      context,
    );
    for (const [index, candidate] of batch.entries()) {
      lastScanned =
        sort === 'active' || sort === 'hot'
          ? { kind: 'rank', rank: candidate.rank!, threadId: candidate.id }
          : { kind: 'created', createdAt: candidate.createdAt!, threadId: candidate.id };
      scanned++;
      const result = disclosed[index]!;
      anchors.push(result.anchor);
      const thread = result.value;
      if (!thread || thread.boardId !== boardId) continue;
      if (query) {
        const matched = await matchesCurrentText(dependencies, thread, query, context);
        anchors.push(matched.anchor);
        if (!matched.value) continue;
      }
      entries.push(thread);
      entryPositions.push(lastScanned);
      if (entries.length > limit) break;
    }
  }
  // Revalidate after query snapshots, keeping current fields and refusing a
  // changed revision whose text was never matched. The reader groups partitions.
  const final = await discloseThreads(
    dependencies,
    entries.map((thread) => thread.id),
    context,
  );
  const current: ThreadView[] = [];
  const currentPositions: BoardPageAfter[] = [];
  for (const [index, result] of final.entries()) {
    anchors.push(result.anchor);
    if (!result.value || result.value.boardId !== boardId) continue;
    const firstPost = result.value.firstPost;
    const previousFirstPost = entries[index]!.firstPost;
    if (
      query &&
      (isErasedPlaceholder(firstPost) ||
        isErasedPlaceholder(previousFirstPost) ||
        firstPost.revisionId !== previousFirstPost.revisionId)
    )
      continue;
    if (query && firstPost.availability !== 'available') continue;
    current.push(result.value);
    currentPositions.push(entryPositions[index]!);
  }
  const pageEntries = current.slice(0, limit);
  const parent = await readRealmBoard(dependencies, boardId, context);
  if (!parent.value) throw new ContentNotFoundError();
  if (parent.anchor.epoch !== board.anchor.epoch) throw new TypeError('Invalid content cursor');
  anchors.push(parent.anchor);
  const hasVisibleMore = current.length > limit;
  const more = hasVisibleMore || scanned < candidates.length || selected.hasMore;
  const cursorAfter =
    hasVisibleMore || (entries.length > limit && pageEntries.length > 0)
      ? currentPositions[Math.min(limit, current.length) - 1]!
      : lastScanned;
  const oldest = pageEntries.at(-1);
  const rankRefreshedAt =
    (sort === 'active' || sort === 'hot') && oldest ? (rankFreshness.get(oldest.id) ?? null) : null;
  let nextCursor: string | null = null;
  if (more && cursorAfter) {
    if (cursorAfter.kind === 'rank') {
      nextCursor = encodeBoardRankCursor(dependencies.tokens, binding, parent.anchor.epoch, cursorAfter, now);
    } else {
      nextCursor = encodeBoardCursor(
        dependencies.tokens,
        binding,
        parent.anchor.epoch,
        { createdAt: cursorAfter.createdAt, threadId: cursorAfter.threadId },
        now,
      );
    }
  }
  return {
    entries: pageEntries,
    anchor: parent.anchor,
    anchors,
    nextCursor,
    rankRefreshedAt,
  };
}
