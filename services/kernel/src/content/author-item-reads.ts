import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { deadlineClient, within } from '../access/authenticate.ts';
import { readPublicViews } from '../access/public-views.ts';
import { accessCheck, type AccessCheck, type Actor } from '../request/access.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { isErasedPlaceholder, type AnchoredPosition, type ReadContext } from './model.ts';
import {
  ContentNotFoundError,
  readThread,
  readPost,
  type ItemView,
  type ContentReadDependencies,
  type ThreadView,
} from './reads.ts';
import threadPage from './author-item-threads.sql';
import postPage from './author-item-posts.sql';

export type AuthorThreadKind = 'discussion' | 'review';
export type AuthorPageInput = { cursor?: string; limit?: number };
export type AuthorThreadPageInput = AuthorPageInput & { kind?: AuthorThreadKind };
export type AuthorPostEntry = Extract<ItemView, { availability: 'available' }> & {
  thread: { id: string; title: string | null };
};
export type AuthorItemDependencies = ContentReadDependencies & { cursorNow?: () => number };
export type AuthorPage<T> = { entries: readonly T[]; nextCursor: string | null; anchors: readonly AnchoredPosition[] };
type Key = { createdAt: string; itemId: string };
type Candidate = Key & { threadId: string };
type List = 'threads' | 'posts';

const PAGE_LIMIT = 20;
const SCAN_FACTOR = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.toISOString().slice(0, 19) === value.slice(0, 19);
}

function binding(accountId: string, list: List, kind: AuthorThreadKind | null, actor: Actor): CursorBinding {
  return {
    operation: 'author.items.list',
    parameters: {
      accountId,
      list,
      kind,
      viewer: actor.kind === 'account' ? actor.accountId : null,
    },
  };
}

// A signed cursor alone is readable. Encrypt the boundary so skipped candidates
// cannot disclose their identities or creation times through continuation tokens.
function cursorCipherKey(ring: KeyRing, kid: number): Buffer {
  const key = ring.keys.get(kid);
  if (!key || key.byteLength < 32) throw new TypeError('Invalid content cursor');
  return createHmac('sha256', key).update('content.author-item.cursor.encryption.v1').digest();
}

export function encodeAuthorItemKey(ring: KeyRing, scope: CursorBinding, key: Key, epoch: number, now: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cursorCipherKey(ring, ring.current), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(key), 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  return encodeCursor(ring, scope, { epoch, after: [ring.current, payload] }, now);
}

export function decodeAuthorItemKey(ring: KeyRing, scope: CursorBinding, token: string, epoch: number, now: number): Key {
  try {
    const decoded = decodeCursor(ring, scope, token, now);
    if (!decoded.ok || decoded.epoch !== epoch || decoded.after.length !== 2) throw new Error();
    const [kid, payload] = decoded.after;
    if (typeof kid !== 'number' || typeof payload !== 'string' || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error();
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.length < 29 || bytes.toString('base64url') !== payload) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', cursorCipherKey(ring, kid), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const key: unknown = JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
    );
    if (
      !key ||
      typeof key !== 'object' ||
      !('createdAt' in key) ||
      !('itemId' in key) ||
      !timestamp(key.createdAt) ||
      typeof key.itemId !== 'string' ||
      !UUID.test(key.itemId) ||
      routeOf(key.itemId) === null
    )
      throw new Error();
    return { createdAt: key.createdAt, itemId: key.itemId };
  } catch {
    throw new TypeError('Invalid content cursor');
  }
}

