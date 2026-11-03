import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { FilterDocument } from '@rezics/filter';
import type { CalendarPhysicalIdentity } from './release-search-calendar.ts';

/** Complete current Global evidence, after the owner has checked each target and its canonical work. */
export type CurrentWorkLinkValue = { kind: 'work'; id: string } | { kind: 'none' | 'unknown' | 'unavailable' };
export type ReleaseWorkLink =
  | { kind: 'linked'; work: string }
  | { kind: 'missing' | 'unknown' | 'conflicting' | 'unavailable' | 'unproven' };

/** A sampled relation preview cannot establish ownership, including when it contains just one work. */
export function releaseWorkLink(complete: boolean, values: readonly CurrentWorkLinkValue[]): ReleaseWorkLink {
  if (!complete) return { kind: 'unproven' };
  // Do not expose identities, cardinality or disagreements involving a concealed target.
  if (values.some(({ kind }) => kind === 'unavailable')) return { kind: 'unavailable' };
  const works = new Set(values.flatMap((value) => (value.kind === 'work' ? [value.id] : [])));
  if (works.size > 1 || (works.size > 0 && values.some(({ kind }) => kind === 'none'))) return { kind: 'conflicting' };
  if (values.some(({ kind }) => kind === 'unknown')) return { kind: 'unknown' };
  return works.size ? { kind: 'linked', work: [...works][0]! } : { kind: 'missing' };
}

export type ReleaseGroupingRequest = Readonly<{
  releaseDigest: string;
  /** Already admitted through buildReleaseSearchFilter and the active released catalogue. */
  filter: FilterDocument;
  text?: string;
  sort: 'name' | 'relevance';
  languages: readonly string[];
  spoilerThreshold: 0 | 1 | 2;
  groupLimit: number;
  childLimit: number;
  previewLimit: number;
}>;

export type ReleaseGroupingBasis = Readonly<{
  releaseDigest: string;
  physical: CalendarPhysicalIdentity;
  /** Includes disclosure, canonical redirects, dates, credits and grouping/order changes in every source pool. */
  epoch: string;
  /** Ready population evidence for this physical identity, never mapping compatibility alone. */
  calendarReadyFor: CalendarPhysicalIdentity | null;
}>;

type GroupCandidate = { kind: 'work' | 'release'; id: string };
type NativePage<Key> = { keys: Key[]; after: string; exhausted: boolean };

/** Minimal native seam. No implementation may derive these streams from finite hit/fact previews.
 * The group stream has distinct canonical works and individually ungroupable releases, in request order.
 * Both streams seek all required pools, accept at most `size` keys, and prove EOF explicitly.
 * Hydration omits invisible/nonmatching keys and checks current facts against the entire request,
 * including same-statement qualifiers, dates and producers. Cards include only the existing current
 * viewer state and permitted actions. Every method must honor the invocation's native work reservation;
 * the logical counters below are not measurements or substitutes for native accounting.
 */
