import type { PoolClient } from 'pg';
import { CommandUnavailableError } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { feedExcerpt } from './feed-summary.ts';
import {
  ContentNotFoundError,
  readSubjectThread,
  type ContentReadDependencies,
  type ThreadView,
} from './reads.ts';
import type { ReadContext } from './model.ts';

export const REVIEW_DISCOVERY_READ_LIMIT = 100;
export const REVIEW_DISCOVERY_PAGE_LIMIT = 25;
export const REVIEW_DISCOVERY_CANDIDATE_FACTOR = 4;
export const REVIEW_DISCOVERY_MAX_PAGE_CANDIDATES = REVIEW_DISCOVERY_PAGE_LIMIT * REVIEW_DISCOVERY_CANDIDATE_FACTOR;

/** Candidate fields only. Author presentation is read from Accounts during final hydration. */
export type IndexedReview = Readonly<{
  id: string;
  subjectId: string;
  title: string | null;
  excerpt?: string;
  revisionId: string;
}>;

/** Current Content-owned fields for a Search hit; the author ID is an Accounts lookup key, not display text. */
export type ReviewDiscoverySummary = Readonly<{
  id: string;
  subjectId: string;
  authorId: string;
  title: string | null;
  excerpt?: string;
}>;

export type ReviewDiscoverySnapshot = Readonly<{
  partition: number;
  /** Exact core.partition.position from the same repeatable-read snapshot as these rows. */
  position: bigint;
  reviews: readonly IndexedReview[];
}>;

export type ReviewDiscoveryHydration = Readonly<{
  partition: number;
  position: bigint;
  reviews: readonly (ReviewDiscoverySummary & { revisionId: string })[];
}>;

export type ReviewDiscoveryPageKey = Readonly<{ route: number; id: string }>;
export type ReviewDiscoveryPage = ReviewDiscoverySnapshot & Readonly<{ next: ReviewDiscoveryPageKey | null }>;
export type ReviewDiscoveryCount = Readonly<{ partition: number; position: bigint; unavailable: true }>;

export type ReviewDiscoverySource = Readonly<{
  read(partition: number, ids: readonly string[]): Promise<ReviewDiscoverySnapshot>;
  hydrate(partition: number, ids: readonly string[]): Promise<ReviewDiscoveryHydration>;
  count(partition: number): Promise<ReviewDiscoveryCount>;
  page(partition: number, after: ReviewDiscoveryPageKey | null, limit: number): Promise<ReviewDiscoveryPage>;
}>;

export const REVIEW_DISCOVERY_BOUNDS = Object.freeze({
  readIds: REVIEW_DISCOVERY_READ_LIMIT,
  pageLimit: REVIEW_DISCOVERY_PAGE_LIMIT,
  candidatesPerResult: REVIEW_DISCOVERY_CANDIDATE_FACTOR,
  maxPageCandidates: REVIEW_DISCOVERY_MAX_PAGE_CANDIDATES,
  currentOwnerReadsPerOperation: REVIEW_DISCOVERY_MAX_PAGE_CANDIDATES,
  countCandidateReads: 0,
});

type Candidate = Readonly<{
  route: number;
  id: string;
  authorId: string;
  boardId: string;
  subjectId: string;
  realmId: string | null;
  title: string | null;
  securityRevision: string;
  firstPostId: string;
  revisionId: string;
}>;

type CandidateRow = {
  route: number;
  id: string;
  authorId: string;
  boardId: string;
  subjectId: string;
  realmId: string | null;
  title: string | null;
  securityRevision: string;
  firstPostId: string;
  revisionId: string;
};

const candidateColumns = `
  t.route, t.thread_id::text AS id, t.author_account_id::text AS "authorId",
  t.board_id::text AS "boardId", t.review_subject_id::text AS "subjectId",
  b.realm_id::text AS "realmId", t.title, t.security_revision::text AS "securityRevision",
  t.first_post_id::text AS "firstPostId", p.head_revision_id::text AS "revisionId"`;

