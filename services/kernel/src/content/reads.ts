import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { createResourcePublicEligibility } from '../access/public-eligibility.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import {
  accessExplicitCheck,
  accessCheck,
  type Access,
  type AccessCheck,
  type AccessClient,
  type Actor,
  type Resource,
} from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { isErasedPlaceholder } from './model.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import readThreadPlace from './read-thread-place.sql';
import currentBan from '../community/ban-current.sql';
import type {
  Anchored,
  BoardId,
  BoardView,
  ErasedPlaceholder,
  ItemView as StoredItemView,
  Page,
  PostId,
  ReadContext,
  RevisionId,
  RevisionView as StoredRevisionView,
  ReviewVoteCitation,
  ThreadId,
  ThreadView as StoredThreadView,
  Visibility,
} from './model.ts';
import { REACTION_KINDS } from './events.ts';
import { pagePostCandidates } from './post-pages.ts';
import { pageRevisionCandidates } from './revision-pages.ts';
import read from './read-chain.sql';
import pageCounts from './reaction-count-page.sql';
import viewerReactions from './reaction-viewer.sql';
import pageSubjectReactionCounts from './subject-reaction-count-page.sql';

const reactionKinds: ReadonlySet<string> = new Set(REACTION_KINDS);
const subjectReactionKinds = ['like', 'love', 'laugh', 'insightful', 'sad'] as const;
/** The receipt revision for the command response currently being disclosed. */
const replayedRevision = new AsyncLocalStorage<string>();
export type RealmDisclosureScope = {
  realmId?: string | null;
  realmResource?: Resource;
  realmEvidence?: unknown;
  realmEvidencePrepared?: boolean;
  associationCheck?: Promise<boolean>;
  accessCheck?: Promise<boolean>;
};
const realmDisclosure = new AsyncLocalStorage<RealmDisclosureScope>();

/** Share one containing-Realm proof across the thread and post checks in a disclosure. */
export function currentRealmDisclosureScope(): RealmDisclosureScope | undefined {
  return realmDisclosure.getStore();
}

function withRealmDisclosureScope<T>(read: () => Promise<T>): Promise<T> {
  if (realmDisclosure.getStore()) return read();
  return realmDisclosure.run({}, read);
}

/** One exact command replay. GET reads stay outside this scope, so owner roles
 * and the public floor still cannot authorize erased metadata. */
export function withReplayedRevision<T>(revisionId: string, read: () => Promise<T>): Promise<T> {
  return replayedRevision.run(revisionId, read);
}
export type ViewerReactionKind = (typeof REACTION_KINDS)[number];

/** Erased slots retain identity without disclosing bytes or a digest of erased text. */
type ContentPayload =
  | Readonly<{ availability: 'available'; body: NonNullable<StoredItemView['body']>; sha256: string }>
  | Readonly<{ availability: 'erased'; removed: true; body: null; sha256: null }>;
export type ItemView = Omit<StoredItemView, 'availability' | 'body' | 'sha256'> & ContentPayload;
export type RevisionView = Omit<StoredRevisionView, 'availability' | 'body' | 'sha256'> & ContentPayload;
export type PostEntry = ItemView | ErasedPlaceholder;
export type ThreadView = Omit<StoredThreadView, 'firstPost'> & Readonly<{ firstPost: PostEntry }>;

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
  thread_kind: 'discussion' | 'review' | null;
  board_purpose: 'discussion' | 'reviews' | null;
  vote_citation: ReviewVoteCitation | null;
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
  sha256: Buffer | null;
  realm_id: string | null;
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
        const partitionNo = partitionOf(route(id));
        const partition = await readPartition(client, partitionNo);
        if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
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
    row.thread_kind,
    row.board_purpose,
    row.visibility,
    row.security_revision,
    row.availability,
    row.realm_id,
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

type ErasedReadProof = { explicit: boolean };

/** The shared formula alone supplies floor, grant, scope, account and denial
 * operands. Domain restrictions can disable both branches by throwing. */
