import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import { readRealmBoard, type ContentBoardDependencies } from './boards.ts';
import { isErasedPlaceholder, type ReadContext } from './model.ts';
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
const CANDIDATES_PER_ITEM = 4;
const MAX_DISCLOSURE = 200;
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const MAX_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const MICROSECOND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** Sitemap cursors cross partitions, so no partition epoch applies. */
const CURSOR_EPOCH = 1;

type Feed = 'boards' | 'threads';
type Position = {
  boardId: string;
  /** An unfinished board's thread range continues on the next page, including when no thread was read yet. */
  scanning: boolean;
  thread: { createdAt: string; id: string } | null;
};

function binding(feed: Feed): ListCursorBinding {
  return { route: `GET /v1/sitemap/${feed}`, viewer: null, query: {} };
}

async function decodePosition(
  dependencies: ContentBoardDependencies,
  feed: Feed,
  cursor?: string,
): Promise<Position | null> {
  if (cursor === undefined) return null;
  const decoded = await decodeListCursor(
    dependencies.tokens,
    binding(feed),
    cursor,
    new Date((dependencies.cursorNow ?? Date.now)()),
  );
  if (!decoded.ok || decoded.epoch !== CURSOR_EPOCH || decoded.after.length !== 4)
    throw new InvalidSitemapCursorError();
  const [boardId, scanning, createdAt, threadId] = decoded.after;
  if (
    typeof boardId !== 'string' ||
    routeOf(boardId) === null ||
    (scanning !== 0 && scanning !== 1) ||
    typeof createdAt !== 'string' ||
    typeof threadId !== 'string'
  )
    throw new InvalidSitemapCursorError();
  const thread = createdAt === '' && threadId === '' ? null : { createdAt, id: threadId };
  if (
    thread !== null &&
    (scanning !== 1 ||
      !thread ||
      !MICROSECOND_INSTANT.test(thread.createdAt) ||
      !Number.isFinite(Date.parse(thread.createdAt)) ||
      routeOf(thread.id) === null)
  )
    throw new InvalidSitemapCursorError();
  if ((scanning === 0 && thread !== null) || (createdAt === '') !== (threadId === ''))
    throw new InvalidSitemapCursorError();
  return { boardId, scanning: scanning === 1, thread };
}

function instant(value: string): string {
  // Whole milliseconds read as ISO milliseconds; finer ties keep their precision.
  return value.replace(/(\.\d{3})000Z$/, '$1Z');
}

/** The board page's shared disclosure, with the sitemap's available opening-post requirement. */
function isListedThread(thread: ThreadView | null, boardId: string): thread is ThreadView {
  return (
    thread !== null &&
    thread.boardId === boardId &&
    thread.availability === 'available' &&
    !isErasedPlaceholder(thread.firstPost) &&
    thread.firstPost.availability === 'available'
  );
}

async function listSitemap(
  dependencies: ContentBoardDependencies,
  deadline: number,
  feed: Feed,
  input: SitemapInput,
): Promise<SitemapPage<SitemapBoard | SitemapThread>> {
  const limit = input.limit ?? SITEMAP_MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SITEMAP_MAX_LIMIT)
    throw new RangeError(`Page limit must be 1 to ${SITEMAP_MAX_LIMIT}`);
  let position = await decodePosition(dependencies, feed, input.cursor);
  const reader: ReadContext = { actor: { kind: 'anonymous' }, deadline };
  const items: (SitemapBoard | SitemapThread)[] = [];
  let budget = limit * CANDIDATES_PER_ITEM;
  let finished = false;
  while (budget > 0 && items.length < limit) {
    if (!position?.scanning) {
      // Read only the board we will process. Charging a prefetched board without advancing to it could lose it
      // when the page runs out of budget; advancing past it could lose its threads.
      const after = position?.boardId;
      const rows = await withConnection(dependencies.pool, (client) =>
        pageBoards.run(client, { route: after ? routeOf(after)! : -1, board_id: after ?? ZERO_ID, limit: 1 }),
      );
      if (!rows.length) {
        finished = true;
        break;
      }
      budget--;
      position = { boardId: rows[0]!.board_id, scanning: true, thread: null };
    }
    const boardId: string = position.boardId;
    const board = await readRealmBoard(dependencies, boardId, reader);
    if (!board.value) {
      position = { boardId, scanning: false, thread: null };
      continue;
    }
    while (budget > 0 && items.length < limit && position.scanning) {
      const want = feed === 'boards' ? 1 : Math.min(budget, limit - items.length, MAX_DISCLOSURE);
      const after: Position['thread'] = position.thread;
      const parameters: { route: number; board_id: string; created_at: string; thread_id: string; limit: number } = {
        route: routeOf(boardId)!,
        board_id: boardId,
        created_at: after?.createdAt ?? (feed === 'boards' ? 'infinity' : '-infinity'),
        thread_id: after?.id ?? (feed === 'boards' ? MAX_ID : ZERO_ID),
        limit: want,
      };
      const rows: readonly (typeof pageThreads)['~reylo']['element'][] = await withConnection(
        dependencies.pool,
        (client) => (feed === 'boards' ? newestThreads.run(client, parameters) : pageThreads.run(client, parameters)),
      );
      budget -= rows.length;
      const disclosed = await discloseThreads(
        dependencies,
        rows.map((row) => row.thread_id),
        reader,
      );
      for (const [index, row] of rows.entries()) {
        position = { boardId, scanning: true, thread: { createdAt: row.created_at!, id: row.thread_id } };
        const thread = disclosed[index]!.value;
        if (!isListedThread(thread, boardId)) continue;
        if (feed === 'boards') {
          items.push({ id: boardId, lastModified: instant(row.created_at!) });
          position = { boardId, scanning: false, thread: null };
          break;
        }
        items.push({ id: thread.id, title: thread.title, lastModified: instant(row.last_activity_at!) });
      }
      if (rows.length < want) position = { boardId, scanning: false, thread: null };
    }
  }
  return {
    items,
    next:
      finished || position === null
        ? null
        : await encodeListCursor(
            dependencies.tokens,
            binding(feed),
            {
              epoch: CURSOR_EPOCH,
              after: [
                position.boardId,
                position.scanning ? 1 : 0,
                position.thread?.createdAt ?? '',
                position.thread?.id ?? '',
              ],
            },
            new Date((dependencies.cursorNow ?? Date.now)()),
          ),
  };
}

/** Boards with at least one listed thread. The newest listed thread determines lastModified; if the scan budget
 * ends before finding one, the encrypted cursor continues that board's descending thread range. */
export async function listSitemapBoards(
  dependencies: ContentBoardDependencies,
  deadline: number,
  input: SitemapInput = {},
): Promise<SitemapPage<SitemapBoard>> {
  return listSitemap(dependencies, deadline, 'boards', input);
}

/** Threads walk listed containers in immutable creation order, reusing the anonymous board page's disclosure. */
export async function listSitemapThreads(
  dependencies: ContentBoardDependencies,
  deadline: number,
  input: SitemapInput = {},
): Promise<SitemapPage<SitemapThread>> {
  return listSitemap(dependencies, deadline, 'threads', input) as Promise<SitemapPage<SitemapThread>>;
}