export interface ReleaseGroupingSource<Work, Release> {
  observe(): Promise<ReleaseGroupingBasis>;
  groups(request: ReleaseGroupingRequest, after: string | null, size: number): Promise<NativePage<GroupCandidate>>;
  children(
    request: ReleaseGroupingRequest,
    work: string,
    after: string | null,
    size: number,
  ): Promise<NativePage<string>>;
  works(request: ReleaseGroupingRequest, ids: readonly string[]): Promise<ReadonlyMap<string, Work>>;
  releases(
    request: ReleaseGroupingRequest,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, { card: Release; link: ReleaseWorkLink }>>;
}

/** Private continuation payloads. HTTP integration must authenticate and encrypt them, bind the viewer,
 * and enforce expiry before calling this reader. They must never be serialized as public JSON cursors.
 */
type Continuation = { version: 1; binding: string; basis: ReleaseGroupingBasis; after: string | null };
export type ReleaseChildContinuation = Continuation & { work: string };
export type ReleaseGroupContinuation = Continuation & {
  pending?: { id: string; after: string | null };
};
export type ReleaseGroup<Work, Release> =
  | { kind: 'work'; id: string; work: Work; releases: Release[]; next: ReleaseChildContinuation | null }
  | { kind: 'release'; id: string; release: Release; workLink: Exclude<ReleaseWorkLink['kind'], 'linked'> };

export class ReleaseGroupingUnavailable extends Error {
  constructor() {
    super('Release grouping source is unavailable');
  }
}
export class ReleaseGroupingRestartRequired extends Error {
  constructor() {
    super('search_restart_required');
  }
}

export const RELEASE_GROUPING_LIMITS = Object.freeze({ groups: 20, children: 20, preview: 3, keys: 256, seeks: 64 });
type Usage = { keys: number; seeks: number };
type Window<Value, Cursor> = {
  status: 'ready' | 'preparing';
  values: Value[];
  next: Cursor | null;
  usage: Usage;
};

function digest(value: unknown): string {
  const json = canonicalize(value);
  if (json === undefined) throw new ReleaseGroupingUnavailable();
  return createHash('sha256').update(json).digest('hex');
}

function precise(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(precise);
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  return (node.type === 'time' && ('gte' in node || 'lte' in node)) || Object.values(node).some(precise);
}

function requestCopy(request: ReleaseGroupingRequest): ReleaseGroupingRequest {
  const copy = structuredClone(request);
  for (const [key, max] of [
    ['groupLimit', RELEASE_GROUPING_LIMITS.groups],
    ['childLimit', RELEASE_GROUPING_LIMITS.children],
    ['previewLimit', RELEASE_GROUPING_LIMITS.preview],
  ] as const)
    if (!Number.isInteger(copy[key]) || copy[key] < 1 || copy[key] > max) throw new TypeError(`Invalid ${key}`);
  return copy;
}

function usable(request: ReleaseGroupingRequest, basis: ReleaseGroupingBasis): boolean {
  return (
    basis.releaseDigest === request.releaseDigest &&
    basis.epoch.length > 0 &&
    Number.isSafeInteger(basis.physical.generation) &&
    basis.physical.generation > 0 &&
    basis.physical.indexUuid.length > 0 &&
    basis.physical.incarnation.length > 0 &&
    (!precise(request.filter) || digest(basis.physical) === digest(basis.calendarReadyFor))
  );
}

function assertCurrent(before: ReleaseGroupingBasis, after: ReleaseGroupingBasis): void {
  if (digest(before) !== digest(after)) throw new ReleaseGroupingRestartRequired();
}

class Budget {
  usage: Usage = { keys: 0, seeks: 0 };
  // Keep one seek for the final observation. Hydration and native scans each reserve their own seek.
  fits(seeks: number): boolean {
    return this.usage.seeks + seeks < RELEASE_GROUPING_LIMITS.seeks && this.usage.keys < RELEASE_GROUPING_LIMITS.keys;
  }
  size(limit: number): number {
    return Math.min(limit, RELEASE_GROUPING_LIMITS.keys - this.usage.keys);
  }
  async call<T>(read: () => Promise<T>): Promise<T> {
    if (this.usage.seeks >= RELEASE_GROUPING_LIMITS.seeks) throw new ReleaseGroupingUnavailable();
    this.usage.seeks++;
    return await read();
  }
  page<Key>(page: NativePage<Key>, size: number, previous: string | null): void {
    if (
      !Array.isArray(page.keys) ||
      page.keys.length > size ||
      typeof page.after !== 'string' ||
      page.after.length === 0 ||
      typeof page.exhausted !== 'boolean' ||
      (!page.exhausted && page.after === previous)
    )
      throw new ReleaseGroupingUnavailable();
    this.usage.keys += page.keys.length;
  }
}

function checkedMap<Value>(values: ReadonlyMap<string, Value>, ids: readonly string[]): void {
  if ([...values.keys()].some((id) => !ids.includes(id))) throw new ReleaseGroupingUnavailable();
}

async function begin<Work, Release>(
  source: ReleaseGroupingSource<Work, Release>,
  request: ReleaseGroupingRequest,
  cursor: Continuation | undefined,
  budget: Budget,
): Promise<{ basis: ReleaseGroupingBasis; binding: string }> {
  const binding = digest(request);
  const basis = structuredClone(await budget.call(() => source.observe()));
  if (cursor) {
    if (cursor.version !== 1 || cursor.binding !== binding) throw new ReleaseGroupingRestartRequired();
    assertCurrent(cursor.basis, basis);
  }
  if (!usable(request, basis)) {
    if (cursor) throw new ReleaseGroupingRestartRequired();
    throw new ReleaseGroupingUnavailable();
  }
  return { basis, binding };
}

async function children<Work, Release>(
  source: ReleaseGroupingSource<Work, Release>,
  request: ReleaseGroupingRequest,
  work: string,
  after: string | null,
  limit: number,
  budget: Budget,
): Promise<{ values: Release[]; after: string | null; exhausted: boolean }> {
  const values: Release[] = [];
  let exhausted = false;
  const seen = new Set<string>();
  while (values.length < limit && budget.fits(2)) {
    // No discarded lookahead: the child continuation starts after the last examined key.
    const size = budget.size(limit - values.length);
    const page = await budget.call(() => source.children(request, work, after, size));
    budget.page(page, size, after);
    if (
      new Set(page.keys).size !== page.keys.length ||
      page.keys.some((id) => typeof id !== 'string' || !id || seen.has(id))
    )
      throw new ReleaseGroupingUnavailable();
    for (const id of page.keys) seen.add(id);
    const current = await budget.call(() => source.releases(request, page.keys));
    checkedMap(current, page.keys);
    for (const id of page.keys) {
      const release = current.get(id);
      if (release?.link.kind === 'linked' && release.link.work === work) values.push(release.card);
    }
    after = page.after;
    exhausted = page.exhausted;
    if (exhausted) break;
  }
  return { values, after, exhausted };
}

/** Independent child paging. Only a complete native stream can end a group. */
export async function readReleaseChildren<Work, Release>(
  source: ReleaseGroupingSource<Work, Release>,
  submitted: ReleaseGroupingRequest,
  work: string,
  continuation?: ReleaseChildContinuation,
): Promise<Window<Release, ReleaseChildContinuation>> {
  const request = requestCopy(submitted);
  const cursor = continuation && structuredClone(continuation);
  if (cursor && cursor.work !== work) throw new ReleaseGroupingRestartRequired();
  const budget = new Budget();
  const { basis, binding } = await begin(source, request, cursor, budget);
  const visible = await budget.call(() => source.works(request, [work]));
  checkedMap(visible, [work]);
  if (!visible.has(work)) throw new ReleaseGroupingRestartRequired();
  const page = await children(source, request, work, cursor?.after ?? null, request.childLimit, budget);
  await budget.call(async () => assertCurrent(basis, await source.observe()));
  return {
    status: page.values.length || page.exhausted ? 'ready' : 'preparing',
    values: page.values,
    next: page.exhausted ? null : { version: 1, binding, basis, work, after: page.after },
    usage: budget.usage,
  };
}

/** Group and child progress are independent. A high-fanout work may prepare across bounded invocations. */
export async function readReleaseGroups<Work, Release>(
  source: ReleaseGroupingSource<Work, Release>,
  submitted: ReleaseGroupingRequest,
  continuation?: ReleaseGroupContinuation,
): Promise<Window<ReleaseGroup<Work, Release>, ReleaseGroupContinuation>> {
  const request = requestCopy(submitted);
  const cursor = continuation && structuredClone(continuation);
  const budget = new Budget();
  const { basis, binding } = await begin(source, request, cursor, budget);
  const values: ReleaseGroup<Work, Release>[] = [];
  let after = cursor?.after ?? null;
  let pending = cursor?.pending;
  let exhausted = false;
  const seen = new Set<string>();
  while (values.length < request.groupLimit && budget.fits(4)) {
    let candidate: GroupCandidate;
    if (pending) candidate = { kind: 'work', id: pending.id };
    else {
      const page = await budget.call(() => source.groups(request, after, 1));
      budget.page(page, 1, after);
      after = page.after;
      exhausted = page.exhausted;
      if (!page.keys.length) {
        if (exhausted) break;
        continue;
      }
      candidate = page.keys[0]!;
    }
    if (!candidate.id || !['work', 'release'].includes(candidate.kind) || seen.has(`${candidate.kind}:${candidate.id}`))
      throw new ReleaseGroupingUnavailable();
    seen.add(`${candidate.kind}:${candidate.id}`);
    if (candidate.kind === 'work') {
      const works = await budget.call(() => source.works(request, [candidate.id]));
      checkedMap(works, [candidate.id]);
      if (works.has(candidate.id)) {
        const page = await children(
          source,
          request,
          candidate.id,
          pending?.after ?? null,
          request.previewLimit,
          budget,
        );
        if (page.values.length) {
          values.push({
            kind: 'work',
            id: candidate.id,
            work: works.get(candidate.id)!,
            releases: page.values,
            next: page.exhausted ? null : { version: 1, binding, basis, work: candidate.id, after: page.after },
          });
        } else if (!page.exhausted) {
          pending = { id: candidate.id, after: page.after };
          break;
        }
      }
    } else {
      const releases = await budget.call(() => source.releases(request, [candidate.id]));
      checkedMap(releases, [candidate.id]);
      const release = releases.get(candidate.id);
      if (release && release.link.kind !== 'linked')
        values.push({ kind: 'release', id: candidate.id, release: release.card, workLink: release.link.kind });
    }
    pending = undefined;
    if (exhausted) break;
  }
  await budget.call(async () => assertCurrent(basis, await source.observe()));
  return {
    status: values.length || (exhausted && !pending) ? 'ready' : 'preparing',
    values,
    next: exhausted && !pending ? null : { version: 1, binding, basis, after, ...(pending ? { pending } : {}) },
    usage: budget.usage,
  };
}