const eligibleReviewJoins = `
  FROM content.thread t
  JOIN content.board b
    ON b.route = get_byte(uuid_send(t.board_id), 10) * 256 + get_byte(uuid_send(t.board_id), 11)
   AND b.board_id = t.board_id
  JOIN content.post p
    ON p.route = t.route AND p.thread_id = t.thread_id AND p.post_id = t.first_post_id
  WHERE t.kind = 'review' AND t.review_live AND t.availability = 'available'
    AND t.visibility = 'published' AND b.purpose = 'reviews'
    AND b.availability = 'available' AND b.visibility = 'published'
    AND p.availability = 'available' AND p.visibility = 'published'
    AND p.deleted_at IS NULL AND p.head_revision_id IS NOT NULL`;

function assertPartition(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xfff)
    throw new RangeError('Review discovery partition must be from 0 to 4095');
}

function checkedContext(makeContext: () => ReadContext): ReadContext {
  const context = makeContext();
  if (context.actor.kind !== 'anonymous') throw new TypeError('Review discovery requires anonymous eligibility');
  if (!Number.isFinite(context.deadline) || context.deadline <= Date.now())
    throw new RangeError('Review discovery requires a live read deadline');
  return context;
}

function checkedKeys(partition: number, ids: readonly string[]): string[] {
  assertPartition(partition);
  if (!Array.isArray(ids) || ids.length > REVIEW_DISCOVERY_READ_LIMIT)
    throw new RangeError(`At most ${REVIEW_DISCOVERY_READ_LIMIT} review identities`);
  const keys = [...new Set(ids)];
  for (const id of keys) {
    const route = routeOf(id);
    if (route === null || partitionOf(route) !== partition)
      throw new TypeError('Review discovery identity must route to its partition');
  }
  return keys;
}

function checkedFrontier(partition: number, after: ReviewDiscoveryPageKey | null): ReviewDiscoveryPageKey | null {
  assertPartition(partition);
  if (after === null) return null;
  const route = routeOf(after.id);
  if (route === null || route !== after.route || partitionOf(route) !== partition)
    throw new TypeError('Review discovery frontier must carry its full native route');
  return { route, id: after.id };
}

async function position(client: PoolClient, partition: number): Promise<bigint> {
  const current = await readPartition(client, partition);
  if (!current) throw new CommandUnavailableError('fenced', partition);
  if (current.writeState === 'moved')
    throw new CommandUnavailableError('moved', partition, current.movedTo ?? undefined);
  if (current.writeState !== 'active') throw new CommandUnavailableError('fenced', partition);
  return current.position;
}

function candidate(row: CandidateRow): Candidate {
  if (
    !Number.isInteger(row.route) ||
    routeOf(row.id) !== row.route ||
    !row.id ||
    !row.authorId ||
    !row.boardId ||
    !row.subjectId ||
    !row.firstPostId ||
    !row.revisionId ||
    !/^[1-9][0-9]*$/.test(row.securityRevision)
  )
    throw new TypeError('Invalid native review discovery candidate');
  return row;
}

async function byIds(client: PoolClient, partition: number, ids: readonly string[]): Promise<Candidate[]> {
  if (ids.length === 0) return [];
  const rows = await client.query<CandidateRow>(
    `SELECT ${candidateColumns} ${eligibleReviewJoins}
     AND t.route >= $1 AND t.route < $2 AND t.thread_id = ANY($3::uuid[])
     ORDER BY t.route, t.thread_id`,
    [partition * 16, (partition + 1) * 16, ids],
  );
  return rows.rows.map(candidate);
}

async function pageCandidates(
  client: PoolClient,
  partition: number,
  after: ReviewDiscoveryPageKey | null,
  limit: number,
): Promise<Candidate[]> {
  const routeFloor = partition * 16;
  const rows = await client.query<CandidateRow>(
    `SELECT ${candidateColumns} ${eligibleReviewJoins}
     AND (t.route, t.thread_id) > ($3::integer, $4::uuid)
     AND t.route >= $1 AND t.route < $2
     ORDER BY t.route, t.thread_id LIMIT $5`,
    [routeFloor, routeFloor + 16, after?.route ?? routeFloor - 1, after?.id ?? '00000000-0000-0000-0000-000000000000', limit],
  );
  return rows.rows.map(candidate);
}