async function candidates(
  dependencies: AuthorItemDependencies,
  accountId: string,
  context: ReadContext,
  input: AuthorPageInput,
  list: List,
  kind: AuthorThreadKind | null,
  limit: number,
  scope: CursorBinding,
  now: number,
  presentationCheck: AccessCheck | null,
): Promise<{ candidates: readonly Candidate[]; anchor: AnchoredPosition }> {
  const route = routeOf(accountId);
  if (route === null) throw new ContentNotFoundError();
  return within(context.deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout = '3000ms'");
        const partition = await readPartition(client, partitionOf(route));
        if (!partition) throw new CommandUnavailableError('deadline', partitionOf(route));
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionOf(route), partition.movedTo);
        const after =
          input.cursor === undefined ? null : decodeAuthorItemKey(dependencies.tokens, scope, input.cursor, partition.epoch, now);
        const views = (await readPublicViews(client, [accountId])).get(accountId);
        const enabled = list === 'posts' || kind === 'discussion' ? views?.posts : views?.reviews;
        const self = context.actor.kind === 'account' && context.actor.accountId === accountId;
        if (!enabled && !self) {
          const actingFor = presentationCheck ? await presentationCheck(client) : false;
          if (!actingFor) {
            await client.query('COMMIT');
            return { candidates: [], anchor: { partition, epoch: partition.epoch, position: partition.position } };
          }
        }
        const parameters = {
          route,
          author_account_id: accountId,
          kind,
          has_after: after !== null,
          after_at: after?.createdAt ?? 'infinity',
          after_item_id: after?.itemId ?? '00000000-0000-0000-0000-000000000000',
          limit,
        };
        const page = list === 'threads' ? threadPage : postPage;
        const rows = await client.query<(typeof threadPage)['~reylo']['element']>(
          page.sql,
          page.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        await client.query('COMMIT');
        return {
          candidates: rows.rows.map((row) => ({
            itemId: row.item_id,
            threadId: row.thread_id,
            createdAt: row.created_at!,
          })),
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

function listed(item: { availability: string; visibility?: string }): boolean {
  return item.availability === 'available' && (item.visibility === 'published' || item.visibility === 'protected');
}

async function listAuthorItems(
  dependencies: AuthorItemDependencies,
  accountId: string,
  context: ReadContext,
  input: AuthorPageInput,
  list: List,
  kind: AuthorThreadKind | null,
): Promise<AuthorPage<ThreadView | AuthorPostEntry>> {
  const limit = input.limit ?? PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) throw new RangeError('Page limit must be 1 to 20');
  const now = (dependencies.cursorNow ?? Date.now)();
  if (!Number.isSafeInteger(now)) throw new TypeError('Invalid content cursor');
  const scope = binding(accountId, list, kind, context.actor);
  const accountRoute = routeOf(accountId);
  const self = context.actor.kind === 'account' && context.actor.accountId === accountId;
  // Account presentation uses account:update for authorized editors, including
  // an organization's acting owners. Reuse that rule for its private lists.
  const presentationCheck =
    accountRoute !== null && context.actor.kind === 'account' && !self
      ? await accessCheck(
          dependencies.access,
          context.actor,
          'account:update',
          { route: accountRoute, id: accountId },
          { pool: dependencies.pool, deadline: context.deadline },
        )
      : null;
  const page = await candidates(
    dependencies,
    accountId,
    context,
    input,
    list,
    kind,
    limit * SCAN_FACTOR,
    scope,
    now,
    presentationCheck,
  );
  const entries: (ThreadView | AuthorPostEntry)[] = [];
  const anchors = [page.anchor];
  let scanned = 0;
  let last: Candidate | undefined;
  // The author snapshot is released before any thread or board home is opened.
  while (scanned < page.candidates.length && entries.length < limit) {
    const candidate = page.candidates[scanned++]!;
    last = candidate;
    const result = await readThread(dependencies, candidate.threadId, context);
    anchors.push(result.anchor);
    const thread = result.value;
    if (!thread || !listed(thread)) continue;
    if (list === 'threads') {
      if (thread.authorId === accountId && thread.kind === kind && listed(thread.firstPost)) entries.push(thread);
    } else {
      // Opening-post erasure leaves reply context readable, with the disclosed null title.
      if (thread.firstPost.availability !== 'erased' && !listed(thread.firstPost)) continue;
      if ('visibility' in thread.firstPost && !['published', 'protected'].includes(thread.firstPost.visibility))
        continue;
      if (candidate.itemId === thread.firstPost.id) continue;
      const post = await readPost(dependencies, candidate.threadId, candidate.itemId, context);
      anchors.push(post.anchor);
      if (
        post.value &&
        !isErasedPlaceholder(post.value) &&
        post.value.availability === 'available' &&
        listed(post.value) &&
        post.value.authorId === accountId
      ) {
        entries.push({ ...post.value, thread: { id: thread.id, title: thread.title } });
      }
    }
  }
  const hasMore = scanned < page.candidates.length || page.candidates.length === limit * SCAN_FACTOR;
  return {
    entries,
    anchors,
    nextCursor: hasMore && last ? encodeAuthorItemKey(dependencies.tokens, scope, last, page.anchor.epoch, now) : null,
  };
}

export async function listAuthorThreads(
  dependencies: AuthorItemDependencies,
  accountId: string,
  context: ReadContext,
  input: AuthorThreadPageInput = {},
): Promise<AuthorPage<ThreadView>> {
  const kind = input.kind ?? 'discussion';
  if (kind !== 'discussion' && kind !== 'review') throw new TypeError('Invalid author thread kind');
  return (await listAuthorItems(dependencies, accountId, context, input, 'threads', kind)) as AuthorPage<ThreadView>;
}

export async function listAuthorPosts(
  dependencies: AuthorItemDependencies,
  accountId: string,
  context: ReadContext,
  input: AuthorPageInput = {},
): Promise<AuthorPage<AuthorPostEntry>> {
  return (await listAuthorItems(dependencies, accountId, context, input, 'posts', null)) as AuthorPage<AuthorPostEntry>;
}
