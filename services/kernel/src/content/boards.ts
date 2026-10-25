import { deadlineClient, within } from '../access/authenticate.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf } from '../route/route.ts';
import {
  decodeBoardCursor,
  encodeBoardCursor,
  normalizeBoardQuery,
  type BoardCursorBinding,
  type BoardCursorSort,
} from './board-cursor.ts';
import { pageBoardCandidates, type BoardCandidateKey } from './board-projection.ts';
import match from './match-thread-text.sql';
import type { Anchored, AnchoredPosition, Page, ReadContext, ThreadView } from './model.ts';
import { ContentNotFoundError, discloseThreads, readBoard, type ContentReadDependencies } from './reads.ts';

export type ContentBoardDependencies = ContentReadDependencies & {
  /** Trusted service configuration, independent of authentication's wall clock. */
  cursorNow?: () => number;
};
export type BoardPageInput = { cursor?: string; limit?: number; sort?: BoardCursorSort; query?: string };
export type BoardThreadPage = Page<ThreadView> & { anchors: readonly AnchoredPosition[] };

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
        const partition = await readPartition(client, partitionOf(thread.route));
        if (!partition || partition.writeState === 'moved') throw new Error('Content partition unavailable');
        const parameters = {
          route: thread.route,
          thread_id: thread.id,
          post_id: thread.firstPost.id,
          revision_id: thread.firstPost.revisionId,
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
  if (sort !== 'newest' && sort !== 'oldest') throw new TypeError('Invalid content cursor');
  const board = await readBoard(dependencies, boardId, context);
  if (!board.value) throw new ContentNotFoundError();
  const binding: BoardCursorBinding = { boardId, query, sort, viewer: context.actor };
  const now = (dependencies.cursorNow ?? Date.now)();
  let after: BoardCandidateKey | null = null;
  if (input.cursor !== undefined) {
    const decoded = decodeBoardCursor(dependencies.tokens, binding, input.cursor, board.anchor.epoch, now);
    if (!decoded.ok) throw new TypeError('Invalid content cursor');
    after = { createdAt: decoded.after.createdAt, id: decoded.after.threadId };
  }
  // One indexed range, Q <= 200, independent of how many candidates are hidden.
  const selected = await pageBoardCandidates(
    dependencies.pool,
    boardId,
    after,
    200,
    sort === 'oldest' ? 'asc' : 'desc',
  );
  if (selected.epoch !== board.anchor.epoch) throw new TypeError('Invalid content cursor');
  const anchors: AnchoredPosition[] = [
    board.anchor,
    { partition: board.anchor.partition, epoch: selected.epoch, position: selected.position },
  ];
  const entries: ThreadView[] = [];
  let scanned = 0;
  while (scanned < selected.candidates.length && entries.length < limit) {
    const batch = selected.candidates.slice(scanned, scanned + limit - entries.length);
    const disclosed = await discloseThreads(
      dependencies,
      batch.map((candidate) => candidate.id),
      context,
    );
    for (const [index, candidate] of batch.entries()) {
      after = { createdAt: candidate.createdAt, id: candidate.id };
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
  for (const [index, result] of final.entries()) {
    anchors.push(result.anchor);
    if (!result.value || result.value.boardId !== boardId) continue;
    if (query && result.value.firstPost.revisionId !== entries[index]!.firstPost.revisionId) continue;
    if (query && result.value.firstPost.availability !== 'available') continue;
    current.push(result.value);
  }
  const parent = await readBoard(dependencies, boardId, context);
  if (!parent.value) throw new ContentNotFoundError();
  if (parent.anchor.epoch !== board.anchor.epoch) throw new TypeError('Invalid content cursor');
  anchors.push(parent.anchor);
  const more = scanned < selected.candidates.length || selected.next !== null;
  return {
    entries: current,
    anchor: parent.anchor,
    anchors,
    nextCursor:
      more && after
        ? encodeBoardCursor(
            dependencies.tokens,
            binding,
            parent.anchor.epoch,
            {
              createdAt: after.createdAt,
              threadId: after.id,
            },
            now,
          )
        : null,
  };
}
