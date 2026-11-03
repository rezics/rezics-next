import { Buffer } from 'node:buffer';
import type { DiscoveryReadContext } from './discovery.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';

export const REVIEW_DISCOVERY_PAGE_SIZE = 100;
export const REVIEW_DISCOVERY_BATCH_SIZE = 100;

const MAX_NATIVE_VERSION = 9_223_372_036_854_775_807n;
const MAX_REVIEW_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DESTINATION_LENGTH = 4096;

export type ReviewDiscoveryReadiness = 'ready' | 'preparing' | 'unavailable';
export type ReviewDiscoveryResult<T> =
  | { status: 'ready'; value: T }
  | { status: 'preparing' }
  | { status: 'unavailable' };

export type ReviewDiscoveryFrontier = { route: number; id: string };
export type ReviewDiscoveryCensus = { partition: number; position: bigint; count: number };

/** Content projection for one currently eligible review. It deliberately has no author vote fields. */
export type ReviewDiscoveryRecord = {
  id: string;
  route: number;
  version: bigint;
  openingRevisionId: string;
  canonicalDestination: string;
  title: string | null;
  text: string;
};

export type ReviewDiscoveryObservation =
  | ({ state: 'eligible' } & ReviewDiscoveryRecord)
  | { state: 'withdrawn' | 'deleted' | 'concealed'; id: string; route: number; version: bigint };

export type ReviewDiscoveryPage = {
  partition: number;
  position: bigint;
  reviews: readonly ReviewDiscoveryRecord[];
  next: ReviewDiscoveryFrontier | null;
};

export type ReviewDiscoverySnapshot = {
  partition: number;
  position: bigint;
  observations: readonly ReviewDiscoveryObservation[];
};

/** Intermediate document for the shared mixed-discovery serializer. Identity is always the Content thread ID. */
export type ReviewDiscoveryDocument = {
  identity: string;
  owner: 'content';
  kind: 'review';
  id: string;
  route: number;
  partition: number;
  source_position: string;
  version: string;
  opening_revision_id: string;
  canonical_destination: string;
  title: string | null;
  text: string;
};

export type ReviewDiscoverySummary = {
  kind: 'review';
  id: string;
  route: number;
  openingRevisionId: string;
  canonicalDestination: string;
  title: string | null;
  text: string;
};

/** Minimal named Content seam. The native producer owns eligibility, lifecycle, ordering and current disclosure. */
export interface ContentReviewDiscoverySource {
  readiness(): Promise<ReviewDiscoveryReadiness>;
  count(partition: number): Promise<ReviewDiscoveryCensus>;
  page(
    partition: number,
    after: ReviewDiscoveryFrontier | null,
    limit: number,
    atPosition: bigint,
  ): Promise<ReviewDiscoveryPage>;
  read(partition: number, ids: readonly string[], atLeast: bigint): Promise<ReviewDiscoverySnapshot>;
  summaries(
    partition: number,
    ids: readonly string[],
    context: DiscoveryReadContext,
  ): Promise<readonly ReviewDiscoveryRecord[]>;
}

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
  if (
    typeof value !== 'bigint' ||
    value < minimum ||
    value < 0n ||
    value > MAX_NATIVE_VERSION
  )
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

function compare(a: ReviewDiscoveryFrontier, b: ReviewDiscoveryFrontier): number {
  return a.route - b.route || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_REVIEW_TEXT_BYTES;
}

