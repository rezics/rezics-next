import type { PoolClient } from 'pg';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { CommandUnavailableError } from '../command/command.ts';
import { readPartition, readPartitions } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { accessCheck } from '../request/access.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { SubjectRedirectError } from '../semantic/merges.ts';
import { readSubjectReference } from '../semantic/references.ts';
import { feedExcerpt } from './feed-summary.ts';
import { ContentNotFoundError, readSubjectThread, type ContentReadDependencies, type ThreadView } from './reads.ts';
import type { ReadContext } from './model.ts';
import {
  createReviewCensus,
  REVIEW_CENSUS_PAGE_SIZE,
  type ReviewCensusCoverage,
  type ReviewCensusCut,
  type ReviewCensusEpisode,
  type ReviewCensusStep,
} from './review-census.ts';

export const REVIEW_DISCOVERY_READ_LIMIT = 100;
export const REVIEW_DISCOVERY_PAGE_LIMIT = 25;
export const REVIEW_DISCOVERY_CANDIDATE_FACTOR = 4;
export const REVIEW_DISCOVERY_MAX_PAGE_CANDIDATES = REVIEW_DISCOVERY_PAGE_LIMIT * REVIEW_DISCOVERY_CANDIDATE_FACTOR;
export const REVIEW_DISCOVERY_MAX_DEPENDENCIES = 512;
export const REVIEW_DISCOVERY_MAX_CUT_HOMES = 256;

/** Candidate fields only. Author presentation is read from Accounts during final hydration. */
export type IndexedReview = Readonly<{
  id: string;
  subjectId: string;
  title: string | null;
  excerpt?: string;
  revisionId: string;
  /** Opaque per-review currentness proof. It is not disclosure authority or a content identity. */
  sourceVersion: string;
}>;

