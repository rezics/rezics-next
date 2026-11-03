import type { ContentReadDependencies } from '../content/reads.ts';
import {
  createReviewDiscoverySource as createContentReviewDiscoverySource,
  REVIEW_DISCOVERY_PAGE_LIMIT as CONTENT_REVIEW_PAGE_LIMIT,
  REVIEW_DISCOVERY_READ_LIMIT as CONTENT_REVIEW_READ_LIMIT,
  type ReviewDiscoveryCount as NativeReviewDiscoveryCount,
  type ReviewDiscoverySource as NativeReviewDiscoverySource,
} from '../content/review-discovery.ts';
import type { ReadContext } from '../content/model.ts';
import { FEED_EXCERPT_LIMIT } from '../content/feed-summary.ts';
import type { DiscoveryOwnerMetadataSummary, DiscoveryReadContext } from './discovery.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';

export const REVIEW_DISCOVERY_PAGE_SIZE = CONTENT_REVIEW_PAGE_LIMIT;
export const REVIEW_DISCOVERY_BATCH_SIZE = CONTENT_REVIEW_READ_LIMIT;
export const REVIEW_DISCOVERY_CURRENT_LIMIT = 160;
export const REVIEW_DISCOVERY_OWNER_CURRENT_LIMIT = 200;

const MAX_NATIVE_VERSION = 9_223_372_036_854_775_807n;
const MAX_REVISION_ID_LENGTH = 128;

export type ReviewDiscoveryReadiness = 'ready' | 'preparing' | 'unavailable';
export type ReviewDiscoveryResult<T> =
  | { status: 'ready'; value: T }
  | { status: 'preparing' }
  | { status: 'unavailable' };

export type ReviewDiscoveryFrontier = { route: number; id: string };
/** Content has no exact cardinality census yet; preserve its unavailable marker. */
export type ReviewDiscoveryCensus = NativeReviewDiscoveryCount;

/** Public opening projection from Content. The excerpt cap remains Content-owned. */
export type ReviewDiscoveryRecord = {
  id: string;
  route: number;
  openingRevisionId: string;
  title: string | null;
  text: string;
};

export type ReviewDiscoveryDocument = {
  identity: string;
  owner: 'content';
  kind: 'review';
  id: string;
  route: number;
  partition: number;
  source_position: string;
  /** Exact Content partition position used for source freshness. */
  version: string;
  opening_revision_id: string;
  title: string | null;
  text: string;
};

export type ReviewDiscoverySummary = {
  kind: 'review';
  id: string;
  route: number;
  openingRevisionId: string;
  title: string | null;
  text: string;
};

/** This is Content's installed producer contract, not a Search-owned lookalike. */
export type ContentReviewDiscoverySource = NativeReviewDiscoverySource;
export type ReviewDiscoverySourceProvider = (context?: DiscoveryReadContext) => NativeReviewDiscoverySource;

type ReviewDiscoveryKey = { id: string; route: number };
type ReviewDiscoveryHydration = { partition: number; position: bigint; reviews: readonly ReviewDiscoveryRecord[] };
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function partitionNumber(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= PARTITIONS)
    throw new RangeError('Invalid review discovery partition');
}

function position(value: unknown, minimum = 0n): asserts value is bigint {
  if (typeof value !== 'bigint' || value < minimum || value > MAX_NATIVE_VERSION)
    throw new TypeError('Review discovery position must cover the native observation');
}

function key(value: unknown, partition: number): ReviewDiscoveryFrontier {
  if (
    !object(value) ||
    !exactKeys(value, ['route', 'id']) ||
    typeof value.id !== 'string' ||
    typeof value.route !== 'number' ||
    routeOf(value.id) !== value.route ||
    partitionOf(value.route) !== partition
  )
    throw new TypeError('Invalid review discovery frontier');
  return { route: value.route, id: value.id };
}

function compare(a: ReviewDiscoveryKey, b: ReviewDiscoveryKey): number {
  return a.route - b.route || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function validTitle(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.isWellFormed());
}

function validExcerpt(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === 'string' && value.isWellFormed() && [...value].length <= FEED_EXCERPT_LIMIT)
  );
}