async function prepare(
  dependencies: ContentReadDependencies,
  row: Row,
  context: ReadContext,
  evidence: object,
  tombstone = false,
  placeholder = false,
  erasedProof?: ErasedReadProof,
): Promise<AccessCheck> {
  const action = `${row.kind}:read`;
  const resource = { route: route(row.id), id: row.id };
  const resourceWithEligibility = {
    ...resource,
    eligibility: createResourcePublicEligibility({
      resource,
      action,
      async prepare() {
        return evidence;
      },
      async verify({ client, actor, at }) {
        const current = await point(client, row.kind, row.id, row.thread_id ?? row.id);
        if (!current || signature(current) !== signature(row) || !admissible(current, context, tombstone))
          throw new ContentNotFoundError();
        if (
          current.kind === 'board' &&
          current.realm_id &&
          current.visibility !== 'published' &&
          actor.kind === 'account'
        ) {
          // Assignment references are authenticated before disclosure. Check both
          // fixed identities, independently of the grant's subject or membership.
          const principal = actor.requestedBy?.split(':')[3];
          const accounts = new Set([actor.accountId, ...(principal ? [principal] : [])]);
          for (const accountId of accounts) {
            const parameters = { route: route(current.id), realm_id: current.realm_id, account_id: accountId, at };
            const bans = await client.query(
              currentBan.sql,
              currentBan.params.map((name) => parameters[name as keyof typeof parameters]),
            );
            if (bans.rows.length !== 0) throw new ContentNotFoundError();
          }
        }
        // Erased public slots still require the requested scope from account tokens.
        if (placeholder && context.actor.kind === 'account' && !context.actor.scopes.includes(action)) return false;
        return (
          current.visibility === 'published' && ((!tombstone && current.availability === 'available') || placeholder)
        );
      },
    }),
  };
  const accessContext = { pool: dependencies.pool, deadline: context.deadline };
  if (erasedProof) {
    const check = await accessExplicitCheck(
      dependencies.access,
      context.actor,
      action,
      resourceWithEligibility,
      accessContext,
    );
    return async (client, time) => {
      const decision = await check(client, time);
      erasedProof.explicit = decision.explicit;
      return decision.allowed;
    };
  }
  return accessCheck(dependencies.access, context.actor, action, resourceWithEligibility, accessContext);
}

async function observeBoard(
  dependencies: ContentReadDependencies,
  boardId: BoardId,
  context: ReadContext,
): Promise<{ result: Anchored<BoardView | null>; recheck: () => Promise<boolean> }> {
  const observed = await snapshot(dependencies, boardId, context, (client) => point(client, 'board', boardId));
  const row = observed.value;
  const check = row ? await prepare(dependencies, row, context, observed) : null;
  const checked = async (client: AccessClient): Promise<Row | null> => {
    const current = await point(client, 'board', boardId);
    if (!row || !current || signature(row) !== signature(current) || !admissible(current, context, false) || !check)
      return null;
    try {
      return (await check(client)) ? current : null;
    } catch (error) {
      // A hard board denial conceals this candidate, including in filtered lists.
      if (error instanceof ContentNotFoundError) return null;
      throw error;
    }
  };
  const result = await snapshot(dependencies, boardId, context, async (client): Promise<BoardView | null> => {
    const current = await checked(client);
    if (!current) return null;
    return {
      id: current.id,
      realmId: current.realm_id ?? null,
      route: route(boardId),
      title: current.title,
      purpose: current.board_purpose!,
      visibility: current.visibility,
      securityRevision: current.security_revision,
      availability: current.availability,
      createdAt: current.created_at.toISOString(),
    };
  });
  return {
    result,
    // Preserve the first row and its prepared Access check; never refresh the
    // baseline after a privacy reduction or share a proof across items.
    recheck: async () =>
      (await snapshot(dependencies, boardId, context, async (client) => !!(await checked(client)))).value,
  };
}

export async function readBoard(
  dependencies: ContentReadDependencies,
  boardId: BoardId,
  context: ReadContext,
): Promise<Anchored<BoardView | null>> {
  return (await observeBoard(dependencies, boardId, context)).result;
}