/** Current Content-owned fields for a Search hit; the author ID is an Accounts lookup key, not display text. */
export type ReviewDiscoverySummary = Readonly<{
  id: string;
  subjectId: string;
  authorId: string;
  title: string | null;
  excerpt?: string;
  /** Opaque per-review currentness proof. It is not disclosure authority or a content identity. */
  sourceVersion: string;
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
export type ReviewDiscoveryIncompletePage = Readonly<{
  partition: number;
  position: bigint;
  incomplete: 'cut-required' | 'cut-changed';
}>;
export type ReviewDiscoveryHomeObservation = Readonly<{ partition: number; epoch: number; position: string }>;
export type ReviewDiscoveryContinuation = ReviewDiscoveryPageKey & Readonly<{ token: string }>;
export type ReviewDiscoveryPopulationPage =
  | (ReviewDiscoverySnapshot & Readonly<{ state: 'ready'; next: ReviewDiscoveryContinuation | null }>)
  | Readonly<{
      state: 'preparing' | 'changed' | 'unavailable';
      partition: number;
      position: bigint | null;
      reviews: readonly [];
      next: null;
      missing: string;
    }>;
export type ReviewDiscoveryCount = Readonly<{ partition: number; position: bigint; unavailable: true }>;

export type ReviewDiscoverySource = Readonly<{
  read(partition: number, ids: readonly string[]): Promise<ReviewDiscoverySnapshot>;
  hydrate(partition: number, ids: readonly string[]): Promise<ReviewDiscoveryHydration>;
  count(partition: number): Promise<ReviewDiscoveryCount>;
  page(
    partition: number,
    after: ReviewDiscoveryPageKey | null,
    limit: number,
    cut?: bigint,
  ): Promise<ReviewDiscoveryPage | ReviewDiscoveryIncompletePage>;
  /** Coherent native population pages; legacy `page` keys cannot carry this coverage proof. */
  pageWithCut?(
    partition: number,
    after: ReviewDiscoveryPageKey | ReviewDiscoveryContinuation | null,
    limit: number,
  ): Promise<ReviewDiscoveryPopulationPage>;
}>;

/** Additional native maintenance ports. Search's legacy Count remains compatible;
 * candidate installation does not grant it anonymous eligibility coverage. */
export type NativeReviewDiscoverySource = ReviewDiscoverySource & Readonly<{
  pageWithCut: NonNullable<ReviewDiscoverySource['pageWithCut']>;
  maintainCensus(partition: number): Promise<ReviewCensusStep>;
  censusCoverage(partition: number): Promise<ReviewCensusCoverage>;
}>;

export const REVIEW_DISCOVERY_BOUNDS = Object.freeze({
  readIds: REVIEW_DISCOVERY_READ_LIMIT,
  pageLimit: REVIEW_DISCOVERY_PAGE_LIMIT,
  candidatesPerResult: REVIEW_DISCOVERY_CANDIDATE_FACTOR,
  maxPageCandidates: REVIEW_DISCOVERY_MAX_PAGE_CANDIDATES,
  currentOwnerReadsPerCandidate: 2,
  currentOwnerReadsPerOperation: REVIEW_DISCOVERY_MAX_PAGE_CANDIDATES * 2,
  dependencyRowsPerOperation: REVIEW_DISCOVERY_MAX_DEPENDENCIES,
  continuationHomes: REVIEW_DISCOVERY_MAX_CUT_HOMES,
  countCandidateReads: 0,
});

type Candidate = Readonly<{
  route: number;
  id: string;
  authorId: string | null;
  boardId: string | null;
  subjectId: string | null;
  realmId: string | null;
  title: string | null;
  securityRevision: string;
  postSecurityRevision: string | null;
  firstPostId: string | null;
  revisionId: string | null;
  lifecycleVersion: string;
}>;

type CandidateRow = {
  route: number;
  id: string;
  authorId: string | null;
  boardId: string | null;
  subjectId: string | null;
  realmId: string | null;
  title: string | null;
  securityRevision: string;
  postSecurityRevision: string | null;
  firstPostId: string | null;
  revisionId: string | null;
  lifecycleVersion: string;
};

type HydratedReview = Omit<ReviewDiscoverySummary, 'sourceVersion'> & Readonly<{ revisionId: string }>;
type VersionedReview = ReviewDiscoverySummary & Readonly<{ revisionId: string }>;

const candidateColumns = `
  t.route, t.thread_id::text AS id, t.author_account_id::text AS "authorId",
  t.board_id::text AS "boardId", t.review_subject_id::text AS "subjectId",
  b.realm_id::text AS "realmId", t.title, t.security_revision::text AS "securityRevision",
  t.first_post_id::text AS "firstPostId", p.head_revision_id::text AS "revisionId",
  p.security_revision::text AS "postSecurityRevision",
  COALESCE(lifecycle.position, 0)::text AS "lifecycleVersion"`;

const lifecycleJoin = `
  LEFT JOIN LATERAL (
    SELECT change.position FROM content.review_discovery_change AS change
    WHERE change.route=t.route AND change.thread_id=t.thread_id
    ORDER BY change.position DESC LIMIT 1
  ) AS lifecycle ON true`;

const eligibleReviewJoins = `
  FROM content.thread t
  JOIN content.board b
    ON b.route = get_byte(uuid_send(t.board_id), 10) * 256 + get_byte(uuid_send(t.board_id), 11)
   AND b.board_id = t.board_id
  JOIN content.post p
    ON p.route = t.route AND p.thread_id = t.thread_id AND p.post_id = t.first_post_id
  ${lifecycleJoin}
  WHERE t.kind = 'review' AND t.review_live AND t.availability = 'available'
    AND t.visibility = 'published' AND b.purpose = 'reviews'
    AND b.visibility = 'published'
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
    !/^[1-9][0-9]*$/.test(row.securityRevision)
  )
    throw new TypeError('Invalid native review discovery candidate');
  if (!/^(0|[1-9][0-9]*)$/.test(row.lifecycleVersion))
    throw new TypeError('Invalid native review discovery lifecycle version');
  if (row.postSecurityRevision !== null && !/^[1-9][0-9]*$/.test(row.postSecurityRevision))
    throw new TypeError('Invalid native review discovery opening post revision');
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
    [
      routeFloor,
      routeFloor + 16,
      after?.route ?? routeFloor - 1,
      after?.id ?? '00000000-0000-0000-0000-000000000000',
      limit,
    ],
  );
  return rows.rows.map(candidate);
}

async function populationCandidates(
  client: PoolClient,
  partition: number,
  after: ReviewDiscoveryPageKey | null,
  limit: number,
): Promise<Candidate[]> {
  const routeFloor = partition * 16;
  const rows = await client.query<CandidateRow>(
    `SELECT ${candidateColumns}
     FROM content.thread t
     LEFT JOIN content.board b
       ON b.route = get_byte(uuid_send(t.board_id), 10) * 256 + get_byte(uuid_send(t.board_id), 11)
      AND b.board_id = t.board_id
     LEFT JOIN content.post p
       ON p.route = t.route AND p.thread_id = t.thread_id AND p.post_id = t.first_post_id
     ${lifecycleJoin}
     WHERE t.kind = 'review'
       AND t.route >= $1 AND t.route < $2
       AND (t.route, t.thread_id) > ($3::integer, $4::uuid)
     ORDER BY t.route, t.thread_id LIMIT $5`,
    [
      routeFloor,
      routeFloor + 16,
      after?.route ?? routeFloor - 1,
      after?.id ?? '00000000-0000-0000-0000-000000000000',
      limit,
    ],
  );
  return rows.rows.map(candidate);
}

type DependencyRow = { route: number; id: string; gateKey: string };
type DependencySet = Readonly<{ byReview: ReadonlyMap<string, readonly number[]>; homes: readonly number[] }>;

async function readDependencies(
  client: PoolClient,
  partition: number,
  ids: readonly string[],
): Promise<DependencySet | null> {
  if (ids.length === 0) return { byReview: new Map(), homes: [] };
  const result = await client.query<DependencyRow>(
    `SELECT route,thread_id::text AS id,gate_key::text AS "gateKey"
     FROM content.review_discovery_dependency
     WHERE route >= $1 AND route < $2 AND thread_id=ANY($3::uuid[])
     ORDER BY route,thread_id,gate_kind,gate_key LIMIT $4`,
    [partition * 16, (partition + 1) * 16, ids, REVIEW_DISCOVERY_MAX_DEPENDENCIES + 1],
  );
  if (result.rows.length > REVIEW_DISCOVERY_MAX_DEPENDENCIES) return null;
  const byReview = new Map<string, Set<number>>();
  const homes = new Set<number>();
  for (const row of result.rows) {
    if (routeOf(row.id) !== row.route) throw new TypeError('Invalid review discovery dependency identity');
    const gateRoute = routeOf(row.gateKey);
    if (gateRoute === null) return null;
    const home = partitionOf(gateRoute);
    homes.add(home);
    const values = byReview.get(row.id) ?? new Set<number>();
    values.add(home);
    byReview.set(row.id, values);
  }
  if (ids.some((id) => !byReview.has(id))) return null;
  return {
    byReview: new Map([...byReview].map(([id, values]) => [id, [...values].sort((a, b) => a - b)])),
    homes: [...homes].sort((a, b) => a - b),
  };
}

type HomeObservation = Readonly<{ partition: number; epoch: number; position: bigint }>;
type PopulationCut = Readonly<{ homes: readonly HomeObservation[]; frontier: bigint }>;
type CutState =
  | Readonly<{ position: bigint; cut: PopulationCut; status: 'ready' }>
  | Readonly<{ position: bigint; cut: null; status: 'preparing' | 'unavailable'; missing: string }>;

async function captureCut(client: Pick<PoolClient, 'query'>, partition: number, homes: readonly number[]): Promise<CutState> {
  const selected = [...new Set([partition, ...homes])].sort((a, b) => a - b);
  if (selected.length > REVIEW_DISCOVERY_MAX_CUT_HOMES)
    return { position: 0n, cut: null, status: 'unavailable', missing: 'dependency-home-bound' };
  const partitions = await readPartitions(client, selected);
  const byHome = new Map(partitions.map((item) => [item.partitionNo, item]));
  const root = byHome.get(partition);
  if (!root) return { position: 0n, cut: null, status: 'unavailable', missing: 'source-home' };
  if (root.writeState === 'moved' || root.writeState !== 'active')
    return { position: root.position, cut: null, status: 'unavailable', missing: 'source-home' };
  if (partitions.length !== selected.length || selected.some((home) => !byHome.has(home)))
    return { position: root.position, cut: null, status: 'unavailable', missing: 'dependency-home' };
  if (partitions.some((item) => item.writeState !== 'active'))
    return { position: root.position, cut: null, status: 'unavailable', missing: 'dependency-home' };
  const pending = await client.query<{ pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM content.review_discovery_work WHERE complete=false LIMIT 1
     ) AS pending`,
  );
  if (pending.rows[0]?.pending)
    return { position: root.position, cut: null, status: 'preparing', missing: 'lifecycle-invalidation' };
  const frontier = await client.query<{ position: string }>(
    `SELECT position::text FROM content.review_discovery_frontier WHERE route=$1`,
    [partition * 16],
  );
  return {
    position: root.position,
    cut: {
      homes: partitions
        .map((item) => ({ partition: item.partitionNo, epoch: item.epoch, position: item.position }))
        .sort((a, b) => a.partition - b.partition),
      frontier: BigInt(frontier.rows[0]?.position ?? '0'),
    },
    status: 'ready',
  };
}