function nativeRecord(value: unknown, partition: number): ReviewDiscoveryRecord {
  if (!object(value)) throw new TypeError('Invalid native review discovery row');
  const allowedKeys = ['id', 'subjectId', 'title', 'revisionId', 'excerpt'];
  if (
    Object.keys(value).some((field) => !allowedKeys.includes(field)) ||
    !['id', 'subjectId', 'title', 'revisionId'].every((field) => Object.hasOwn(value, field)) ||
    typeof value.id !== 'string' ||
    typeof value.subjectId !== 'string' ||
    routeOf(value.subjectId) === null ||
    typeof value.revisionId !== 'string' ||
    value.revisionId.length === 0 ||
    value.revisionId.length > MAX_REVISION_ID_LENGTH ||
    !validTitle(value.title) ||
    !validExcerpt(value.excerpt)
  )
    throw new TypeError('Invalid native review discovery row');
  const route = routeOf(value.id);
  if (route === null || partitionOf(route) !== partition)
    throw new TypeError('Review identity must route to its native partition');
  return {
    id: value.id,
    route,
    openingRevisionId: value.revisionId,
    title: value.title,
    text: value.excerpt ?? '',
  };
}

function nativeSummary(value: unknown, partition: number): ReviewDiscoveryRecord {
  if (
    !object(value) ||
    Object.keys(value).some(
      (field) => !['id', 'subjectId', 'authorId', 'title', 'excerpt', 'revisionId'].includes(field),
    ) ||
    !['id', 'subjectId', 'authorId', 'title', 'revisionId'].every((field) => Object.hasOwn(value, field)) ||
    typeof value.authorId !== 'string' ||
    routeOf(value.authorId) === null
  )
    throw new TypeError('Invalid current Content review summary');
  const row = {
    id: value.id,
    subjectId: value.subjectId,
    title: value.title,
    revisionId: value.revisionId,
    ...(Object.hasOwn(value, 'excerpt') ? { excerpt: value.excerpt } : {}),
  };
  return nativeRecord(row, partition);
}

function nativeCount(value: unknown, partition: number): ReviewDiscoveryCensus {
  if (
    !object(value) ||
    !exactKeys(value, ['partition', 'position', 'unavailable']) ||
    value.partition !== partition ||
    value.unavailable !== true
  )
    throw new TypeError('Invalid Content review discovery count');
  position(value.position);
  return { partition, position: value.position, unavailable: true };
}

function document(value: unknown): ReviewDiscoveryDocument {
  if (
    !object(value) ||
    !exactKeys(value, [
      'identity',
      'owner',
      'kind',
      'id',
      'route',
      'partition',
      'source_position',
      'version',
      'opening_revision_id',
      'title',
      'text',
    ]) ||
    value.owner !== 'content' ||
    value.kind !== 'review' ||
    typeof value.id !== 'string' ||
    typeof value.route !== 'number' ||
    routeOf(value.id) !== value.route ||
    typeof value.partition !== 'number' ||
    partitionOf(value.route) !== value.partition ||
    value.identity !== `content:review:${value.id}` ||
    typeof value.source_position !== 'string' ||
    !/^[1-9][0-9]{0,18}$/u.test(value.source_position) ||
    typeof value.version !== 'string' ||
    value.version !== value.source_position ||
    typeof value.opening_revision_id !== 'string' ||
    value.opening_revision_id.length === 0 ||
    value.opening_revision_id.length > MAX_REVISION_ID_LENGTH ||
    !validTitle(value.title) ||
    typeof value.text !== 'string' ||
    !validExcerpt(value.text)
  )
    throw new TypeError('Invalid review discovery document');
  const sourcePosition = BigInt(value.source_position);
  if (sourcePosition > MAX_NATIVE_VERSION) throw new TypeError('Review document exceeds the native position domain');
  return value as ReviewDiscoveryDocument;
}

function validReadContext(context: DiscoveryReadContext): void {
  if (!Number.isFinite(context.deadline) || context.deadline <= Date.now())
    throw new RangeError('Review discovery requires the current reader deadline');
}

function requestedIds(ids: readonly string[], limit: number): Map<number, string[]> {
  if (!Array.isArray(ids) || ids.length > limit) throw new RangeError('Review current read exceeds its native bound');
  const partitions = new Map<number, string[]>();
  const seen = new Set<string>();
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Review identity must be a routable UUID');
    const partition = partitionOf(route);
    const values = partitions.get(partition) ?? [];
    if (!seen.has(id)) values.push(id);
    seen.add(id);
    partitions.set(partition, values);
  }
  return partitions;
}