async function disclose(
  dependencies: ContentReadDependencies,
  threadId: string,
  context: ReadContext,
  postId?: string,
  revisionId?: string,
  threadDetail = false,
  replayedRevisionId?: string,
  subjectScope?: { subjectId: string; placeId: string },
): Promise<Anchored<PostEntry | ThreadView | null>> {
  const observed = await snapshot(dependencies, threadId, context, async (client) => {
    if (threadDetail) {
      const thread = await point(client, 'thread', threadId);
      return thread?.first_post_id ? chain(client, threadId, thread.first_post_id) : null;
    }
    return chain(client, threadId, postId, revisionId);
  });
  const initial = observed.value;
  const boardObservation = initial?.thread.board_id
    ? await observeBoard(dependencies, initial.thread.board_id, context)
    : null;
  const board = boardObservation?.result;
  const erased =
    !!initial && (initial.posts[0]?.availability === 'erased' || initial.revision?.availability === 'erased');
  const rows = initial ? [initial.thread, ...initial.posts] : [];
  const checks: AccessCheck[] = [];
  const erasedProof = erased ? { explicit: false } : undefined;
  if (board?.value) {
    for (const row of rows) {
      const erasureRead =
        row.availability === 'erased' || (erased && (row === initial?.posts[0] || row.visibility === 'taken_down'));
      const placeholder =
        row.kind === 'post' && row.availability === 'erased' && !(revisionId && row === initial?.posts[0]);
      checks.push(
        await prepare(
          dependencies,
          row,
          context,
          { observed, board },
          erasureRead,
          placeholder,
          row === initial?.posts[0] ? erasedProof : undefined,
        ),
      );
    }
  }
  const disclosed = await snapshot<PostEntry | ThreadView | null>(dependencies, threadId, context, async (client) => {
    if (!initial || !board?.value || checks.length !== rows.length) return null;
    const current = await chain(client, threadId, initial.posts[0]?.id, revisionId);
    if (!current || fingerprint(initial) !== fingerprint(current)) return null;
    if (subjectScope) {
      if (!current.revision?.subject_ids.includes(subjectScope.subjectId) || !current.thread.board_id) return null;
      const boardRoute = route(current.thread.board_id);
      const parameters = { route: boardRoute, id: current.thread.board_id };
      const boardPlace = await client.query<(typeof readThreadPlace)['~reylo']['element']>(
        readThreadPlace.sql,
        readThreadPlace.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      const realmId = boardPlace.rows[0]?.realm_id ?? null;
      if (boardPlace.rows.length !== 1 || (realmId ?? GLOBAL_CONTEXT) !== subjectScope.placeId) return null;
    }
    for (let index = 0; index < rows.length; index++) {
      if (
        !admissible(rows[index]!, context, erased || rows[index]!.availability === 'erased') ||
        !(await checks[index]!(client))
      )
        return null;
    }
    if (!current.revision || !current.posts[0]) return null;
    // The receipt names one exact revision. That replay is the erased-metadata
    // proof for that revision alone; taken down and every other check still deny.
    const replayAuthorizes =
      replayedRevisionId !== undefined &&
      revisionId === replayedRevisionId &&
      current.revision.id === replayedRevisionId;
    if (
      erasedProof &&
      !erasedProof.explicit &&
      ((revisionId && !replayAuthorizes) ||
        [current.thread, ...current.posts].some((row) => row.visibility === 'taken_down'))
    )
      return null;
    // Logical erasure suppresses retained bytes for both head and exact reads.
    // Available bytes are loaded only after every container and Access check passes.
    const revision = erased ? current.revision : await point(client, 'revision', current.revision.id, threadId, true);
    if (!revision || revision.parent_id !== current.posts[0].id) return null;
    const item =
      erasedProof && !erasedProof.explicit && !replayAuthorizes
        ? erasedPlaceholder(current.posts[0])
        : itemView(current.posts[0], revision, erased);
    if (!item) return null;
    if (!threadDetail) return item;
    const thread = current.thread;
    return {
      id: thread.id,
      route: route(thread.id),
      authorId: thread.author_id!,
      kind: thread.thread_kind!,
      title: erased ? null : thread.title,
      licence: revision.licence,
      subjectIds: revision.subject_ids,
      boardId: thread.board_id!,
      visibility: thread.visibility,
      securityRevision: thread.security_revision,
      availability: thread.availability,
      createdAt: thread.created_at.toISOString(),
      firstPost: item,
    };
  });
  // Release the thread connection before the independently anchored board
  // snapshot, including when the pool has only one connection. Bytes and keys
  // leave this function only after both authorities have passed their final check.
  if (disclosed.value && !(await boardObservation!.recheck())) return { ...disclosed, value: null };
  return disclosed;
}

function erasedPlaceholder(post: Row): ErasedPlaceholder {
  return {
    id: post.id,
    threadId: post.thread_id!,
    route: route(post.id),
    parentId: post.parent_id,
    removed: true,
    availability: 'erased',
    body: null,
    sha256: null,
  };
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
    voteCitation: erased ? null : revision.vote_citation,
    revisionId: revision.id,
  };
  if (erased) return { ...metadata, removed: true, body: null, sha256: null, availability: 'erased' };
  if (revision.sha256 === null) throw new Error('Live revision is missing its body digest');
  if (revision.availability !== 'available' || !revision.body) return null;
  return {
    ...metadata,
    body: JSON.parse(revision.body.toString('utf8')),
    sha256: revision.sha256.toString('hex'),
    availability: 'available',
  };
}