function destination(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DESTINATION_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function record(value: unknown, partition: number): ReviewDiscoveryRecord {
  if (
    !object(value) ||
    !exactKeys(value, ['id', 'route', 'version', 'openingRevisionId', 'canonicalDestination', 'title', 'text']) ||
    typeof value.id !== 'string' ||
    typeof value.route !== 'number' ||
    routeOf(value.id) !== value.route ||
    partitionOf(value.route) !== partition ||
    typeof value.version !== 'bigint' ||
    value.version < 1n ||
    value.version > MAX_NATIVE_VERSION ||
    typeof value.openingRevisionId !== 'string' ||
    value.openingRevisionId.length === 0 ||
    value.openingRevisionId.length > 128 ||
    !destination(value.canonicalDestination) ||
    (value.title !== null && typeof value.title !== 'string') ||
    !text(value.text)
  )
    throw new TypeError('Invalid native review discovery row');
  return {
    id: value.id,
    route: value.route,
    version: value.version,
    openingRevisionId: value.openingRevisionId,
    canonicalDestination: value.canonicalDestination,
    title: value.title,
    text: value.text,
  };
}

function census(value: unknown, partition: number): ReviewDiscoveryCensus {
  if (
    !object(value) ||
    !exactKeys(value, ['partition', 'position', 'count']) ||
    value.partition !== partition ||
    !Number.isSafeInteger(value.count) ||
    (value.count as number) < 0
  )
    throw new TypeError('Invalid review discovery census');
  position(value.position);
  if (value.count !== 0 && value.position === 0n)
    throw new TypeError('A nonempty review population requires a native position');
  return { partition, position: value.position, count: value.count as number };
}

function observation(value: unknown, partition: number): ReviewDiscoveryObservation {
  if (!object(value) || typeof value.state !== 'string') throw new TypeError('Invalid review discovery observation');
  if (value.state === 'eligible') return { state: 'eligible', ...recordWithoutState(value, partition) };
  if (
    !['withdrawn', 'deleted', 'concealed'].includes(value.state) ||
    !exactKeys(value, ['state', 'id', 'route', 'version']) ||
    typeof value.id !== 'string' ||
    typeof value.route !== 'number' ||
    routeOf(value.id) !== value.route ||
    partitionOf(value.route) !== partition ||
    typeof value.version !== 'bigint' ||
    value.version < 1n ||
    value.version > MAX_NATIVE_VERSION
  )
    throw new TypeError('Invalid review discovery lifecycle observation');
  return { state: value.state as 'withdrawn' | 'deleted' | 'concealed', id: value.id, route: value.route, version: value.version };
}

function recordWithoutState(value: Record<string, unknown>, partition: number): ReviewDiscoveryRecord {
  const { state: _state, ...row } = value;
  return record(row, partition);
}

function sameRecord(a: ReviewDiscoveryRecord, b: ReviewDiscoveryRecord): boolean {
  return (
    a.id === b.id &&
    a.route === b.route &&
    a.version === b.version &&
    a.openingRevisionId === b.openingRevisionId &&
    a.canonicalDestination === b.canonicalDestination &&
    a.title === b.title &&
    a.text === b.text
  );
}

export function reviewDiscoveryDocument(
  partition: number,
  sourcePosition: bigint,
  row: ReviewDiscoveryRecord,
): ReviewDiscoveryDocument {
  partitionNumber(partition);
  position(sourcePosition);
  const admitted = record(row, partition);
  return {
    identity: `content:review:${admitted.id}`,
    owner: 'content',
    kind: 'review',
    id: admitted.id,
    route: admitted.route,
    partition,
    source_position: sourcePosition.toString(),
    version: admitted.version.toString(),
    opening_revision_id: admitted.openingRevisionId,
    canonical_destination: admitted.canonicalDestination,
    title: admitted.title,
    text: admitted.text,
  };
}

function validateDocument(value: unknown): ReviewDiscoveryDocument {
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
      'canonical_destination',
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
    !/^[1-9][0-9]{0,18}$/u.test(value.version) ||
    typeof value.opening_revision_id !== 'string' ||
    !destination(value.canonical_destination) ||
    (value.title !== null && typeof value.title !== 'string') ||
    !text(value.text)
  )
    throw new TypeError('Invalid review discovery document');
  const sourcePosition = BigInt(value.source_position);
  const version = BigInt(value.version);
  if (sourcePosition > MAX_NATIVE_VERSION || version > MAX_NATIVE_VERSION)
    throw new TypeError('Review discovery document exceeds its native version domain');
  return value as ReviewDiscoveryDocument;
}

