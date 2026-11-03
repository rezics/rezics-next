import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import { admittedReleaseSearchTypes, type FilterRelease } from '@rezics/filter';
import {
  observeReleaseSearchNames,
  readReleaseSearchNames,
  type ReleaseSearchNameCut,
  type ReleaseSearchNamePool,
  type ReleaseSearchNameReservation,
} from './release-search-name-stream.ts';
import {
  releaseWorkLink,
  ReleaseGroupingRestartRequired,
  ReleaseGroupingUnavailable,
  type ReleaseGroupingBasis,
  type ReleaseGroupingRequest,
  type ReleaseGroupingSource,
  type ReleaseWorkLink,
} from './release-search-grouping.ts';
import { validateRequestSourceSnapshot } from './request-source-snapshot.ts';
import { subjectPartition, type SubjectSource } from './source.ts';

export type ReleaseSearchCandidatePool = ReleaseSearchNamePool &
  Readonly<{
    source: Pick<SubjectSource, 'read' | 'readCompleteWorkLinks'>;
  }>;

/** Dispatch accounting only. The complete work-link owner has internal reads of its own.
 * Matching, card hydration, serialization and final disclosure still require native reservations.
 */
export type ReleaseSearchCandidateReservation = ReleaseSearchNameReservation &
  Readonly<{
    sourceReads: number;
    completeWorkLinkReads: number;
    completeWorkLinkOperations: number;
    authorityObservations: number;
    searchReads: number;
  }>;
type Context = Readonly<{
  deadline: number;
  reserve: (reservation: ReleaseSearchCandidateReservation) => void;
  /** Full retained authority across ALL pools, beyond canonical-name publication. */
  observe: (context: { deadline: number }) => Promise<ReleaseGroupingBasis>;
}>;
export type ReleaseSearchCandidateCut = Readonly<{
  names: ReleaseSearchNameCut;
  basis: ReleaseGroupingBasis;
}>;
type Candidate = { kind: 'work' | 'release'; id: string };
export type ReleaseSearchNativeCandidate = Readonly<{
  id: string;
  pool: string;
  partition: number;
  name: string | null;
  securityRevision: number;
  /** Opaque native search-after position immediately after this candidate. */
  after: string;
}>;
export type ReleaseSearchNativePage = Readonly<{
  keys: readonly ReleaseSearchNativeCandidate[];
  after: string;
  exhausted: boolean;
}>;
type Classified = {
  id: string;
  work: boolean;
  link?: ReleaseWorkLink;
};
type Position = {
  version: 1;
  binding: string;
  namesAfter: string | null;
  /** Re-read this name and its complete current evidence before consuming its second candidate. */
  skipWorkFor?: string;
  /** Prior work groups in native relevance order, so another release cannot repeat a group. */
  seenWorks?: string[];
};

function unavailable(): never {
  throw new ReleaseGroupingUnavailable();
}

function canonicalId(value: unknown): value is string {
  try {
    return typeof value === 'string' && value === value.toLowerCase() && subjectPartition(value) >= 0;
  } catch {
    return false;
  }
}

function nameContext(context: Context) {
  return {
    deadline: context.deadline,
    reserve: (value: ReleaseSearchNameReservation) =>
      context.reserve({
        ...value,
        sourceReads: 0,
        completeWorkLinkReads: 0,
        completeWorkLinkOperations: 0,
        authorityObservations: 0,
        searchReads: 0,
      }),
  };
}

function reserve(
  context: Context,
  pool: string,
  phase: 'sourceReads' | 'completeWorkLinkReads' | 'completeWorkLinkOperations' | 'authorityObservations' | 'searchReads',
  keys = 0,
) {
  context.reserve({
    pool,
    observations: 0,
    ownerReads: 0,
    nameSeeks: 0,
    keys,
    sourceReads: 0,
    completeWorkLinkReads: 0,
    completeWorkLinkOperations: 0,
    authorityObservations: 0,
    searchReads: 0,
    [phase]: 1,
  });
}

