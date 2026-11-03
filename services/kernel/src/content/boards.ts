import { deadlineClient, within } from '../access/authenticate.ts';
import { accessCheck, type AccessCheck, type Actor } from '../request/access.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import { realmReadEligibility } from '../community/realm.ts';
import { readBoardPins, readBoardPinRevision } from './board-projection.ts';
import {
  decodeBoardCursor,
  decodeBoardRankCursor,
  encodeBoardCursor,
  encodeBoardRankCursor,
  normalizeBoardQuery,
  type BoardCursorBinding,
  type BoardCursorSort,
} from './board-cursor.ts';
import boardRankPage from './board-rank-page.sql';
import pageBoardThreads from './page-board-threads.sql';
import type { Anchored, AnchoredPosition, BoardView, Page, ReadContext } from './model.ts';
import {
  ContentNotFoundError,
  prepareBoardPageDecisions,
  readBoardPageCandidateSnapshot,
  selectBoardThreadCandidates,
  discloseThreads,
  withBoardDisclosure,
  readBoard,
  readBoards,
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
  pinnedThreads: readonly ThreadView[];
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
  const selected = result.candidates.slice(0, limit);
  const disclosed = await readBoards(dependencies, selected, context);
  for (let index = 0; index < selected.length; index++) {
    after = selected[index]!;
    scanned++;
    const visible = disclosed[index]!;
    anchors.push(visible.anchor);
    if (visible.value?.realmId === realmId) items.push(visible.value);
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
  const now = (dependencies.cursorNow ?? Date.now)();
  const decisions = await prepareBoardPageDecisions(dependencies, context);
  const candidateSnapshot = await readBoardPageCandidateSnapshot(
    dependencies,
    boardId,
    context,
    decisions,
    async (client, partition) => {
      // Pins, revision and the ordinary range share one board-home observation.
      const pinRevision = await readBoardPinRevision(client, boardId);
      const binding: BoardCursorBinding = {
        boardId,
        query,
        sort,
        viewer: context.actor,
        pinRevision: pinRevision ?? '0',
      };
      let after: BoardPageAfter | null = null;
      let invalidCursor = false;
      if (input.cursor !== undefined) {
        if (sort === 'active' || sort === 'hot') {
          const decoded = decodeBoardRankCursor(dependencies.tokens, binding, input.cursor, partition.epoch, now);
          if (!decoded.ok || routeOf(decoded.after.threadId) === null) invalidCursor = true;
          else after = { kind: 'rank', rank: decoded.after.rank, threadId: decoded.after.threadId };
        } else {
          const decoded = decodeBoardCursor(dependencies.tokens, binding, input.cursor, partition.epoch, now);
          if (!decoded.ok) invalidCursor = true;
          else after = { kind: 'created', createdAt: decoded.after.createdAt, threadId: decoded.after.threadId };
        }
      }
      const candidates: ListedBoardCandidate[] = [];
      if (sort === 'active' || sort === 'hot') {
        const parameters = {
          route: routeOf(boardId)!,
          board_id: boardId,
          active_rank: after?.kind === 'rank' ? after.rank : 0,
          thread_id: after?.kind === 'rank' ? after.threadId : '00000000-0000-0000-0000-000000000000',
          has_after: after !== null && after.kind === 'rank',
          limit: 200,
        };
        const sql =
          sort === 'hot'
            ? boardRankPage.sql.replaceAll('candidate.active_rank', 'candidate.hot_rank')
            : boardRankPage.sql;
        const result = await client.query<{
          thread_id: string;
          active_rank?: number;
          hot_rank?: number;
          rank_refreshed_at: string | null;
        }>(
          sql,
          boardRankPage.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        for (const row of result.rows) {
          if (row.rank_refreshed_at === null) throw new Error('Board rank freshness is missing');
          candidates.push({
            id: row.thread_id,
            rank: sort === 'hot' ? row.hot_rank! : row.active_rank!,
            rankRefreshedAt: row.rank_refreshed_at,
          });
        }
      } else {
        const parameters = {
          route: routeOf(boardId)!,
          board_id: boardId,
          created_at: after?.kind === 'created' ? after.createdAt : sort === 'oldest' ? '-infinity' : 'infinity',
          thread_id: after?.kind === 'created' ? after.threadId : '00000000-0000-0000-0000-000000000000',
          limit: 200,
        };
        const sql =
          sort === 'oldest'
            ? pageBoardThreads.sql.replace(') < (', ') > (').replaceAll(' DESC', ' ASC')
            : pageBoardThreads.sql;
        const result = await client.query<(typeof pageBoardThreads)['~reylo']['element']>(
          sql,
          pageBoardThreads.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        for (const row of result.rows) candidates.push({ id: row.thread_id, createdAt: row.created_at! });
      }
      const pinnedIds = await readBoardPins(client, boardId);
      return {
        candidates,
        pinnedIds,
        pinRevision,
        binding,
        hasMore: candidates.length === 200,
        invalidCursor,
        epoch: partition.epoch,
        position: partition.position,
      };
    },
  );
  if (!candidateSnapshot) throw new ContentNotFoundError();
  const board = candidateSnapshot.board;
  const boardAnchor = candidateSnapshot.anchor.anchor;
  const selected = candidateSnapshot.candidate;
  const binding = selected.binding;
  if (selected.pinRevision === null) throw new ContentNotFoundError();
  if (selected.invalidCursor) throw new TypeError('Invalid content cursor');
  if (selected.epoch !== boardAnchor.epoch) throw new TypeError('Invalid content cursor');
  const candidates: readonly ListedBoardCandidate[] = selected.candidates;
  const pinnedIdSet = new Set(selected.pinnedIds);
  const rankFreshness = new Map<string, string>();
  for (const candidate of candidates) {
    if ('rankRefreshedAt' in candidate) rankFreshness.set(candidate.id, candidate.rankRefreshedAt);
  }
  const anchors: AnchoredPosition[] = [
    boardAnchor,
    { partition: boardAnchor.partition, epoch: selected.epoch, position: selected.position },
  ];
  const entries: string[] = [];
  const entryPositions: BoardPageAfter[] = [];
  const expectedRevisions = new Map<string, string>();
  let lastScanned: BoardPageAfter | null = null;
  let scanned = 0;
  const readRound = async (batch: readonly ListedBoardCandidate[]) => {
    if (batch.length === 0) return;
    const round = await selectBoardThreadCandidates(
      dependencies,
      boardId,
      batch.map((candidate) => candidate.id),
      context,
      decisions,
      query,
    );
    anchors.push(...round.anchors);
    const survivors = new Set(round.survivors);
    for (const candidate of batch) {
      lastScanned =
        sort === 'active' || sort === 'hot'
          ? { kind: 'rank', rank: candidate.rank!, threadId: candidate.id }
          : { kind: 'created', createdAt: candidate.createdAt!, threadId: candidate.id };
      scanned++;
      if (!survivors.has(candidate.id) || pinnedIdSet.has(candidate.id)) continue;
      const revision = round.revisions.get(candidate.id);
      if (!revision) continue;
      entries.push(candidate.id);
      expectedRevisions.set(candidate.id, revision);
      entryPositions.push(lastScanned);
    }
  };
  const firstRoundSize = Math.min(candidates.length, 2 * (limit + 1) + 1, 200);
  await readRound(candidates.slice(0, firstRoundSize));
  if (entries.length <= limit && scanned < candidates.length) await readRound(candidates.slice(scanned));

  let finalState: { boardAnchor: AnchoredPosition; parentAllowed: boolean } | undefined;
  const finalItems = await withBoardDisclosure(
    boardId,
    board,
    () => discloseThreads(dependencies, entries.slice(0, limit + 1), context),
    decisions,
    { query, expectedRevisions, onFinal: (value) => (finalState = value) },
  );
  if (!finalState) throw new Error('Board page disclosure did not complete');
  anchors.push(...finalItems.map((result) => result.anchor), finalState.boardAnchor);
  if (!finalState.parentAllowed) throw new ContentNotFoundError();
  const current: ThreadView[] = [];
  const currentPositions: BoardPageAfter[] = [];
  for (const [index, result] of finalItems.entries()) {
    if (!result.value || result.value.boardId !== boardId) continue;
    if (pinnedIdSet.has(result.value.id)) continue;
    if (query && result.value.firstPost.availability !== 'available') continue;
    current.push(result.value);
    currentPositions.push(entryPositions[index]!);
  }
  const pageEntries = current.slice(0, limit);
  if (finalState.boardAnchor.epoch !== boardAnchor.epoch) throw new TypeError('Invalid content cursor');

  const pinnedSelection = await selectBoardThreadCandidates(
    dependencies,
    boardId,
    input.cursor === undefined ? selected.pinnedIds : [],
    context,
    decisions,
    query,
  );
  anchors.push(...pinnedSelection.anchors);
  let pinnedThreads: ThreadView[] = [];
  if (pinnedSelection.survivors.length) {
    let pinnedFinalState: { boardAnchor: AnchoredPosition; parentAllowed: boolean } | undefined;
    const pinnedItems = await withBoardDisclosure(
      boardId,
      board,
      () => discloseThreads(dependencies, pinnedSelection.survivors as ThreadView['id'][], context),
      decisions,
      {
        query,
        expectedRevisions: pinnedSelection.revisions,
        onFinal: (value) => (pinnedFinalState = value),
      },
    );
    if (!pinnedFinalState) throw new Error('Board pin disclosure did not complete');
    anchors.push(...pinnedItems.map((result) => result.anchor), pinnedFinalState.boardAnchor);
    if (!pinnedFinalState.parentAllowed) throw new ContentNotFoundError();
    pinnedThreads = pinnedItems.flatMap((result) => (result.value?.boardId === boardId ? [result.value] : []));
  }
  // Release every thread/parent disclosure snapshot before taking the final
  // board-home observation. A changed cohort (including pin/unpin ABA) cannot
  // issue a token under an old exclusion set. Parent access is current here too.
  const finalObservation = await readBoardPageCandidateSnapshot(dependencies, boardId, context, decisions, (client) =>
    readBoardPinRevision(client, boardId),
  );
  if (!finalObservation) throw new ContentNotFoundError();
  if (finalObservation.candidate !== selected.pinRevision || finalObservation.anchor.anchor.epoch !== selected.epoch)
    throw new TypeError('Invalid content cursor');
  anchors.push(finalObservation.anchor.anchor);

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
      nextCursor = encodeBoardRankCursor(dependencies.tokens, binding, finalState.boardAnchor.epoch, cursorAfter, now);
    } else {
      nextCursor = encodeBoardCursor(
        dependencies.tokens,
        binding,
        finalState.boardAnchor.epoch,
        { createdAt: cursorAfter.createdAt, threadId: cursorAfter.threadId },
        now,
      );
    }
  }
  return {
    entries: pageEntries,
    pinnedThreads,
    anchor: finalState.boardAnchor,
    anchors,
    nextCursor,
    rankRefreshedAt,
  };
}