function sameCut(left: PopulationCut, right: PopulationCut): boolean {
  return (
    left.frontier === right.frontier &&
    left.homes.length === right.homes.length &&
    left.homes.every((home, index) => {
      const current = right.homes[index];
      return (
        current !== undefined &&
        home.partition === current.partition &&
        home.epoch === current.epoch &&
        home.position === current.position
      );
    })
  );
}

function sourceVersion(value: Candidate, dependencyHomes: readonly number[], cut: PopulationCut): string {
  const selected = new Set([partitionOf(value.route), ...dependencyHomes]);
  const state = {
    id: value.id,
    revisionId: value.revisionId,
    securityRevision: value.securityRevision,
    postSecurityRevision: value.postSecurityRevision,
    lifecycleVersion: value.lifecycleVersion,
    homes: cut.homes
      .filter((home) => selected.has(home.partition))
      .map((home) => [home.partition, home.epoch, home.position.toString()]),
  };
  return `rv1_${createHash('sha256').update(JSON.stringify(state)).digest('base64url')}`;
}

function withSourceVersion<T extends object>(value: T, version: string): T & { sourceVersion: string } {
  return { ...value, sourceVersion: version };
}

type SignedCut = Readonly<{
  partition: number;
  route: number;
  id: string;
  homes: readonly ReviewDiscoveryHomeObservation[];
  frontier: string;
}>;

