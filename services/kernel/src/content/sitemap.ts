import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
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

function binding(feed: Feed): CursorBinding {
  return { operation: `sitemap.${feed}.list`, parameters: {} };
}

function cipherKey(ring: KeyRing, kid: number, purpose: string): Buffer {
  const key = ring.keys.get(kid);
  if (!key || key.byteLength < 32) throw new InvalidSitemapCursorError();
  return createHmac('sha256', key).update(purpose).digest();
}

/** Seal a feed's position inside the shared signed cursor. Give each feed its own encryption purpose.
 * Identical positions issued at the same instant have identical bytes for anonymous and bearer callers. */
export function sealSitemapPosition(
  ring: KeyRing,
  scope: CursorBinding,
  purpose: string,
  position: unknown,
  now = Date.now(),
): string {
  const plaintext = JSON.stringify(position);
  if (typeof plaintext !== 'string') throw new TypeError('Invalid sitemap position');
  // A separately derived HMAC nonce binds the IV to plaintext and issue time, with a 96-bit collision bound.
  // Identical plaintext at the same instant intentionally produces the same ciphertext.
  const iv = createHmac('sha256', cipherKey(ring, ring.current, `${purpose}.nonce`))
    .update(JSON.stringify([scope, now, plaintext]))
    .digest()
    .subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', cipherKey(ring, ring.current, purpose), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  return encodeCursor(ring, scope, { epoch: CURSOR_EPOCH, after: [ring.current, payload] }, now);
}

/** Open a feed position; callers validate their position's shape after authentication and decryption. */
export function openSitemapPosition(
  ring: KeyRing,
  scope: CursorBinding,
  purpose: string,
  token: string,
  now = Date.now(),
): unknown {
  try {
    const decoded = decodeCursor(ring, scope, token, now);
    if (!decoded.ok || decoded.epoch !== CURSOR_EPOCH || decoded.after.length !== 2) throw new Error();
    const [kid, payload] = decoded.after;
    if (typeof kid !== 'number' || typeof payload !== 'string' || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error();
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.length < 29 || bytes.toString('base64url') !== payload) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', cipherKey(ring, kid, purpose), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')) as unknown;
  } catch {
    throw new InvalidSitemapCursorError();
  }
}

function purpose(feed: Feed): string {
  return `content.sitemap.${feed}.cursor.encryption.v1`;
}

function decodePosition(dependencies: ContentBoardDependencies, feed: Feed, cursor?: string): Position | null {
  if (cursor === undefined) return null;
  const position = openSitemapPosition(
    dependencies.tokens,
    binding(feed),
    purpose(feed),
    cursor,
    (dependencies.cursorNow ?? Date.now)(),
  );
  if (
    !position ||
    typeof position !== 'object' ||
    !('boardId' in position) ||
    typeof position.boardId !== 'string' ||
    routeOf(position.boardId) === null ||
    !('scanning' in position) ||
    typeof position.scanning !== 'boolean' ||
    !('thread' in position)
  )
    throw new InvalidSitemapCursorError();
  const thread = position.thread;
  if (
    thread !== null &&
    (!position.scanning ||
      !thread ||
      typeof thread !== 'object' ||
      !('createdAt' in thread) ||
      typeof thread.createdAt !== 'string' ||
      !MICROSECOND_INSTANT.test(thread.createdAt) ||
      !Number.isFinite(Date.parse(thread.createdAt)) ||
      !('id' in thread) ||
      typeof thread.id !== 'string' ||
      routeOf(thread.id) === null)
  )
    throw new InvalidSitemapCursorError();
  return { boardId: position.boardId, scanning: position.scanning, thread: thread as Position['thread'] };
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
  let position = decodePosition(dependencies, feed, input.cursor);
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
        : sealSitemapPosition(
            dependencies.tokens,
            binding(feed),
            purpose(feed),
            position,
            (dependencies.cursorNow ?? Date.now)(),
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