function isPlaceholder(target: { readonly id: string }): target is ErasedPlaceholder {
  return isErasedPlaceholder(target as PostEntry);
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
    if (isPlaceholder(target) || seen.has(target.id)) continue;
    seen.add(target.id);
    ids.push(target.id);
  }
  if (ids.length === 0) return targets;
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
  return targets.map((target) =>
    isPlaceholder(target) ? target : { ...target, viewerReaction: kinds.get(target.id) ?? null },
  );
}

export type ReactionCountFreshness = Readonly<{ epoch: number; position: string }>;
type ReactionCountMap = Partial<Record<ViewerReactionKind, number>>;
export type SubjectReactionKind = (typeof subjectReactionKinds)[number];
export type SubjectReactionCount = Readonly<{ kind: SubjectReactionKind; count: number }>;
export type SubjectReactionCounts = readonly SubjectReactionCount[];
type Counted<T> = T extends ErasedPlaceholder & { readonly revisionId?: never }
  ? T
  : T & { readonly reactions: ReactionCountMap };

/** One index seek per partition over the page's targets. Zero kinds are omitted.
 * The freshness is the oldest source watermark among the count rows actually read. */
export async function withReactionCounts<T extends { readonly id: string }>(
  dependencies: ContentReadDependencies,
  targets: readonly T[],
  deadline: number,
): Promise<{
  readonly items: readonly Counted<T>[];
  readonly reactionsAsOf: ReactionCountFreshness | null;
}> {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (isPlaceholder(target) || seen.has(target.id)) continue;
    seen.add(target.id);
    ids.push(target.id);
  }
  if (ids.length > 100) throw new RangeError('At most 100 reaction count targets');
  const groups = new Map<number, { ids: string[]; routes: number[] }>();
  for (const id of ids) {
    const home = route(id);
    const partition = partitionOf(home);
    const group = groups.get(partition) ?? { ids: [], routes: [] };
    group.ids.push(id);
    group.routes.push(home);
    groups.set(partition, group);
  }
  const sums = new Map<string, Map<ViewerReactionKind, number>>();
  let oldest: { epoch: number; position: bigint } | null = null;
  for (const [partition, group] of groups) {
    const parameters = { partition, target_ids: group.ids, routes: group.routes };
    const rows = await within(deadline, () =>
      withConnection(dependencies.pool, (client) =>
        client.query<(typeof pageCounts)['~reylo']['element']>(
          pageCounts.sql,
          pageCounts.params.map((name) => parameters[name as keyof typeof parameters]),
        ),
      ),
    );
    for (const row of rows.rows) {
      const kind = row.kind;
      if (typeof row.targetId !== 'string' || typeof kind !== 'string' || !reactionKinds.has(kind))
        throw new TypeError('Invalid reaction count');
      if (!Number.isSafeInteger(row.count) || row.count < 0) throw new TypeError('Invalid reaction count');
      if (!Number.isSafeInteger(row.sourceEpoch) || row.sourceEpoch < 1) throw new TypeError('Invalid reaction count');
      const position = BigInt(row.sourcePosition);
      if (position < 1n) throw new TypeError('Invalid reaction count');
      const counted = sums.get(row.targetId) ?? new Map<ViewerReactionKind, number>();
      const reactionKind = kind as ViewerReactionKind;
      counted.set(reactionKind, (counted.get(reactionKind) ?? 0) + row.count);
      sums.set(row.targetId, counted);
      if (
        oldest === null ||
        row.sourceEpoch < oldest.epoch ||
        (row.sourceEpoch === oldest.epoch && position < oldest.position)
      ) {
        oldest = { epoch: row.sourceEpoch, position };
      }
    }
  }
  return {
    items: targets.map((target) => {
      if (isPlaceholder(target)) return target;
      const counted = sums.get(target.id);
      const reactions: ReactionCountMap = {};
      for (const kind of REACTION_KINDS) {
        const count = counted?.get(kind) ?? 0;
        if (count > 0) reactions[kind] = count;
      }
      return { ...target, reactions };
    }) as Counted<T>[],
    reactionsAsOf: oldest === null ? null : { epoch: oldest.epoch, position: oldest.position.toString() },
  };
}