function signCut(cut: SignedCut, tokens: ContentReadDependencies['tokens']): string | null {
  const key = tokens.keys.get(tokens.current);
  if (!key) return null;
  const payload = Buffer.from(JSON.stringify(cut)).toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${tokens.current}.${payload}.${signature}`;
}

function verifyCut(
  token: string,
  partition: number,
  key: ReviewDiscoveryPageKey,
  tokens: ContentReadDependencies['tokens'],
): SignedCut | null {
  if (token.length > 65_536) return null;
  const [keyIdText, payload, signature, extra] = token.split('.');
  const keyId = Number(keyIdText);
  if (!keyIdText || !/^[1-9][0-9]*$/.test(keyIdText) || !payload || !signature || extra !== undefined) return null;
  const secret = tokens.keys.get(keyId);
  if (!secret) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SignedCut;
    if (
      parsed.partition !== partition ||
      parsed.route !== key.route ||
      parsed.id !== key.id ||
      !Array.isArray(parsed.homes) ||
      parsed.homes.length > REVIEW_DISCOVERY_MAX_CUT_HOMES ||
      !/^(0|[1-9][0-9]*)$/.test(parsed.frontier) ||
      parsed.homes.some(
        (home) =>
          !Number.isInteger(home.partition) ||
          home.partition < 0 ||
          home.partition > 0xfff ||
          !Number.isSafeInteger(home.epoch) ||
          home.epoch < 1 ||
          !/^(0|[1-9][0-9]*)$/.test(home.position),
      )
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function failedPopulationPage(
  partition: number,
  state: 'preparing' | 'changed' | 'unavailable',
  missing: string,
  position: bigint | null = null,
): ReviewDiscoveryPopulationPage {
  return { state, partition, position, reviews: [], next: null, missing };
}

async function hydrateCandidate(
  dependencies: ContentReadDependencies,
  currentContext: ReadContext,
  value: Candidate,
): Promise<HydratedReview | null> {
  if (
    !value.subjectId ||
    !value.authorId ||
    !value.boardId ||
    !value.firstPostId ||
    !value.revisionId ||
    !value.postSecurityRevision
  )
    return null;
  let thread: ThreadView | null;
  try {
    thread = (
      await readSubjectThread(dependencies, value.id, value.subjectId, value.realmId ?? GLOBAL_CONTEXT, currentContext)
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
  const subjectRoute = routeOf(value.subjectId);
  if (subjectRoute === null) return null;
  const subjectResource = {
    route: subjectRoute,
    id: value.subjectId,
    eligibility: subjectReadEligibility({ route: subjectRoute, id: value.subjectId }),
  };
  const subjectAccess = await accessCheck(dependencies.access, currentContext.actor, 'subject:read', subjectResource, {
    pool: dependencies.pool,
    deadline: currentContext.deadline,
  });
  let subject: Awaited<ReturnType<typeof readSubjectReference>>;
  try {
    subject = await withReadTransaction(
      dependencies.pool,
      () => readSubjectReference(dependencies.pool, value.subjectId!, (client) => subjectAccess(client)),
      currentContext.deadline,
    );
  } catch (error) {
    if (error instanceof SubjectRedirectError) return null;
    throw error;
  }
  if (!subject || subject.id !== value.subjectId) return null;
  const post = thread.firstPost;
  if (
    post.availability !== 'available' ||
    !('revisionId' in post) ||
    post.revisionId !== value.revisionId ||
    post.securityRevision !== value.postSecurityRevision ||
    !post.body
  )
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
  const record = {
    id: value.id,
    subjectId: value.subjectId,
    title: value.title,
    ...(value.excerpt === undefined ? {} : { excerpt: value.excerpt }),
    revisionId: value.revisionId,
  };
  return withSourceVersion(record, value.sourceVersion);
}

export class ReviewDiscoverySourceError extends Error {
  readonly code = 'review_discovery_unavailable' as const;
  constructor(
    readonly state: 'changed' | 'unavailable' | 'preparing',
    readonly missing: string,
  ) {
    super(`Review discovery ${state}: ${missing}`);
    this.name = 'ReviewDiscoverySourceError';
  }
}

function cutFromToken(value: SignedCut): PopulationCut {
  return {
    homes: value.homes.map((home) => ({ ...home, position: BigInt(home.position) })),
    frontier: BigInt(value.frontier),
  };
}

function currentSubsetMatches(previous: PopulationCut, current: PopulationCut): boolean {
  const selected = new Set(previous.homes.map((home) => home.partition));
  const subset = { homes: current.homes.filter((home) => selected.has(home.partition)), frontier: current.frontier };
  return sameCut(previous, subset);
}

function tokenObservation(cut: PopulationCut): ReviewDiscoveryHomeObservation[] {
  return cut.homes.map((home) => ({
    partition: home.partition,
    epoch: home.epoch,
    position: home.position.toString(),
  }));
}

function indexHydrated(
  value: HydratedReview,
  candidateValue: Candidate,
  depHomes: readonly number[],
  cut: PopulationCut,
): VersionedReview {
  return withSourceVersion(value, sourceVersion(candidateValue, depHomes, cut));
}

function failedSourceError(state: Exclude<CutState, { status: 'ready' }>): never {
  throw new ReviewDiscoverySourceError(state.status, state.missing ?? 'native-population');
}

/** Public-only producer. Search owns the document union, writer, and query integration. */
export function createReviewDiscoverySource(
  dependencies: ContentReadDependencies,
  makeAnonymousContext: () => ReadContext,
): NativeReviewDiscoverySource {
  async function readCurrent(partition: number, ids: readonly string[]) {
    const context = checkedContext(makeAnonymousContext);
    const native = await withReadTransaction(
      dependencies.pool,
      async (client) => {
        const at = await position(client, partition);
        const candidates = await byIds(client, partition, ids);
        const depSet = await readDependencies(
          client,
          partition,
          candidates.map((item) => item.id),
        );
        if (!depSet) return { status: 'unavailable' as const, missing: 'review-dependency-directory', position: at };
        const state = await captureCut(client, partition, depSet.homes);
        return { status: 'ready' as const, position: at, candidates, depSet, state };
      },
      context.deadline,
    );
    if (native.status === 'unavailable') throw new ReviewDiscoverySourceError('unavailable', native.missing);
    if (native.state.status !== 'ready') failedSourceError(native.state);
    const hydrated = new Map<string, VersionedReview>();
    for (const item of native.candidates) {
      const value = await hydrateCandidate(dependencies, context, item);
      if (value)
        hydrated.set(value.id, indexHydrated(value, item, native.depSet.byReview.get(item.id) ?? [], native.state.cut));
    }
    const finalState = await withReadTransaction(
      dependencies.pool,
      (client) => captureCut(client, partition, native.depSet.homes),
      context.deadline,
    );
    if (finalState.status !== 'ready') failedSourceError(finalState);
    if (!sameCut(native.state.cut, finalState.cut))
      throw new ReviewDiscoverySourceError('changed', 'eligibility-dependency');
    return { position: native.position, hydrated };
  }

  async function coherentPage(
    partition: number,
    after: ReviewDiscoveryPageKey | ReviewDiscoveryContinuation | null,
    limit: number,
    retainEpisodes = false,
    censusDeadline?: number,
  ): Promise<ReviewDiscoveryPopulationPage & { census?: { cut: ReviewCensusCut; episodes: ReviewCensusEpisode[] } }> {
    assertPartition(partition);
    if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_DISCOVERY_PAGE_LIMIT)
      throw new RangeError(`Review discovery page limit must be from 1 to ${REVIEW_DISCOVERY_PAGE_LIMIT}`);
    let frontier: ReviewDiscoveryPageKey | null = null;
    let previousCut: PopulationCut | null = null;
    if (after !== null) {
      const checked = checkedFrontier(partition, after);
      if (!checked) return failedPopulationPage(partition, 'unavailable', 'invalid-population-frontier');
      frontier = checked;
      if (!('token' in after)) return failedPopulationPage(partition, 'preparing', 'population-cut');
      const signed = verifyCut(after.token, partition, checked, dependencies.tokens);
      if (!signed) return failedPopulationPage(partition, 'unavailable', 'invalid-population-cut');
      previousCut = cutFromToken(signed);
    }
    const currentContext = checkedContext(makeAnonymousContext);
    const context = censusDeadline === undefined ? currentContext : {
      ...currentContext, deadline: Math.min(currentContext.deadline, censusDeadline),
    };
    const candidateLimit = limit * REVIEW_DISCOVERY_CANDIDATE_FACTOR;
    type NativePage =
      | Readonly<{
          state: 'ready';
          position: bigint;
          candidates: readonly Candidate[];
          selected: readonly Candidate[];
          depSet: DependencySet;
          cut: PopulationCut;
        }>
      | Readonly<{ state: 'preparing' | 'changed' | 'unavailable'; missing: string; position: bigint }>;
    const native = await withReadTransaction(
      dependencies.pool,
      async (client): Promise<NativePage> => {
        if (previousCut) {
          const before = await captureCut(
            client,
            partition,
            previousCut.homes.map((home) => home.partition),
          );
          if (before.status !== 'ready')
            return { state: before.status, missing: before.missing, position: before.position };
          if (!sameCut(previousCut, before.cut))
            return { state: 'changed' as const, missing: 'population-cut', position: before.position };
        }
        const candidates = await populationCandidates(client, partition, frontier, candidateLimit + 1);
        const selected = candidates.slice(0, candidateLimit);
        const depSet = await readDependencies(
          client,
          partition,
          selected.map((item) => item.id),
        );
        if (!depSet) return { state: 'unavailable' as const, missing: 'review-dependency-directory', position: 0n };
        const homes = [...new Set([...(previousCut?.homes.map((home) => home.partition) ?? []), ...depSet.homes])];
        if (homes.length > REVIEW_DISCOVERY_MAX_CUT_HOMES)
          return { state: 'unavailable' as const, missing: 'dependency-home-bound', position: 0n };
        const state = await captureCut(client, partition, homes);
        if (state.status !== 'ready') return { state: state.status, missing: state.missing, position: state.position };
        if (previousCut && !currentSubsetMatches(previousCut, state.cut))
          return { state: 'changed' as const, missing: 'population-cut', position: state.position };
        return { state: 'ready' as const, position: state.position, candidates, selected, depSet, cut: state.cut };
      },
      context.deadline,
    );
    if (native.state !== 'ready')
      return failedPopulationPage(partition, native.state, native.missing ?? 'native-population', native.position);
    const reviews: IndexedReview[] = [];
    const episodes: ReviewCensusEpisode[] = [];
    let examined = 0;
    for (const item of native.selected) {
      examined += 1;
      const value = await hydrateCandidate(dependencies, context, item);
      if (value) {
        reviews.push(indexRecord(indexHydrated(value, item, native.depSet.byReview.get(item.id) ?? [], native.cut)));
      }
      if (retainEpisodes) episodes.push({
        route: item.route, id: item.id, boardId: item.boardId, realmId: item.realmId,
        subjectId: item.subjectId, openingId: item.firstPostId, revisionId: item.revisionId,
        sourceVersion: sourceVersion(item, native.depSet.byReview.get(item.id) ?? [], native.cut),
        eligible: value !== null,
      });
      if (reviews.length === limit) break;
    }
    const finalState = await withReadTransaction(
      dependencies.pool,
      (client) =>
        captureCut(
          client,
          partition,
          native.cut.homes.map((home) => home.partition),
        ),
      context.deadline,
    );
    if (finalState.status !== 'ready')
      return failedPopulationPage(
        partition,
        finalState.status,
        finalState.missing ?? 'native-population',
        finalState.position,
      );
    if (!sameCut(native.cut, finalState.cut))
      return failedPopulationPage(partition, 'changed', 'eligibility-dependency', finalState.position);
    const last = native.selected[examined - 1];
    let next: ReviewDiscoveryContinuation | null = null;
    if (last && examined < native.candidates.length) {
      const key = { route: last.route, id: last.id };
      const token = signCut(
        {
          partition,
          ...key,
          homes: tokenObservation(finalState.cut),
          frontier: finalState.cut.frontier.toString(),
        },
        dependencies.tokens,
      );
      if (!token)
        return failedPopulationPage(partition, 'unavailable', 'continuation-signing-key', finalState.position);
      next = { ...key, token };
    }
    return { state: 'ready', partition, position: finalState.position, reviews, next,
      ...(retainEpisodes ? { census: {
        cut: { homes: tokenObservation(finalState.cut), frontier: finalState.cut.frontier.toString() }, episodes,
      } } : {}),
    };
  }

  const census = createReviewCensus(dependencies.pool, {
    async page(partition, after, deadline) {
      const page = await coherentPage(partition, after, REVIEW_CENSUS_PAGE_SIZE, true, deadline);
      if (page.state !== 'ready') return page;
      if (!page.census) throw new Error('Review census native observation unavailable');
      return { state: 'ready', position: page.position, cut: page.census.cut,
        episodes: page.census.episodes, next: page.next };
    },
    async observe(client, partition, cut) {
      const current = await captureCut(client, partition, cut?.homes.map((home) => home.partition) ?? []);
      if (current.status !== 'ready') return { state: current.status, position: current.position, missing: current.missing };
      return { state: 'ready', position: current.position,
        cut: { homes: tokenObservation(current.cut), frontier: current.cut.frontier.toString() } };
    },
  });

  return Object.freeze({
    async maintainCensus(partition) {
      const context = checkedContext(makeAnonymousContext);
      return census.step(partition, context.deadline);
    },
    async censusCoverage(partition) {
      const context = checkedContext(makeAnonymousContext);
      return census.coverage(partition, context.deadline);
    },
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
      return {
        partition,
        position: at,
        reviews: keys.flatMap((id) => (hydrated.has(id) ? [hydrated.get(id)!] : [])),
      };
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
    async page(partition, after, limit, cut) {
      assertPartition(partition);
      const frontier = checkedFrontier(partition, after);
      if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_DISCOVERY_PAGE_LIMIT)
        throw new RangeError(`Review discovery page limit must be from 1 to ${REVIEW_DISCOVERY_PAGE_LIMIT}`);
      if (cut !== undefined && (typeof cut !== 'bigint' || cut < 0n))
        throw new RangeError('Review discovery cut must be a native position');
      const context = checkedContext(makeAnonymousContext);
      const candidateLimit = limit * REVIEW_DISCOVERY_CANDIDATE_FACTOR;
      type NativeLegacyPage =
        | Readonly<{
            state: 'incomplete';
            position: bigint;
            incomplete: ReviewDiscoveryIncompletePage['incomplete'];
          }>
        | Readonly<{
            state: 'ready';
            position: bigint;
            candidates: readonly Candidate[];
            selected: readonly Candidate[];
            depSet: DependencySet;
            cut: PopulationCut;
          }>;
      const native = await withReadTransaction(
        dependencies.pool,
        async (client): Promise<NativeLegacyPage> => {
          const at = await position(client, partition);
          if (frontier !== null && cut === undefined)
            return { state: 'incomplete', position: at, incomplete: 'cut-required' };
          if (cut !== undefined && cut !== at) return { state: 'incomplete', position: at, incomplete: 'cut-changed' };
          const candidates = await pageCandidates(client, partition, frontier, candidateLimit + 1);
          const selected = candidates.slice(0, candidateLimit);
          const depSet = await readDependencies(
            client,
            partition,
            selected.map((item) => item.id),
          );
          if (!depSet) throw new ReviewDiscoverySourceError('unavailable', 'review-dependency-directory');
          const state = await captureCut(client, partition, depSet.homes);
          if (state.status !== 'ready') failedSourceError(state);
          return { state: 'ready', position: at, candidates, selected, depSet, cut: state.cut };
        },
        context.deadline,
      );
      if (native.state === 'incomplete') return { partition, position: native.position, incomplete: native.incomplete };
      const reviews: IndexedReview[] = [];
      let examined = 0;
      for (const item of native.selected) {
        examined += 1;
        const value = await hydrateCandidate(dependencies, context, item);
        if (value)
          reviews.push(indexRecord(indexHydrated(value, item, native.depSet.byReview.get(item.id) ?? [], native.cut)));
        if (reviews.length === limit) break;
      }
      const finalState = await withReadTransaction(
        dependencies.pool,
        (client) =>
          captureCut(
            client,
            partition,
            native.cut.homes.map((home) => home.partition),
          ),
        context.deadline,
      );
      if (finalState.status !== 'ready') failedSourceError(finalState);
      if (!sameCut(native.cut, finalState.cut))
        return { partition, position: finalState.position, incomplete: 'cut-changed' };
      const last = native.selected[examined - 1];
      return {
        partition,
        position: native.position,
        reviews,
        next: examined < native.candidates.length && last ? { route: last.route, id: last.id } : null,
      };
    },
    pageWithCut: coherentPage,
  });
}