async function authority(pools: readonly ReleaseSearchCandidatePool[], context: Context) {
  for (const pool of pools) reserve(context, pool.id, 'authorityObservations');
  return structuredClone(await context.observe({ deadline: context.deadline }));
}

/** Retain full authority around the name population observation, including empty pools. */
export async function observeReleaseSearchCandidates(
  pools: readonly ReleaseSearchCandidatePool[],
  context: Context,
): Promise<ReleaseSearchCandidateCut> {
  const plan = [...pools];
  const basis = await authority(plan, context);
  const names = await observeReleaseSearchNames(plan, nameContext(context));
  if (!isDeepStrictEqual(basis, await authority(plan, context))) throw new ReleaseGroupingRestartRequired();
  return { names, basis };
}

function binding(request: ReleaseGroupingRequest, cut: ReleaseSearchCandidateCut, work?: string): string {
  const value = canonicalize({ request, cut, stream: work === undefined ? 'groups' : 'children', work: work ?? null });
  if (!value) return unavailable();
  return createHash('sha256').update(value).digest('hex');
}

function position(after: string | null, expected: string, children: boolean): Position {
  if (after === null) return { version: 1, binding: expected, namesAfter: null };
  let value: Position;
  try {
    value = JSON.parse(after) as Position;
  } catch {
    return unavailable();
  }
  if (
    !value ||
    value.version !== 1 ||
    typeof value.binding !== 'string' ||
    (value.namesAfter !== null && typeof value.namesAfter !== 'string') ||
    (value.skipWorkFor !== undefined && (children || typeof value.skipWorkFor !== 'string' || !value.skipWorkFor)) ||
    (value.seenWorks !== undefined &&
      (children ||
        !Array.isArray(value.seenWorks) ||
        value.seenWorks.length > 128 ||
        value.seenWorks.some((id) => !canonicalId(id)) ||
        new Set(value.seenWorks).size !== value.seenWorks.length))
  )
    return unavailable();
  if (value.binding !== expected) throw new ReleaseGroupingRestartRequired();
  return value;
}

/** Native name-order group and independent child streams. These are private candidate keys,
 * never matching results or public cards. The grouping policy must hydrate every emitted key.
 * One dispatch examines at most `size` native names; rejected names advance progress without
 * asserting EOF. Only the native owner's explicit EOF can terminate preparation.
 */
