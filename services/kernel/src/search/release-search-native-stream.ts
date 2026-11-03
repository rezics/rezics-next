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
    authorityObservations: number;
    relationFacetReads?: number;
    hydrationReads?: number;
    serializationBytes?: number;
  }>;
export type ReleaseSearchCandidateContext = Readonly<{
  deadline: number;
  reserve: (reservation: ReleaseSearchCandidateReservation) => void;
  /** Full retained authority across ALL pools, beyond canonical-name publication. */
  observe: (context: {
    deadline: number;
    homesByPool: Readonly<Record<string, readonly { partition: number; position: string }[]>>;
  }) => Promise<ReleaseGroupingBasis>;
}>;
type Context = ReleaseSearchCandidateContext;
export type ReleaseSearchCandidateCut = Readonly<{
  names: ReleaseSearchNameCut;
  basis: ReleaseGroupingBasis;
}>;
type Candidate = { kind: 'work' | 'release'; id: string };
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
        authorityObservations: 0,
      }),
  };
}

function reserve(
  context: Context,
  pool: string,
  phase: 'sourceReads' | 'completeWorkLinkReads' | 'authorityObservations',
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
    authorityObservations: 0,
    [phase]: 1,
  });
}

async function authority(pools: readonly ReleaseSearchCandidatePool[], names: ReleaseSearchNameCut, context: Context) {
  const homesByPool: Record<string, { partition: number; position: string }[]> = {};
  for (const pool of pools) {
    const population = names.pools.find(({ id }) => id === pool.id)?.population;
    if (!population) throw new ReleaseGroupingRestartRequired();
    const homes = population.homes.map(({ partition, position }) => ({ partition, position }));
    homesByPool[pool.id] = homes;
    // The final authority observer reads each populated owner cut separately. Empty pools still
    // reserve and retain their generation observation so later population invalidates progress.
    reserve(context, pool.id, 'authorityObservations');
    for (const _home of homes) reserve(context, pool.id, 'sourceReads');
  }
  return structuredClone(await context.observe({ deadline: context.deadline, homesByPool }));
}