export function reviewDiscoveryDocument(
  partition: number,
  sourcePosition: bigint,
  row: ReviewDiscoveryRecord,
): ReviewDiscoveryDocument {
  partitionNumber(partition);
  position(sourcePosition, 1n);
  const route = routeOf(row.id);
  if (
    route === null ||
    route !== row.route ||
    partitionOf(route) !== partition ||
    typeof row.openingRevisionId !== 'string' ||
    row.openingRevisionId.length === 0 ||
    row.openingRevisionId.length > MAX_REVISION_ID_LENGTH ||
    !validTitle(row.title) ||
    typeof row.text !== 'string' ||
    !validExcerpt(row.text)
  )
    throw new TypeError('Invalid native review discovery row');
  return {
    identity: `content:review:${row.id}`,
    owner: 'content',
    kind: 'review',
    id: row.id,
    route,
    partition,
    source_position: sourcePosition.toString(),
    version: sourcePosition.toString(),
    opening_revision_id: row.openingRevisionId,
    title: row.title,
    text: row.text,
  };
}

function hydration(value: unknown, partition: number, ids: readonly string[]): ReviewDiscoveryHydration {
  const requested = new Set(ids);
  if (
    !object(value) ||
    !exactKeys(value, ['partition', 'position', 'reviews']) ||
    value.partition !== partition ||
    !Array.isArray(value.reviews) ||
    value.reviews.length > requested.size
  )
    throw new TypeError('Invalid current Content review hydration');
  position(value.position);
  const seen = new Set<string>();
  const reviews = value.reviews.map((raw) => {
    const row = nativeSummary(raw, partition);
    if (!requested.has(row.id) || seen.has(row.id))
      throw new TypeError('Content review hydration returned a wrong or duplicate key');
    seen.add(row.id);
    return row;
  });
  return { partition, position: value.position, reviews };
}

function sourcePosition(value: ReviewDiscoveryDocument): bigint {
  return BigInt(value.source_position);
}

/**
 * Search leaf over Content's real public review producer. Count remains unavailable; the raw native
 * continuation, including progress through sparse pages, is the only exhaustion signal.
 */