export function createReleaseSearchCandidateStreams(input: {
  pools: readonly ReleaseSearchCandidatePool[];
  release: FilterRelease;
  cut: ReleaseSearchCandidateCut;
  context: Context;
  relevance?: (request: ReleaseGroupingRequest, after: string | null, size: number) => Promise<ReleaseSearchNativePage>;
  currentMatches?: (
    request: ReleaseGroupingRequest,
    keys: readonly ReleaseSearchNativeCandidate[],
  ) => Promise<ReadonlySet<string>>;
}): Pick<ReleaseGroupingSource<never, never>, 'groups' | 'children'> {
  const pools = input.pools.map((pool) => ({ ...pool }));
  const release = structuredClone(input.release);
  const releaseTypes = new Set(admittedReleaseSearchTypes(release));
  const cut = structuredClone(input.cut);
  const context = { ...input.context };
  const assertCurrent = async () => {
    if (!isDeepStrictEqual(cut, await observeReleaseSearchCandidates(pools, context)))
      throw new ReleaseGroupingRestartRequired();
  };

  type CandidateKey = Awaited<ReturnType<typeof readReleaseSearchNames>>['keys'][number] | ReleaseSearchNativeCandidate;
  async function classify(keys: readonly CandidateKey[]): Promise<Classified[]> {
    const current = new Map<string, Classified>();
    // Native name order interleaves homes. Keep every current read anchored to its exact retained home.
    for (const pool of pools) {
      const population = cut.names.pools.find(({ id }) => id === pool.id)?.population;
      if (!population) throw new ReleaseGroupingRestartRequired();
      for (const home of population.homes) {
        const selected = keys.filter((key) => key.pool === pool.id && key.partition === home.partition);
        if (!selected.length) continue;
        const ids = selected.map(({ id }) => id);
        reserve(context, pool.id, 'sourceReads', ids.length);
        const snapshot = await pool.source.read(home.partition, ids);
        const subjects = validateRequestSourceSnapshot(snapshot, home.partition, ids);
        if (snapshot.position.toString() !== home.position) throw new ReleaseGroupingRestartRequired();
        const releases: string[] = [];
        for (const key of selected) {
          const subject = subjects.get(key.id);
          if (!subject || subject.visibility !== 'visible' || subject.redirect !== null) continue;
          if (subject.securityRevision !== key.securityRevision) throw new ReleaseGroupingRestartRequired();
          const type = Object.hasOwn(release.types, subject.type) ? release.types[subject.type] : undefined;
          const work = subject.type === 'schema:CreativeWork' || !!type?.bases?.includes('schema:CreativeWork');
          current.set(key.id, { id: key.id, work });
          if (releaseTypes.has(subject.type)) releases.push(subject.id);
        }
        if (!releases.length) continue;
        if (!pool.source.readCompleteWorkLinks) return unavailable();
        reserve(context, pool.id, 'completeWorkLinkReads', releases.length);
        const links = await pool.source.readCompleteWorkLinks(home.partition, releases, {
          reserve: ({ operations, keys }) => {
            if (!Number.isSafeInteger(operations) || operations < 0 || !Number.isSafeInteger(keys) || keys < 0)
              return unavailable();
            context.reserve({
              pool: pool.id,
              observations: 0,
              ownerReads: 0,
              nameSeeks: 0,
              keys,
              sourceReads: 0,
              completeWorkLinkReads: 0,
              completeWorkLinkOperations: operations,
              authorityObservations: 0,
              searchReads: 0,
            });
          },
        });
        if ([...links.keys()].some((id) => !releases.includes(id))) return unavailable();
        for (const id of releases) {
          const evidence = links.get(id);
          if (!evidence || typeof evidence.complete !== 'boolean' || !Array.isArray(evidence.values))
            return unavailable();
          if (
            evidence.values.some(
              (value) => !value || (value.kind !== 'unknown' && (value.kind !== 'work' || !canonicalId(value.id))),
            )
          )
            return unavailable();
          current.get(id)!.link = releaseWorkLink(evidence.complete, evidence.values);
        }
      }
    }
    return keys.flatMap(({ id }) => (current.has(id) ? [current.get(id)!] : []));
  }

  async function read(submitted: ReleaseGroupingRequest, after: string | null, size: number, work?: string) {
    if (!Number.isInteger(size) || size < 1 || size > 20) throw new TypeError('Invalid release candidate page size');
    const request = structuredClone(submitted);
    // Relevance needs its own native ordered plan; name traversal cannot establish that order.
    if (request.sort !== 'name' && (request.sort !== 'relevance' || !input.relevance)) return unavailable();
    if (request.releaseDigest !== cut.basis.releaseDigest) throw new ReleaseGroupingRestartRequired();
    const expected = binding(request, cut, work);
    const cursor = position(after, expected, work !== undefined);
    await assertCurrent();
    const page =
      request.sort === 'name'
        ? await readReleaseSearchNames({
            pools,
            cut: cut.names,
            after: cursor.namesAfter,
            size,
            context: nameContext(context),
          })
        : await input.relevance!(request, cursor.namesAfter, size);
    if (
      !Array.isArray(page.keys) ||
      page.keys.length > size ||
      typeof page.after !== 'string' ||
      !page.after ||
      typeof page.exhausted !== 'boolean'
    )
      return unavailable();
    if (request.sort === 'relevance')
      for (const key of page.keys) {
        if (
          typeof key.id !== 'string' ||
          !canonicalId(key.id) ||
          key.pool !== pools[0]?.id ||
          !Number.isInteger(key.partition) ||
          typeof key.securityRevision !== 'number' ||
          !Number.isSafeInteger(key.securityRevision) ||
          key.securityRevision < 0 ||
          typeof key.after !== 'string' ||
          !key.after
        )
          return unavailable();
      }
    const currentMatches = request.sort === 'relevance' ? await input.currentMatches?.(request, page.keys) : undefined;
    const classified = new Map((await classify(page.keys)).map((key) => [key.id, key]));
    const keys: Candidate[] = [];
    let namesAfter = cursor.namesAfter;
    let skipWorkFor = cursor.skipWorkFor;
    const seenWorks = new Set(cursor.seenWorks ?? []);
    if (skipWorkFor !== undefined && page.keys[0]?.id !== skipWorkFor) throw new ReleaseGroupingRestartRequired();
    if (skipWorkFor !== undefined) {
      const replay = classified.get(skipWorkFor);
      if (!replay?.work || !replay.link || replay.link.kind === 'linked') throw new ReleaseGroupingRestartRequired();
    }
    for (const key of page.keys) {
      const current = classified.get(key.id);
      const candidates: Candidate[] = [];
      if (current && (currentMatches === undefined || currentMatches.has(key.id))) {
        if (work === undefined) {
          if (request.sort === 'name') {
            if (current.work && skipWorkFor !== key.id) candidates.push({ kind: 'work', id: key.id });
            if (current.link && current.link.kind !== 'linked') candidates.push({ kind: 'release', id: key.id });
          } else if (current.link?.kind === 'linked') {
            if (!seenWorks.has(current.link.work)) candidates.push({ kind: 'work', id: current.link.work });
          } else {
            if (current.work && skipWorkFor !== key.id && !seenWorks.has(key.id))
              candidates.push({ kind: 'work', id: key.id });
            if (current.link) candidates.push({ kind: 'release', id: key.id });
          }
        } else if (current.link?.kind === 'linked' && current.link.work === work) {
          candidates.push({ kind: 'release', id: key.id });
        }
      }
      // Do not lose the release when one native key can also act as a work target.
      if (keys.length + candidates.length > size) {
        const first = candidates[0];
        if (keys.length < size && first) {
          keys.push(first);
          if (first.kind === 'work') {
            skipWorkFor = key.id;
            if (request.sort === 'relevance') seenWorks.add(first.id);
          }
        }
        break;
      }
      keys.push(...candidates);
      if (request.sort === 'relevance' && work === undefined)
        for (const candidate of candidates) if (candidate.kind === 'work') seenWorks.add(candidate.id);
      skipWorkFor = undefined;
      namesAfter =
        request.sort === 'name'
          ? JSON.stringify({ version: 1, epoch: cut.names.epoch, key: { name: key.name, id: key.id } })
          : (key as ReleaseSearchNativeCandidate).after;
      if (keys.length === size) break;
    }
    const consumed = namesAfter === page.after && skipWorkFor === undefined;
    await assertCurrent();
    return {
      keys,
      after: JSON.stringify({
        version: 1,
        binding: expected,
        namesAfter,
        ...(skipWorkFor ? { skipWorkFor } : {}),
        ...(request.sort === 'relevance' && work === undefined && seenWorks.size
          ? { seenWorks: [...seenWorks] }
          : {}),
      }),
      exhausted: page.exhausted && (consumed || page.keys.length === 0),
    };
  }

  return {
    groups: (request, after, size) => read(request, after, size),
    async children(request, work, after, size) {
      const page = await read(request, after, size, work);
      return { ...page, keys: page.keys.map(({ id }) => id) };
    },
  };
}
