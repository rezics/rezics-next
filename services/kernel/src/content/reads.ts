import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { createResourcePublicEligibility } from '../access/public-eligibility.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccessCheck, type AccessClient, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type {
  Anchored,
  BoardId,
  BoardView,
  ItemView as StoredItemView,
  Page,
  PostId,
  ReadContext,
  RevisionId,
  RevisionView as StoredRevisionView,
  ThreadId,
  ThreadView as StoredThreadView,
  Visibility,
} from './model.ts';
import { REACTION_KINDS } from './events.ts';
import { pagePostCandidates } from './post-pages.ts';
import { pageRevisionCandidates } from './revision-pages.ts';
import read from './read-chain.sql';
import viewerReactions from './reaction-viewer.sql';

const reactionKinds: ReadonlySet<string> = new Set(REACTION_KINDS);
export type ViewerReactionKind = (typeof REACTION_KINDS)[number];

/** Erased slots retain identity without disclosing bytes or a digest of erased text. */
type ContentPayload =
  | Readonly<{ availability: 'available'; body: NonNullable<StoredItemView['body']>; sha256: string }>
  | Readonly<{ availability: 'erased'; removed: true; body: null; sha256: null }>;
export type ItemView = Omit<StoredItemView, 'availability' | 'body' | 'sha256'> & ContentPayload;
export type RevisionView = Omit<StoredRevisionView, 'availability' | 'body' | 'sha256'> & ContentPayload;
export type ThreadView = Omit<StoredThreadView, 'firstPost'> & Readonly<{ firstPost: ItemView }>;

export type ContentReadDependencies = Readonly<{ pool: Pool; access: Access; tokens: KeyRing; clock?: () => Date }>;
export type { Actor };

type Kind = 'board' | 'thread' | 'post' | 'revision';
type Row = {
  kind: Kind;
  id: string;
  thread_id: string | null;
  board_id: string | null;
  parent_id: string | null;
  author_id: string | null;
  head_id: string | null;
  first_post_id: string | null;
  title: string | null;
  visibility: Visibility;
  security_revision: string;
  availability: 'available' | 'erased';
  created_at: Date;
  revised_at: Date | null;
  licence: string;
  subject_ids: string[];
  media_ids: string[];
  body: Buffer | null;
  sha256: Buffer;
};
type Chain = { thread: Row; posts: Row[]; revision: Row | null };
type Key = { at: string; id: string };

export class ContentNotFoundError extends Error {
  constructor() {
    super('Content not found');
    this.name = 'ContentNotFoundError';
  }
}

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Invalid content identity');
  return value;
}

/** All pool preparation happens outside this boundary. A failed rollback evicts
 * the connection rather than returning an open transaction to the pool. */