export function createReviewDiscoveryAdapter(source?: ContentReviewDiscoverySource | ReviewDiscoverySourceProvider) {
  function native(context?: DiscoveryReadContext): NativeReviewDiscoverySource | undefined {
    return typeof source === 'function' ? source(context) : source;
  }

  async function currentRows(
    ownerSource: NativeReviewDiscoverySource,
    partition: number,
    ids: readonly string[],
  ): Promise<ReviewDiscoveryHydration> {
    const raw = await ownerSource.hydrate(partition, ids);
    return hydration(raw, partition, ids);
  }

  return {
    async readiness(): Promise<ReviewDiscoveryReadiness> {
      return source ? 'ready' : 'unavailable';
    },

    async count(partition: number): Promise<ReviewDiscoveryResult<ReviewDiscoveryCensus>> {
      partitionNumber(partition);
      const ownerSource = native();
      if (!ownerSource) return { status: 'unavailable' };
      return { status: 'ready', value: nativeCount(await ownerSource.count(partition), partition) };
    },

    async page(
      partition: number,
      after: ReviewDiscoveryFrontier | null,
      limit: number,
    ): Promise<
      ReviewDiscoveryResult<{
        position: bigint;
        documents: readonly ReviewDiscoveryDocument[];
        next: ReviewDiscoveryFrontier | null;
      }>
    > {
      partitionNumber(partition);
      if (!Number.isInteger(limit) || limit < 1 || limit > REVIEW_DISCOVERY_PAGE_SIZE)
        throw new RangeError(`Review discovery page limit must be from 1 to ${REVIEW_DISCOVERY_PAGE_SIZE}`);
      const previous = after === null ? null : key(after, partition);
      const ownerSource = native();
      if (!ownerSource) return { status: 'unavailable' };
      const raw = await ownerSource.page(partition, previous, limit);
      if (
        !object(raw) ||
        !exactKeys(raw, ['partition', 'position', 'reviews', 'next']) ||
        raw.partition !== partition ||
        !Array.isArray(raw.reviews) ||
        raw.reviews.length > limit
      )
        throw new TypeError('Invalid native review discovery page');
      position(raw.position);
      const rows = raw.reviews.map((value) => nativeRecord(value, partition));
      let prior = previous;
      const seen = new Set<string>();
      for (const row of rows) {
        const current = { route: row.route, id: row.id };
        if ((prior !== null && compare(prior, current) >= 0) || seen.has(row.id))
          throw new TypeError('Review page keys must be unique and advance in native order');
        prior = current;
        seen.add(row.id);
      }
      const next = raw.next === null ? null : key(raw.next, partition);
      if (
        next !== null &&
        ((previous !== null && compare(previous, next) >= 0) || (prior !== null && compare(prior, next) > 0))
      )
        throw new TypeError('Review continuation must advance past every returned eligible key');
      return {
        status: 'ready',
        value: {
          position: raw.position,
          documents: rows.map((row) => reviewDiscoveryDocument(partition, raw.position, row)),
          next,
        },
      };
    },

    async currentSummaries(
      documents: readonly ReviewDiscoveryDocument[],
      context: DiscoveryReadContext,
    ): Promise<ReviewDiscoveryResult<ReadonlyMap<string, ReviewDiscoverySummary>>> {
      if (!Array.isArray(documents) || documents.length > REVIEW_DISCOVERY_CURRENT_LIMIT)
        throw new RangeError(`Review currentness accepts at most ${REVIEW_DISCOVERY_CURRENT_LIMIT} documents`);
      validReadContext(context);
      const saved = documents.map(document);
      const identities = new Set<string>();
      for (const row of saved) {
        if (identities.has(row.identity)) throw new TypeError('Duplicate review discovery identity');
        identities.add(row.identity);
      }
      const ownerSource = native(context);
      if (!ownerSource) return { status: 'unavailable' };
      const result = new Map<string, ReviewDiscoverySummary>();
      for (const partition of new Set(saved.map((row) => row.partition))) {
        const owned = saved.filter((row) => row.partition === partition);
        for (let offset = 0; offset < owned.length; offset += REVIEW_DISCOVERY_BATCH_SIZE) {
          const chunk = owned.slice(offset, offset + REVIEW_DISCOVERY_BATCH_SIZE);
          const current = await currentRows(
            ownerSource,
            partition,
            chunk.map((row) => row.id),
          );
          const byId = new Map(current.reviews.map((row) => [row.id, row]));
          for (const indexed of chunk) {
            const observed = byId.get(indexed.id);
            if (!observed || observed.openingRevisionId !== indexed.opening_revision_id) continue;
            if (current.position !== sourcePosition(indexed)) return { status: 'preparing' };
            result.set(indexed.identity, {
              kind: 'review',
              id: observed.id,
              route: indexed.route,
              openingRevisionId: observed.openingRevisionId,
              title: observed.title,
              text: observed.text,
            });
          }
        }
      }
      return { status: 'ready', value: result };
    },

    /** Current public metadata caller for the shared discovery registry. */
    async readCurrent(
      ids: readonly string[],
      context: DiscoveryReadContext,
    ): Promise<ReadonlyMap<string, DiscoveryOwnerMetadataSummary>> {
      if (!Array.isArray(ids) || ids.length > REVIEW_DISCOVERY_OWNER_CURRENT_LIMIT)
        throw new RangeError(`Review current reads accept at most ${REVIEW_DISCOVERY_OWNER_CURRENT_LIMIT} identities`);
      validReadContext(context);
      const groups = requestedIds(ids, REVIEW_DISCOVERY_OWNER_CURRENT_LIMIT);
      const ownerSource = native(context);
      if (!ownerSource) return new Map();
      const result = new Map<string, DiscoveryOwnerMetadataSummary>();
      for (const [partition, keys] of groups) {
        for (let offset = 0; offset < keys.length; offset += REVIEW_DISCOVERY_BATCH_SIZE) {
          const chunk = keys.slice(offset, offset + REVIEW_DISCOVERY_BATCH_SIZE);
          const current = await currentRows(ownerSource, partition, chunk);
          for (const row of current.reviews) {
            result.set(row.id, { id: row.id, title: row.title ?? '', summary: row.text || null });
          }
        }
      }
      return result;
    },
  };
}

/** Compose Search with Content's installed native factory and its public anonymous reader. */
export function createNativeReviewDiscoveryAdapter(
  dependencies: ContentReadDependencies,
  makeAnonymousContext: () => ReadContext,
) {
  const provider: ReviewDiscoverySourceProvider = (context) => {
    const base = makeAnonymousContext();
    if (base.actor.kind !== 'anonymous') throw new TypeError('Review discovery requires anonymous eligibility');
    const readContext: ReadContext = {
      ...base,
      actor: { kind: 'anonymous' },
      deadline: context?.deadline ?? base.deadline,
    };
    return createContentReviewDiscoverySource(dependencies, () => readContext);
  };
  return createReviewDiscoveryAdapter(provider);
}