async function hydrateCandidate(
  dependencies: ContentReadDependencies,
  currentContext: ReadContext,
  value: Candidate,
): Promise<(ReviewDiscoverySummary & { revisionId: string }) | null> {
  let thread: ThreadView | null;
  try {
    thread = (
      await readSubjectThread(
        dependencies,
        value.id,
        value.subjectId,
        value.realmId ?? GLOBAL_CONTEXT,
        currentContext,
      )
    ).value;
  } catch (error) {
    if (error instanceof ContentNotFoundError) return null;
    throw error;
  }
  if (
    !thread ||
    thread.id !== value.id ||
    thread.route !== value.route ||
    thread.kind !== 'review' ||
    thread.authorId !== value.authorId ||
    thread.boardId !== value.boardId ||
    thread.securityRevision !== value.securityRevision ||
    thread.title !== value.title ||
    thread.subjectIds.length !== 1 ||
    thread.subjectIds[0] !== value.subjectId
  )
    return null;
  const post = thread.firstPost;
  if (post.availability !== 'available' || !('revisionId' in post) || post.revisionId !== value.revisionId || !post.body)
    return null;
  const excerpt = feedExcerpt(post);
  return {
    id: thread.id,
    subjectId: value.subjectId,
    authorId: thread.authorId,
    title: thread.title,
    ...(excerpt === undefined ? {} : { excerpt }),
    revisionId: value.revisionId,
  };
}

function indexRecord(value: ReviewDiscoverySummary & { revisionId: string }): IndexedReview {
  return {
    id: value.id,
    subjectId: value.subjectId,
    title: value.title,
    ...(value.excerpt === undefined ? {} : { excerpt: value.excerpt }),
    revisionId: value.revisionId,
  };
}

/** Public-only producer. Search owns the document union, writer, and query integration. */
export function createReviewDiscoverySource(
  dependencies: ContentReadDependencies,
  makeAnonymousContext: () => ReadContext,
): ReviewDiscoverySource {
  async function readCurrent(partition: number, ids: readonly string[]) {
    const context = checkedContext(makeAnonymousContext);
    return withReadTransaction(
      dependencies.pool,
      async (client) => {
        const at = await position(client, partition);
        const candidates = await byIds(client, partition, ids);
        const hydrated = new Map<string, ReviewDiscoverySummary & { revisionId: string }>();
        for (const item of candidates) {
          const value = await hydrateCandidate(dependencies, context, item);
          if (value) hydrated.set(value.id, value);
        }
        return { position: at, hydrated };
      },
      context.deadline,
    );
  }

  return Object.freeze({
    async read(partition, ids) {
      const keys = checkedKeys(partition, ids);
      const { position: at, hydrated } = await readCurrent(partition, keys);
      return {
        partition,
        position: at,
        reviews: keys.flatMap((id) => {
          const item = hydrated.get(id);
          return item ? [indexRecord(item)] : [];
        }),
      };
    },
    async hydrate(partition, ids) {
      const keys = checkedKeys(partition, ids);
      const { position: at, hydrated } = await readCurrent(partition, keys);
      return { partition, position: at, reviews: keys.flatMap((id) => (hydrated.has(id) ? [hydrated.get(id)!] : [])) };
    },
    async count(partition) {
      assertPartition(partition);
      const context = checkedContext(makeAnonymousContext);
      const at = await withReadTransaction(
        dependencies.pool,
        async (client) => position(client, partition),
        context.deadline,
      );
      return { partition, position: at, unavailable: true };
    },
    async page(partition, after, limit) {
      assertPartition(partition);
      const frontier = checkedFrontier(partition, after);
      if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_DISCOVERY_PAGE_LIMIT)
        throw new RangeError(`Review discovery page limit must be from 1 to ${REVIEW_DISCOVERY_PAGE_LIMIT}`);
      const context = checkedContext(makeAnonymousContext);
      return withReadTransaction(
        dependencies.pool,
        async (client) => {
          const at = await position(client, partition);
          const candidateLimit = limit * REVIEW_DISCOVERY_CANDIDATE_FACTOR;
          const candidates = await pageCandidates(client, partition, frontier, candidateLimit + 1);
          const selected = candidates.slice(0, candidateLimit);
          const reviews: IndexedReview[] = [];
          let examined = 0;
          for (const item of selected) {
            examined += 1;
            const value = await hydrateCandidate(dependencies, context, item);
            if (value) reviews.push(indexRecord(value));
            if (reviews.length === limit) break;
          }
          const last = selected[examined - 1];
          return {
            partition,
            position: at,
            reviews,
            next: examined < candidates.length && last ? { route: last.route, id: last.id } : null,
          };
        },
        context.deadline,
      );
    },
  });
}