/** Retain full authority around the name population observation, including empty pools. */
export async function observeReleaseSearchCandidates(
  pools: readonly ReleaseSearchCandidatePool[],
  context: Context,
): Promise<ReleaseSearchCandidateCut> {
  const plan = [...pools];
  const names = await observeReleaseSearchNames(plan, nameContext(context));
  const basis = await authority(plan, names, context);
  const currentNames = await observeReleaseSearchNames(plan, nameContext(context));
  const currentBasis = await authority(plan, currentNames, context);
  if (!isDeepStrictEqual(names, currentNames) || !isDeepStrictEqual(basis, currentBasis))
    throw new ReleaseGroupingRestartRequired();
  return { names: currentNames, basis: currentBasis };
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
    (value.skipWorkFor !== undefined && (children || typeof value.skipWorkFor !== 'string' || !value.skipWorkFor))
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

  async function classify(keys: Awaited<ReturnType<typeof readReleaseSearchNames>>['keys']): Promise<Classified[]> {
    const current = new Map<string, Classified>();
    const poolByPartition = new Map<number, { pool: ReleaseSearchCandidatePool; position: string }>();
    for (const pool of pools) {
      const population = cut.names.pools.find(({ id }) => id === pool.id)?.population;
      if (!population) throw new ReleaseGroupingRestartRequired();
      for (const home of population.homes) poolByPartition.set(home.partition, { pool, position: home.position });
    }
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
        const links = await pool.source.readCompleteWorkLinks(home.partition, releases);
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

    // The relation owner establishes a complete link, but only the target's own pool can
    // establish that the canonical work is still a visible current CreativeWork. This
    // cross-pool anchor keeps a stale, remote, concealed, or redirected target identity-free.
    const linked = new Map<string, Classified[]>();
    for (const value of current.values())
      if (value.link?.kind === 'linked') linked.set(value.link.work, [...(linked.get(value.link.work) ?? []), value]);
    const byOwner = new Map<ReleaseSearchCandidatePool, Map<number, string[]>>();
    for (const [work, releases] of linked) {
      const owner = poolByPartition.get(subjectPartition(work));
      if (!owner) {
        for (const release of releases) release.link = { kind: 'unknown' };
        continue;
      }
      const partitions = byOwner.get(owner.pool) ?? new Map<number, string[]>();
      const ids = partitions.get(subjectPartition(work)) ?? [];
      ids.push(work);
      partitions.set(subjectPartition(work), ids);
      byOwner.set(owner.pool, partitions);
    }
    for (const [pool, partitions] of byOwner) {
      for (const [partition, ids] of partitions) {
        const home = poolByPartition.get(partition);
        if (!home || home.pool !== pool) throw new ReleaseGroupingRestartRequired();
        reserve(context, pool.id, 'sourceReads', ids.length);
        const snapshot = await pool.source.read(partition, ids);
        const subjects = validateRequestSourceSnapshot(snapshot, partition, ids);
        if (snapshot.position.toString() !== home.position) throw new ReleaseGroupingRestartRequired();
        for (const id of ids) {
          const subject = subjects.get(id);
          const type = subject && Object.hasOwn(release.types, subject.type) ? release.types[subject.type] : undefined;
          const workType = subject?.type === 'schema:CreativeWork' || !!type?.bases?.includes('schema:CreativeWork');
          if (!subject || subject.visibility !== 'visible' || subject.redirect !== null || !workType)
            for (const release of linked.get(id) ?? []) release.link = { kind: 'unknown' };
        }
      }
    }
    return keys.flatMap(({ id }) => (current.has(id) ? [current.get(id)!] : []));
  }

  async function read(submitted: ReleaseGroupingRequest, after: string | null, size: number, work?: string) {
    if (!Number.isInteger(size) || size < 1 || size > 20) throw new TypeError('Invalid release candidate page size');
    const request = structuredClone(submitted);
    // Relevance needs its own native ordered plan; name traversal cannot establish that order.
    if (request.sort !== 'name') return unavailable();
    if (request.releaseDigest !== cut.basis.releaseDigest) throw new ReleaseGroupingRestartRequired();
    const expected = binding(request, cut, work);
    const cursor = position(after, expected, work !== undefined);
    await assertCurrent();
    const page = await readReleaseSearchNames({
      pools,
      cut: cut.names,
      after: cursor.namesAfter,
      size,
      context: nameContext(context),
    });
    const classified = new Map((await classify(page.keys)).map((key) => [key.id, key]));
    const keys: Candidate[] = [];
    let namesAfter = cursor.namesAfter;
    let skipWorkFor = cursor.skipWorkFor;
    if (skipWorkFor !== undefined && page.keys[0]?.id !== skipWorkFor) throw new ReleaseGroupingRestartRequired();
    if (skipWorkFor !== undefined) {
      const replay = classified.get(skipWorkFor);
      if (!replay?.work || !replay.link || replay.link.kind === 'linked') throw new ReleaseGroupingRestartRequired();
    }
    for (const key of page.keys) {
      const current = classified.get(key.id);
      const candidates: Candidate[] = [];
      if (current) {
        if (work === undefined) {
          if (current.work && skipWorkFor !== key.id) candidates.push({ kind: 'work', id: key.id });
          if (current.link && current.link.kind !== 'linked') candidates.push({ kind: 'release', id: key.id });
        } else if (current.link?.kind === 'linked' && current.link.work === work) {
          candidates.push({ kind: 'release', id: key.id });
        }
      }
      // Do not lose the release when one native key can also act as a work target.
      if (keys.length + candidates.length > size) {
        const first = candidates[0];
        if (keys.length < size && first) {
          keys.push(first);
          skipWorkFor = key.id;
        }
        break;
      }
      keys.push(...candidates);
      skipWorkFor = undefined;
      namesAfter = JSON.stringify({ version: 1, epoch: cut.names.epoch, key: { name: key.name, id: key.id } });
      if (keys.length === size) break;
    }
    const consumed = namesAfter === page.after && skipWorkFor === undefined;
    const rechecked = new Map((await classify(page.keys)).map((key) => [key.id, key]));
    if (
      [...classified].some(([id, value]) => !isDeepStrictEqual(value, rechecked.get(id))) ||
      [...rechecked.keys()].some((id) => !classified.has(id))
    )
      throw new ReleaseGroupingRestartRequired();
    await assertCurrent();
    return {
      keys,
      after: JSON.stringify({ version: 1, binding: expected, namesAfter, ...(skipWorkFor ? { skipWorkFor } : {}) }),
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