/** Read at most five relayed subject totals per id with one statement per target partition. */
export async function readSubjectReactionCounts(
  dependencies: Pick<ContentReadDependencies, 'pool'>,
  subjectIds: readonly string[],
  deadline?: number,
): Promise<Map<string, SubjectReactionCounts>> {
  if (subjectIds.length < 1 || subjectIds.length > 100)
    throw new RangeError('Subject reaction count reads require 1 to 100 ids');
  const counts = new Map<string, SubjectReactionCount[]>();
  const groups = new Map<number, { ids: string[]; routes: number[] }>();
  for (const id of subjectIds) {
    let targetRoute = routeOf(id);
    if (targetRoute === null) throw new TypeError('Invalid content identity');
    if (counts.has(id)) continue;
    counts.set(id, []);
    const partition = partitionOf(targetRoute);
    const group = groups.get(partition) ?? { ids: [], routes: [] };
    group.ids.push(id);
    group.routes.push(targetRoute);
    groups.set(partition, group);
  }

  for (const [partition, group] of groups) {
    const parameters = { partition, target_ids: group.ids, routes: group.routes };
    const read = () =>
      withConnection(dependencies.pool, (client) =>
        client.query<(typeof pageSubjectReactionCounts)['~reylo']['element']>(
          pageSubjectReactionCounts.sql,
          pageSubjectReactionCounts.params.map((name) => parameters[name as keyof typeof parameters]),
        ),
      );
    const result = deadline === undefined ? await read() : await within(deadline, read);
    for (const row of result.rows) {
      if (typeof row.targetId !== 'string' || !subjectReactionKinds.includes(row.kind as SubjectReactionKind))
        throw new TypeError('Invalid subject reaction count');
      if (!Number.isSafeInteger(row.count) || row.count < 0) throw new TypeError('Invalid subject reaction count');
      const counted = counts.get(row.targetId);
      if (!counted) throw new TypeError('Unexpected subject reaction count target');
      if (row.count > 0) counted.push({ kind: row.kind as SubjectReactionKind, count: row.count });
    }
  }
  const result = new Map<string, SubjectReactionCounts>();
  for (const [id, rows] of counts) result.set(id, rows);
  return result;
}

export async function readThread(
  dependencies: ContentReadDependencies,
  threadId: ThreadId,
  context: ReadContext,
): Promise<Anchored<ThreadView | null>> {
  return withRealmDisclosureScope(
    async () =>
      (await disclose(dependencies, threadId, context, undefined, undefined, true)) as Anchored<ThreadView | null>,
  );
}
/** Subject listings use the same final thread, post, board and Access checks as exact thread reads, then
 * confirm the current subject reference and board's current Global/Realm placement in that snapshot. */
export async function readSubjectThread(
  dependencies: ContentReadDependencies,
  threadId: ThreadId,
  subjectId: string,
  placeId: string,
  context: ReadContext,
): Promise<Anchored<ThreadView | null>> {
  return (await disclose(dependencies, threadId, context, undefined, undefined, true, undefined, {
    subjectId,
    placeId,
  })) as Anchored<ThreadView | null>;
}
export async function readPost(
  dependencies: ContentReadDependencies,
  threadId: ThreadId,
  postId: PostId,
  context: ReadContext,
  revisionId?: RevisionId,
): Promise<Anchored<PostEntry | null>> {
  // Captured before the first await so the command-response binding survives
  // later deadline hops. Absent on every ordinary read.
  const replayedRevisionId = replayedRevision.getStore();
  if (
    route(postId) !== route(threadId) ||
    (revisionId && route(revisionId) !== route(threadId)) ||
    (replayedRevisionId !== undefined && route(replayedRevisionId) !== route(threadId))
  ) {
    return snapshot(dependencies, threadId, context, async () => null);
  }
  return withRealmDisclosureScope(
    async () =>
      (await disclose(
        dependencies,
        threadId,
        context,
        postId,
        revisionId,
        false,
        replayedRevisionId,
      )) as Anchored<PostEntry | null>,
  );
}

async function list(
  dependencies: ContentReadDependencies,
  threadId: string,
  context: ReadContext,
  cursor: string | undefined,
  limit: number,
  postId?: string,
): Promise<Page<PostEntry | RevisionView>> {
  const clock = dependencies.clock ?? (() => new Date());
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Page limit must be 1 to 100');
  const root = postId
    ? await readPost(dependencies, threadId, postId, context)
    : await readThread(dependencies, threadId, context);
  if (!root.value) throw new ContentNotFoundError();
  if (postId && !('revisionId' in root.value)) return { entries: [], anchor: root.anchor, nextCursor: null };
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
  const entries: (PostEntry | RevisionView)[] = [];
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
        if (!('revisionId' in result.value)) continue;
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
  if (postId && !('revisionId' in final.value)) return { entries: [], anchor: final.anchor, nextCursor: null };
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
): Promise<Page<PostEntry>> {
  return (await list(dependencies, threadId, context, cursor, limit)) as Page<PostEntry>;
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
