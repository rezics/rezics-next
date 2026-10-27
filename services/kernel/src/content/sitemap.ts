import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import { indexedReadAccess, readRealmBoard, type ContentBoardDependencies } from './boards.ts';
import { isErasedPlaceholder } from './model.ts';
import type { ReadContext } from './model.ts';
import { discloseThreads, type ThreadView } from './reads.ts';
import newestThreads from './sitemap-board-newest.sql';
import pageBoards from './sitemap-board-page.sql';
import pageThreads from './sitemap-thread-page.sql';

export type SitemapInput = { cursor?: string; limit?: number };
export type SitemapBoard = { id: string; lastModified: string };
export type SitemapThread = { id: string; title: string | null; lastModified: string };
export type SitemapPage<Item> = { items: Item[]; next: string | null };

/** The cursor is not valid for this feed, or it has expired. */
export class InvalidSitemapCursorError extends Error {
  constructor() {
    super('Invalid sitemap cursor');
    this.name = 'InvalidSitemapCursorError';
  }
}

export const SITEMAP_MAX_LIMIT = 1000;
/** A page examines at most this many candidate rows for each requested item. */
const CANDIDATES_PER_ITEM = 4;
/** A board is listed when one of its newest threads is; a board with only unlisted threads that new is thin. */
const NEWEST_THREADS = 8;
const MAX_DISCLOSURE = 200;
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const MICROSECOND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** Sitemap cursors cross partitions, so no partition epoch applies. */
const CURSOR_EPOCH = 1;

type Position = { boardId: string; thread: { createdAt: string; id: string } | null };

function binding(operation: string): CursorBinding {
  return { operation, parameters: {} };
}

function instant(value: string): string {
  // Whole milliseconds read as ISO milliseconds; finer ties keep their precision.
  return value.replace(/(\.\d{3})000Z$/, '$1Z');
}

/** A thread is listed when the anonymous public board page shows it with its first post available. */
function isListedThread(thread: ThreadView | null, boardId: string): thread is ThreadView {
  return (
    thread !== null &&
    thread.boardId === boardId &&
    thread.availability === 'available' &&
    !isErasedPlaceholder(thread.firstPost) &&
    thread.firstPost.availability === 'available'
  );
}

function pageLimit(input: SitemapInput): number {
  const limit = input.limit ?? SITEMAP_MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SITEMAP_MAX_LIMIT)
    throw new RangeError(`Page limit must be 1 to ${SITEMAP_MAX_LIMIT}`);
  return limit;
}

function decodePosition(
  dependencies: ContentBoardDependencies,
  operation: string,
  cursor: string | undefined,
): Position | null {
  if (cursor === undefined) return null;
  const now = (dependencies.cursorNow ?? Date.now)();
  const decoded = decodeCursor(dependencies.tokens, binding(operation), cursor, now);
  if (!decoded.ok || decoded.epoch !== CURSOR_EPOCH) throw new InvalidSitemapCursorError();
  const [boardId, createdAt, threadId] = decoded.after;
  if (typeof boardId !== 'string' || routeOf(boardId) === null) throw new InvalidSitemapCursorError();
  if (decoded.after.length === 1) return { boardId, thread: null };
  if (
    decoded.after.length !== 3 ||
    typeof createdAt !== 'string' ||
    !MICROSECOND_INSTANT.test(createdAt) ||
    typeof threadId !== 'string' ||
    routeOf(threadId) === null
  )
    throw new InvalidSitemapCursorError();
  return { boardId, thread: { createdAt, id: threadId } };
}

function encodePosition(dependencies: ContentBoardDependencies, operation: string, position: Position): string {
  const now = (dependencies.cursorNow ?? Date.now)();
  const after = position.thread
    ? [position.boardId, position.thread.createdAt, position.thread.id]
    : [position.boardId];
  return encodeCursor(dependencies.tokens, binding(operation), { epoch: CURSOR_EPOCH, after }, now);
}

async function fetchBoards(dependencies: ContentBoardDependencies, after: string | null, limit: number) {
  const route = after === null ? null : routeOf(after);
  return withConnection(dependencies.pool, (client) =>
    pageBoards.run(client, { route: route ?? -1, board_id: after ?? ZERO_ID, limit }),
  );
}

/** Every feed evaluates as the anonymous reader, whatever the caller sends. */
function anonymousReader(deadline: number): ReadContext {
  return { actor: { kind: 'anonymous' }, deadline };
}

/** The creation time of the board's newest listed thread, looked for among its newest few candidates only. */
async function newestListedThread(
  dependencies: ContentBoardDependencies,
  readDependencies: ContentBoardDependencies,
  boardId: string,
  reader: ReadContext,
): Promise<string | null> {
  const candidates = await withConnection(dependencies.pool, (client) =>
    newestThreads.run(client, { route: routeOf(boardId)!, board_id: boardId, limit: NEWEST_THREADS }),
  );
  for (const candidate of candidates) {
    const [disclosed] = await discloseThreads(readDependencies, [candidate.thread_id], reader);
    if (isListedThread(disclosed!.value, boardId)) return instant(candidate.created_at!);
  }
  return null;
}