async function snapshot<T>(
  dependencies: ContentReadDependencies,
  id: string,
  context: ReadContext,
  work: (client: AccessClient) => Promise<T>,
): Promise<Anchored<T>> {
  return within(context.deadline, () =>
    withConnection(dependencies.pool, async (connection) => {
      const client = deadlineClient(connection, context.deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, partitionOf(route(id)));
        if (!partition || partition.writeState === 'moved') throw new Error('Content partition unavailable');
        const value = await work(client);
        await client.query('COMMIT');
        return { value, anchor: { partition, epoch: partition.epoch, position: partition.position } };
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

async function point(client: AccessClient, kind: Kind, id: string, threadId = id, bytes = false): Promise<Row | null> {
  const parameters = { route: route(id), id, kind, thread_id: threadId, include_body: bytes };
  const { rows } = await client.query<Row>(
    read.sql,
    read.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  return rows.length === 1 ? rows[0]! : null;
}

/** The terminal null parent must be observed. A cycle, foreign thread, missing
 * row or 33rd reply ancestor is absence, never a truncated visible chain. */
async function chain(
  client: AccessClient,
  threadId: string,
  postId?: string,
  revisionId?: string,
): Promise<Chain | null> {
  const thread = await point(client, 'thread', threadId);
  if (!thread) return null;
  const posts: Row[] = [];
  const seen = new Set<string>();
  let id = postId;
  while (id) {
    if (route(id) !== route(threadId) || seen.has(id) || posts.length >= 33) return null;
    seen.add(id);
    const post = await point(client, 'post', id, threadId);
    if (!post || !post.head_id) return null;
    posts.push(post);
    id = post.parent_id ?? undefined;
  }
  const selected = posts[0];
  const revision = selected ? await point(client, 'revision', revisionId ?? selected.head_id!, threadId) : null;
  if (selected && (!revision || revision.parent_id !== selected.id)) return null;
  return { thread, posts, revision };
}

const signature = (row: Row) =>
  JSON.stringify([
    row.kind,
    row.id,
    row.thread_id,
    row.board_id,
    row.parent_id,
    row.author_id,
    row.head_id,
    row.first_post_id,
    row.visibility,
    row.security_revision,
    row.availability,
  ]);
const fingerprint = (value: Chain | null) =>
  value &&
  JSON.stringify([signature(value.thread), ...value.posts.map(signature), value.revision && signature(value.revision)]);

function admissible(row: Row, context: ReadContext, tombstone: boolean): boolean {
  if (row.visibility === 'draft' && (context.actor.kind !== 'account' || row.author_id !== context.actor.accountId))
    return false;
  if (row.visibility === 'taken_down' || row.availability === 'erased') return tombstone;
  return ['published', 'protected', 'draft'].includes(row.visibility);
}

/** The shared formula alone supplies floor, grant, scope, account and denial
 * operands. Domain restrictions can disable both branches by throwing. */
async function prepare(
  dependencies: ContentReadDependencies,
  row: Row,
  context: ReadContext,
  evidence: object,
  tombstone = false,
): Promise<AccessCheck> {
  const action = `${row.kind}:read`;
  const resource = { route: route(row.id), id: row.id };
  return accessCheck(
    dependencies.access,
    context.actor,
    action,
    {
      ...resource,
      eligibility: createResourcePublicEligibility({
        resource,
        action,
        async prepare() {
          return evidence;
        },
        async verify({ client }) {
          const current = await point(client, row.kind, row.id, row.thread_id ?? row.id);
          if (!current || signature(current) !== signature(row) || !admissible(current, context, tombstone))
            throw new ContentNotFoundError();
          return !tombstone && current.visibility === 'published' && current.availability === 'available';
        },
      }),
    },
    { pool: dependencies.pool, deadline: context.deadline },
  );
}

export async function readBoard(
  dependencies: ContentReadDependencies,
  boardId: BoardId,
  context: ReadContext,
): Promise<Anchored<BoardView | null>> {
  const observed = await snapshot(dependencies, boardId, context, (client) => point(client, 'board', boardId));
  const row = observed.value;
  const check = row ? await prepare(dependencies, row, context, observed) : null;
  return snapshot(dependencies, boardId, context, async (client) => {
    const current = await point(client, 'board', boardId);
    if (
      !row ||
      !current ||
      signature(row) !== signature(current) ||
      !admissible(current, context, false) ||
      !check ||
      !(await check(client))
    )
      return null;
    return {
      id: current.id,
      route: route(boardId),
      title: current.title,
      visibility: current.visibility,
      securityRevision: current.security_revision,
      availability: current.availability,
      createdAt: current.created_at.toISOString(),
    };
  });
}

async function disclose(
  dependencies: ContentReadDependencies,
  threadId: string,
  context: ReadContext,
  postId?: string,
  revisionId?: string,
  threadDetail = false,
): Promise<Anchored<ItemView | ThreadView | null>> {
  const observed = await snapshot(dependencies, threadId, context, async (client) => {
    if (threadDetail) {
      const thread = await point(client, 'thread', threadId);
      return thread?.first_post_id ? chain(client, threadId, thread.first_post_id) : null;
    }
    return chain(client, threadId, postId, revisionId);
  });
  const initial = observed.value;
  const board = initial?.thread.board_id ? await readBoard(dependencies, initial.thread.board_id, context) : null;
  const erased =
    !!initial && (initial.posts[0]?.availability === 'erased' || initial.revision?.availability === 'erased');
  const rows = initial ? [initial.thread, ...initial.posts] : [];
  const checks: AccessCheck[] = [];
  if (board?.value) {
    for (const row of rows) {
      const erasureRead =
        row.availability === 'erased' || (erased && (row === initial?.posts[0] || row.visibility === 'taken_down'));
      checks.push(await prepare(dependencies, row, context, { observed, board }, erasureRead));
    }
  }
  return snapshot(dependencies, threadId, context, async (client) => {
    if (!initial || !board?.value || checks.length !== rows.length) return null;
    const current = await chain(client, threadId, initial.posts[0]?.id, revisionId);
    if (!current || fingerprint(initial) !== fingerprint(current)) return null;
    for (let index = 0; index < rows.length; index++) {
      if (
        !admissible(rows[index]!, context, erased || rows[index]!.availability === 'erased') ||
        !(await checks[index]!(client))
      )
        return null;
    }
    if (!current.revision || !current.posts[0]) return null;
    // Logical erasure suppresses retained bytes for both head and exact reads.
    // Available bytes are loaded only after every container and Access check passes.
    const revision = await point(client, 'revision', current.revision.id, threadId, !erased);
    if (!revision || revision.parent_id !== current.posts[0].id) return null;
    const item = itemView(current.posts[0], revision, erased);
    if (!item) return null;
    if (!threadDetail) return item;
    const thread = current.thread;
    return {
      id: thread.id,
      route: route(thread.id),
      authorId: thread.author_id!,
      title: erased ? null : thread.title,
      licence: item.licence,
      subjectIds: item.subjectIds,
      boardId: thread.board_id!,
      visibility: thread.visibility,
      securityRevision: thread.security_revision,
      availability: thread.availability,
      createdAt: thread.created_at.toISOString(),
      firstPost: item,
    };
  });
}

function itemView(post: Row, revision: Row, erased: boolean): ItemView | null {
  const metadata = {
    id: post.id,
    threadId: post.thread_id!,
    route: route(post.id),
    authorId: post.author_id!,
    parentId: post.parent_id,
    licence: revision.licence,
    subjectIds: revision.subject_ids,
    boardId: revision.board_id!,
    visibility: post.visibility,
    securityRevision: post.security_revision,
    createdAt: post.created_at.toISOString(),
    revisedAt: post.revised_at === null ? null : post.revised_at.toISOString(),
    mediaIds: revision.media_ids,
    revisionId: revision.id,
  };
  if (erased) return { ...metadata, removed: true, body: null, sha256: null, availability: 'erased' };
  if (revision.availability !== 'available' || !revision.body) return null;
  return {
    ...metadata,
    body: JSON.parse(revision.body.toString('utf8')),
    sha256: revision.sha256.toString('hex'),
    availability: 'available',
  };
}

/** One partition seek for the account viewer's slots. Anonymous responses omit the field. */
export async function withViewerReactions<T extends { readonly id: string }>(
  dependencies: ContentReadDependencies,
  actor: Actor,
  targets: readonly T[],
  deadline: number,
): Promise<readonly (T & { viewerReaction?: ViewerReactionKind | null })[]> {
  if (actor.kind !== 'account' || targets.length === 0) return targets;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    ids.push(target.id);
  }
  if (ids.length > 100) throw new RangeError('At most 100 viewer reaction targets');
  const home = routeOf(actor.accountId);
  if (home === null) throw new TypeError('Invalid content identity');
  const parameters = { route: home, actor_id: actor.accountId, target_ids: ids };
  // Query the compiled statement directly. run() probes schema freshness once,
  // which would add a statement on the first page and nowhere else.
  const rows = await within(deadline, () =>
    withConnection(dependencies.pool, (client) =>
      client.query<(typeof viewerReactions)['~reylo']['element']>(
        viewerReactions.sql,
        viewerReactions.params.map((name) => parameters[name as keyof typeof parameters]),
      ),
    ),
  );
  const kinds = new Map<string, ViewerReactionKind>();
  for (const row of rows.rows) {
    const targetId = row.targetId;
    const kind = row.kind;
    if (targetId === null || typeof kind !== 'string' || !reactionKinds.has(kind))
      throw new TypeError('Invalid reaction kind');
    kinds.set(targetId, kind as ViewerReactionKind);
  }
  return targets.map((target) => ({ ...target, viewerReaction: kinds.get(target.id) ?? null }));
}

export async function readThread(
  dependencies: ContentReadDependencies,
  threadId: ThreadId,
  context: ReadContext,
): Promise<Anchored<ThreadView | null>> {
  return (await disclose(dependencies, threadId, context, undefined, undefined, true)) as Anchored<ThreadView | null>;
}
export async function readPost(
  dependencies: ContentReadDependencies,
  threadId: ThreadId,
  postId: PostId,
  context: ReadContext,
  revisionId?: RevisionId,
): Promise<Anchored<ItemView | null>> {
  if (route(postId) !== route(threadId) || (revisionId && route(revisionId) !== route(threadId))) {
    return snapshot(dependencies, threadId, context, async () => null);
  }
  return (await disclose(dependencies, threadId, context, postId, revisionId)) as Anchored<ItemView | null>;
}

async function list(
  dependencies: ContentReadDependencies,
  threadId: string,
  context: ReadContext,
  cursor: string | undefined,
  limit: number,
  postId?: string,
): Promise<Page<ItemView | RevisionView>> {
  const clock = dependencies.clock ?? (() => new Date());
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Page limit must be 1 to 100');
  const root = postId
    ? await readPost(dependencies, threadId, postId, context)
    : await readThread(dependencies, threadId, context);
  if (!root.value) throw new ContentNotFoundError();
  if (postId && root.value.availability === 'erased') return { entries: [], anchor: root.anchor, nextCursor: null };
  const binding: CursorBinding = {
    operation: postId ? 'content.revisions' : 'content.posts',
    parameters: {
      threadId,
      postId: postId ?? null,
      viewer: context.actor.kind === 'account' ? context.actor.accountId : null,
    },
  };
  let after: Key | null = null;
  if (cursor !== undefined) {
    const decoded = decodeCursor(dependencies.tokens, binding, cursor, clock().getTime());
    if (
      !decoded.ok ||
      decoded.epoch !== root.anchor.epoch ||
      decoded.after.length !== 2 ||
      typeof decoded.after[0] !== 'string' ||
      typeof decoded.after[1] !== 'string'
    )
      throw new TypeError('Invalid content cursor');
    after = { at: decoded.after[0], id: decoded.after[1] };
  }
  const entries: (ItemView | RevisionView)[] = [];
  let scanned = 0;
  let more = false;
  while (scanned < 200 && entries.length < limit) {
    const remaining = Math.min(limit - entries.length, 200 - scanned);
    const selected = await snapshot(dependencies, threadId, context, (client) =>
      postId
        ? pageRevisionCandidates(client, { postId, after, limit: remaining })
        : pagePostCandidates(client, { threadId, after, limit: remaining }),
    );
    more = selected.value.nextKey !== null;
    for (const key of selected.value.candidates) {
      after = key;
      scanned++;
      const result = await readPost(dependencies, threadId, postId ?? key.id, context, postId ? key.id : undefined);
      if (!result.value) continue;
      if (postId) {
        const {
          revisionId,
          id,
          parentId: _parentId,
          visibility: _visibility,
          securityRevision: _securityRevision,
          ...value
        } = result.value;
        entries.push({ ...value, id: revisionId, itemId: id, createdAt: key.at });
      } else entries.push(result.value);
    }
    if (!more) break;
  }
  // Recheck the root after hydration; concealed and missing roots share absence.
  const final = postId
    ? await readPost(dependencies, threadId, postId, context)
    : await readThread(dependencies, threadId, context);
  if (!final.value) throw new ContentNotFoundError();
  if (postId && final.value.availability === 'erased') return { entries: [], anchor: final.anchor, nextCursor: null };
  return {
    entries,
    anchor: final.anchor,
    nextCursor:
      more && after
        ? encodeCursor(
            dependencies.tokens,
            binding,
            { epoch: final.anchor.epoch, after: [after.at, after.id] },
            clock().getTime(),
          )
        : null,
  };
}

export async function listThreadPosts(
  dependencies: ContentReadDependencies,
  threadId: ThreadId,
  context: ReadContext,
  cursor?: string,
  limit = 100,
): Promise<Page<ItemView>> {
  return (await list(dependencies, threadId, context, cursor, limit)) as Page<ItemView>;
}
export async function listPostRevisions(
  dependencies: ContentReadDependencies,
  threadId: ThreadId,
  postId: PostId,
  context: ReadContext,
  cursor?: string,
  limit = 100,
): Promise<Page<RevisionView>> {
  return (await list(dependencies, threadId, context, cursor, limit, postId)) as Page<RevisionView>;
}

export async function discloseThreads(
  dependencies: ContentReadDependencies,
  threadIds: readonly ThreadId[],
  context: ReadContext,
): Promise<readonly Anchored<ThreadView | null>[]> {
  if (threadIds.length > 200) throw new RangeError('At most 200 disclosure candidates');
  const groups = new Map<number, { id: string; index: number }[]>();
  threadIds.forEach((id, index) => {
    const partition = partitionOf(route(id));
    const group = groups.get(partition) ?? [];
    group.push({ id, index });
    groups.set(partition, group);
  });
  const results: Anchored<ThreadView | null>[] = [];
  for (const group of groups.values()) {
    for (const { id, index } of group) results[index] = await readThread(dependencies, id, context);
  }
  return results;
}