function readiness(value: unknown): ReviewDiscoveryReadiness {
  if (value !== 'ready' && value !== 'preparing' && value !== 'unavailable')
    throw new TypeError('Invalid Content review discovery readiness');
  return value;
}

/** Leaf adapter only; shared mixed registry and generation wiring remain with their owner. */
export function createReviewDiscoveryAdapter(source?: ContentReviewDiscoverySource) {
  async function state(): Promise<ReviewDiscoveryReadiness> {
    return source ? readiness(await source.readiness()) : 'unavailable';
  }

  return {
    readiness: state,

    async count(partition: number): Promise<ReviewDiscoveryResult<ReviewDiscoveryCensus>> {
      partitionNumber(partition);
      const ready = await state();
      if (ready !== 'ready') return { status: ready };
      return { status: 'ready', value: census(await source!.count(partition), partition) };
    },

    async page(
      partition: number,
      after: ReviewDiscoveryFrontier | null,
      limit: number,
      snapshot: ReviewDiscoveryCensus,
      consumed: number,
    ): Promise<ReviewDiscoveryResult<{ position: bigint; documents: readonly ReviewDiscoveryDocument[]; next: ReviewDiscoveryFrontier | null; consumed: number }>> {
      partitionNumber(partition);
      const expected = census(snapshot, partition);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > REVIEW_DISCOVERY_PAGE_SIZE ||
        !Number.isSafeInteger(consumed) ||
        consumed < 0 ||
        consumed > expected.count ||
        (consumed === 0) !== (after === null)
      )
        throw new RangeError('Invalid review population page request');
      const previous = after === null ? null : key(after, partition);
      const remaining = expected.count - consumed;
      if (remaining === 0)
        return { status: 'ready', value: { position: expected.position, documents: [], next: null, consumed } };
      const ready = await state();
      if (ready !== 'ready') return { status: ready };
      const value = await source!.page(partition, previous, limit, expected.position);
      if (
        !object(value) ||
        !exactKeys(value, ['partition', 'position', 'reviews', 'next']) ||
        value.partition !== partition ||
        !Array.isArray(value.reviews) ||
        value.reviews.length > limit
      )
        throw new TypeError('Invalid native review discovery page');
      position(value.position, expected.position);
      if (value.position !== expected.position) throw new TypeError('Review page changed its census position');
      const reviews = value.reviews.map((row) => record(row, partition));
      let prior = previous;
      const seen = new Set<string>();
      for (const row of reviews) {
        const current = key({ route: row.route, id: row.id }, partition);
        if ((prior !== null && compare(prior, current) >= 0) || seen.has(row.id))
          throw new TypeError('Review page keys must be unique and advance in native order');
        prior = current;
        seen.add(row.id);
      }
      const next = value.next === null ? null : key(value.next, partition);
      const expectedLength = Math.min(limit, remaining);
      if (reviews.length !== expectedLength)
        throw new TypeError('Review page is incomplete for its retained population position');
      if (next !== null && (remaining <= limit || prior === null || compare(prior, next) !== 0))
        throw new TypeError('Review continuation must identify the last full-page key');
      if (next === null && remaining > limit)
        throw new TypeError('Review page omitted a required continuation');
      const documents = reviews.map((row) => reviewDiscoveryDocument(partition, expected.position, row));
      return {
        status: 'ready',
        value: { position: expected.position, documents, next, consumed: consumed + reviews.length },
      };
    },

    async currentSummaries(
      documents: readonly ReviewDiscoveryDocument[],
      context: DiscoveryReadContext,
    ): Promise<ReviewDiscoveryResult<ReadonlyMap<string, ReviewDiscoverySummary>>> {
      if (!Array.isArray(documents) || documents.length > 160)
        throw new RangeError('Review currentness accepts at most 160 documents');
      const saved = documents.map(validateDocument);
      const identities = new Set<string>();
      for (const row of saved) {
        if (identities.has(row.identity)) throw new TypeError('Duplicate review discovery identity');
        identities.add(row.identity);
      }
      const ready = await state();
      if (ready !== 'ready') return { status: ready };
      const current = new Map<string, ReviewDiscoveryRecord>();
      for (let offset = 0; offset < saved.length; offset += REVIEW_DISCOVERY_BATCH_SIZE) {
        const chunk = saved.slice(offset, offset + REVIEW_DISCOVERY_BATCH_SIZE);
        for (const partition of new Set(chunk.map((row) => row.partition))) {
          const owned = chunk.filter((row) => row.partition === partition);
          const ids = owned.map((row) => row.id);
          const atLeast = owned.reduce((max, row) => {
            const observed = BigInt(row.source_position);
            return observed > max ? observed : max;
          }, 0n);
          const snapshot = await source!.read(partition, ids, atLeast);
          const admitted = validateReviewSnapshot(snapshot, partition, ids, atLeast);
          const observations = new Map(admitted.observations.map((row) => [row.id, row]));
          for (const indexed of owned) {
            const observed = observations.get(indexed.id);
            if (!observed || observed.state !== 'eligible') continue;
            if (observed.version.toString() !== indexed.version) continue;
            const fromIndex = documentRecord(indexed);
            if (!sameRecord(observed, fromIndex))
              throw new TypeError('Review content changed without advancing its native revision');
            current.set(indexed.identity, observed);
          }
        }
      }
      const result = new Map<string, ReviewDiscoverySummary>();
      const currentRows = [...current.entries()];
      for (const partition of new Set(currentRows.map(([, row]) => partitionOf(row.route)))) {
        const partitionRows = currentRows.filter(([, row]) => partitionOf(row.route) === partition);
        for (let offset = 0; offset < partitionRows.length; offset += REVIEW_DISCOVERY_BATCH_SIZE) {
          const chunk = partitionRows.slice(offset, offset + REVIEW_DISCOVERY_BATCH_SIZE);
          const summaries = await source!.summaries(partition, chunk.map(([, row]) => row.id), context);
          if (!Array.isArray(summaries) || summaries.length > chunk.length)
            throw new TypeError('Invalid current review summary batch');
          const expected = new Map(chunk.map(([identity, row]) => [row.id, { identity, row }]));
          const seen = new Set<string>();
          for (const raw of summaries) {
            const id = object(raw) ? raw.id : undefined;
            const selected = typeof id === 'string' ? expected.get(id) : undefined;
            if (!selected || seen.has(id as string)) throw new TypeError('Review summary returned a wrong or duplicate key');
            const summary = record(raw, partition);
            seen.add(summary.id);
            if (!sameRecord(summary, selected.row)) continue;
            result.set(selected.identity, {
              kind: 'review',
              id: summary.id,
              route: summary.route,
              openingRevisionId: summary.openingRevisionId,
              canonicalDestination: summary.canonicalDestination,
              title: summary.title,
              text: summary.text,
            });
          }
        }
      }
      return { status: 'ready', value: result };
    },
  };
}

function documentRecord(value: ReviewDiscoveryDocument): ReviewDiscoveryRecord {
  return {
    id: value.id,
    route: value.route,
    version: BigInt(value.version),
    openingRevisionId: value.opening_revision_id,
    canonicalDestination: value.canonical_destination,
    title: value.title,
    text: value.text,
  };
}

function validateReviewSnapshot(
  value: unknown,
  partition: number,
  ids: readonly string[],
  atLeast: bigint,
): ReviewDiscoverySnapshot {
  const requested = new Set(ids);
  if (
    !object(value) ||
    !exactKeys(value, ['partition', 'position', 'observations']) ||
    value.partition !== partition ||
    !Array.isArray(value.observations) ||
    value.observations.length !== requested.size
  )
    throw new TypeError('Review current read must cover each requested key exactly once');
  position(value.position, atLeast);
  const seen = new Set<string>();
  const observations = value.observations.map((row) => observation(row, partition));
  for (const row of observations) {
    if (!requested.has(row.id) || seen.has(row.id)) throw new TypeError('Review current read returned a wrong key');
    seen.add(row.id);
  }
  return { partition, position: value.position, observations };
}