/** Keyset page of the boards an anonymous reader can open and that have a listed thread. Candidate ids carry no
 * authority; each goes through the current board and Realm disclosure checks. */
export async function listSitemapBoards(
  dependencies: ContentBoardDependencies,
  deadline: number,
  input: SitemapInput = {},
): Promise<SitemapPage<SitemapBoard>> {
  const limit = pageLimit(input);
  const operation = 'sitemap.boards.list';
  const position = decodePosition(dependencies, operation, input.cursor);
  const readDependencies = { ...dependencies, access: indexedReadAccess(dependencies.access) };
  const reader = anonymousReader(deadline);
  const items: SitemapBoard[] = [];
  let last = position?.boardId ?? null;
  let budget = limit * CANDIDATES_PER_ITEM;
  let exhausted = false;
  while (!exhausted && items.length < limit && budget > 0) {
    const chunk = Math.min(budget, limit - items.length);
    const rows = await fetchBoards(dependencies, last, chunk);
    budget -= rows.length;
    let stopped = false;
    for (const { board_id: id } of rows) {
      if (items.length >= limit) {
        stopped = true;
        break;
      }
      last = id;
      const board = await readRealmBoard(readDependencies, id, reader);
      if (!board.value) continue;
      const lastModified = await newestListedThread(dependencies, readDependencies, id, reader);
      if (lastModified) items.push({ id, lastModified });
    }
    if (!stopped && rows.length < chunk) exhausted = true;
  }
  return {
    items,
    next: exhausted || last === null ? null : encodePosition(dependencies, operation, { boardId: last, thread: null }),
  };
}

/** Keyset page of the threads an anonymous reader can open, walked board by board in creation order. Threads of an
 * unlisted board are never read. Candidate ids carry no authority; the shared thread disclosure decides. */
export async function listSitemapThreads(
  dependencies: ContentBoardDependencies,
  deadline: number,
  input: SitemapInput = {},
): Promise<SitemapPage<SitemapThread>> {
  const limit = pageLimit(input);
  const operation = 'sitemap.threads.list';
  const start = decodePosition(dependencies, operation, input.cursor);
  const readDependencies = { ...dependencies, access: indexedReadAccess(dependencies.access) };
  const reader = anonymousReader(deadline);
  const items: SitemapThread[] = [];
  let position = start;
  let resume = start?.thread ? start.boardId : null;
  let budget = limit * CANDIDATES_PER_ITEM;
  let finished = false;
  let stopped = false;
  while (!finished && !stopped && items.length < limit && budget > 0) {
    let boards: { id: string; resumed: boolean }[];
    let last = false;
    if (resume !== null) {
      boards = [{ id: resume, resumed: true }];
      resume = null;
    } else {
      const chunk = Math.min(budget, limit - items.length);
      const rows = await fetchBoards(dependencies, position?.boardId ?? null, chunk);
      budget -= rows.length;
      boards = rows.map((row) => ({ id: row.board_id, resumed: false }));
      last = rows.length < chunk;
    }
    for (const { id, resumed } of boards) {
      if (items.length >= limit || budget <= 0) {
        stopped = true;
        break;
      }
      position = { boardId: id, thread: resumed ? (start?.thread ?? null) : null };
      const board = await readRealmBoard(readDependencies, id, reader);
      if (!board.value) {
        position = { boardId: id, thread: null };
        continue;
      }
      let after = position.thread;
      for (;;) {
        if (items.length >= limit || budget <= 0) {
          stopped = true;
          break;
        }
        const want = Math.min(budget, limit - items.length, MAX_DISCLOSURE);
        const rows = await withConnection(dependencies.pool, (client) =>
          pageThreads.run(client, {
            route: routeOf(id)!,
            board_id: id,
            created_at: after?.createdAt ?? '-infinity',
            thread_id: after?.id ?? ZERO_ID,
            limit: want,
          }),
        );
        budget -= rows.length;
        const disclosed = await discloseThreads(
          readDependencies,
          rows.map((row) => row.thread_id),
          reader,
        );
        for (const [index, row] of rows.entries()) {
          after = { createdAt: row.created_at!, id: row.thread_id };
          position = { boardId: id, thread: after };
          const thread = disclosed[index]!.value;
          if (isListedThread(thread, id))
            items.push({ id: thread!.id, title: thread!.title, lastModified: instant(row.last_activity_at!) });
          if (items.length >= limit) break;
        }
        if (items.length >= limit) {
          stopped = true;
          break;
        }
        if (rows.length < want) {
          position = { boardId: id, thread: null };
          break;
        }
      }
      if (stopped) break;
    }
    if (!stopped && last) finished = true;
  }
  return { items, next: finished || position === null ? null : encodePosition(dependencies, operation, position) };
}
