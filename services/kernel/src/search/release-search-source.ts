import { admittedReleaseSearchTypes, type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
import { publicHitFigures, type PublicSearchHit } from './public-figures.ts';
import { checkHits } from './disclosure/check.ts';
import type { CurrentRelationRelease } from './character-person.ts';
import {
  readReleaseChildrenPage,
  readReleaseGroupsPage,
  type ReleaseSearchPrincipal,
} from './release-search-cursor.ts';
import {
  ReleaseGroupingRestartRequired,
  ReleaseGroupingUnavailable,
  type ReleaseGroupingBasis,
  type ReleaseGroupsPage,
  type ReleaseChildrenPage,
  type ReleaseGroupingRequest,
  type ReleaseGroupingSource,
} from './release-search-grouping.ts';
import {
  createReleaseSearchCandidateStreams,
  observeReleaseSearchCandidates,
  type ReleaseSearchCandidatePool,
  type ReleaseSearchCandidateReservation,
  type ReleaseSearchNativeCandidate,
  type ReleaseSearchNativePage,
} from './release-search-native-stream.ts';
import { releaseWorkLink } from './release-search-grouping.ts';
import type { SearchPlan } from './query.ts';
import { searchSubjectHits } from './query.ts';
import { projectFacts, projectHit } from './hits.ts';
import { validateRequestSourceSnapshot, REQUEST_SOURCE_KEYS } from './request-source-snapshot.ts';
import { subjectPartition, type IndexedSubject, type SubjectSource } from './source.ts';
import type { SubjectCanonicalNames } from '../semantic/subject-source-key-pages.ts';
import { admitProperties } from './hits.ts';

type SourceWithNames = SubjectSource & { canonicalNames?: SubjectCanonicalNames };
type Runner = <T>(operation: () => Promise<T>) => Promise<T>;
type Reservation = Omit<ReleaseSearchCandidateReservation, 'pool'>;

function candidatePools(source: SourceWithNames, runSource: Runner): ReleaseSearchCandidatePool[] {
  const names = source.canonicalNames;
  if (!names) throw new ReleaseGroupingUnavailable();
  const current: ReleaseSearchCandidatePool['source'] = {
    read: (partition, ids) => runSource(() => source.read(partition, ids)),
    ...(source.readCompleteWorkLinks
      ? {
          readCompleteWorkLinks: (partition, ids, options) =>
            runSource(() => source.readCompleteWorkLinks!(partition, ids, options)),
        }
      : {}),
  };
  return [
    {
      id: 'semantic',
      names: {
        observe: (context) => runSource(() => names.observe(context)),
        read: (request, expected, context) => runSource(() => names.read(request, expected, context)),
      },
      source: current,
    },
  ];
}

function reserve(
  callback: (reservation: ReleaseSearchCandidateReservation) => void,
  pool: string,
  value: Partial<Reservation> = {},
) {
  callback({
    pool,
    observations: 0,
    ownerReads: 0,
    nameSeeks: 0,
    keys: value.keys ?? 0,
    sourceReads: value.sourceReads ?? 0,
    completeWorkLinkReads: value.completeWorkLinkReads ?? 0,
    completeWorkLinkOperations: value.completeWorkLinkOperations ?? 0,
    authorityObservations: value.authorityObservations ?? 0,
    searchReads: value.searchReads ?? 0,
  });
}

function sortAfter(value: string | null): SearchPlan['after'] {
  if (value === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ReleaseGroupingUnavailable();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'number' ||
    !Number.isFinite(parsed[0]) ||
    typeof parsed[1] !== 'string'
  )
    throw new ReleaseGroupingUnavailable();
  return parsed as NonNullable<SearchPlan['after']>;
}

export type ReleaseSearchGroupsResult = ReleaseGroupsPage<PublicSearchHit, PublicSearchHit>;
export type ReleaseSearchChildrenResult = ReleaseChildrenPage<PublicSearchHit>;

/** Connects private group policy to the retained native plan and the ordinary current disclosure path. */
export async function readReleaseSearchGroups(input: {
  pool: Pool;
  source: SourceWithNames;
  cursors: KeyRing;
  principal: ReleaseSearchPrincipal;
  release: FilterRelease;
  request: ReleaseGroupingRequest;
  nativePlan: SearchPlan;
  generation: number;
  prefix: string;
  client: Parameters<typeof searchSubjectHits>[0];
  relationProperties: readonly string[];
  observeBasis: () => Promise<ReleaseGroupingBasis>;
  deadline: number;
  observeRelationRelease: () => Promise<CurrentRelationRelease | null>;
  now: number;
  runSource: Runner;
  runSearch: Runner;
  reserve: (reservation: ReleaseSearchCandidateReservation) => void;
  currentMatches: (
    request: ReleaseGroupingRequest,
    keys: readonly ReleaseSearchNativeCandidate[],
  ) => Promise<ReadonlySet<string>>;
  cursor?: string;
}): Promise<ReleaseSearchGroupsResult> {
  const source = input.source;
  const poolId = 'semantic';
  const pools = candidatePools(source, input.runSource);
  const context = {
    deadline: input.deadline,
    reserve: input.reserve,
    observe: input.observeBasis,
  };
  const cut = await observeReleaseSearchCandidates(pools, context);
  const candidates = createReleaseSearchCandidateStreams({
    pools,
    release: input.release,
    cut,
    context,
    relevance: async (_request, after, size): Promise<ReleaseSearchNativePage> => {
      const nativeAfter = sortAfter(after);
      reserve(input.reserve, poolId, { searchReads: 1, keys: size });
      const result = await input.runSearch(() =>
        searchSubjectHits(input.client, input.prefix, {
          ...input.nativePlan,
          generation: input.generation,
          size,
          ...(nativeAfter === undefined ? {} : { after: nativeAfter }),
        }),
      );
      const keys = result.hits.map((hit) => ({
        id: hit.id,
        pool: poolId,
        partition: hit.partition,
        name: null,
        securityRevision: hit.securityRevision,
        after: JSON.stringify(hit.sort),
      }));
      return {
        keys,
        after: keys.at(-1)?.after ?? JSON.stringify(nativeAfter ?? null),
        // An empty, complete native read is the only relevance EOF proof.
        exhausted: keys.length === 0,
      };
    },
    currentMatches: input.currentMatches,
  });
  const grouping = createHydrationSource({
    pool: input.pool,
    source,
    request: input.request,
    release: input.release,
    relationProperties: input.relationProperties,
    observeRelationRelease: input.observeRelationRelease,
    observeBasis: input.observeBasis,
    runSource: input.runSource,
    reserve: input.reserve,
    poolId,
    candidates,
  });
  return readReleaseGroupsPage({
    source: grouping,
    request: input.request,
    principal: input.principal,
    cursors: input.cursors,
    now: input.now,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });
}

export async function readReleaseSearchChildren(input: {
  pool: Pool;
  source: SourceWithNames;
  cursors: KeyRing;
  principal: ReleaseSearchPrincipal;
  release: FilterRelease;
  request: ReleaseGroupingRequest;
  nativePlan: SearchPlan;
  generation: number;
  prefix: string;
  client: Parameters<typeof searchSubjectHits>[0];
  relationProperties: readonly string[];
  observeBasis: () => Promise<ReleaseGroupingBasis>;
  deadline: number;
  observeRelationRelease: () => Promise<CurrentRelationRelease | null>;
  now: number;
  runSource: Runner;
  runSearch: Runner;
  reserve: (reservation: ReleaseSearchCandidateReservation) => void;
  currentMatches: (
    request: ReleaseGroupingRequest,
    keys: readonly ReleaseSearchNativeCandidate[],
  ) => Promise<ReadonlySet<string>>;
  work: string;
  cursor?: string;
}): Promise<ReleaseSearchChildrenResult> {
  const source = input.source;
  const poolId = 'semantic';
  const pools = candidatePools(source, input.runSource);
  const context = {
    deadline: input.deadline,
    reserve: input.reserve,
    observe: input.observeBasis,
  };
  const cut = await observeReleaseSearchCandidates(pools, context);
  const candidates = createReleaseSearchCandidateStreams({
    pools,
    release: input.release,
    cut,
    context,
    relevance: async (_request, after, size): Promise<ReleaseSearchNativePage> => {
      const nativeAfter = sortAfter(after);
      reserve(input.reserve, poolId, { searchReads: 1, keys: size });
      const result = await input.runSearch(() =>
        searchSubjectHits(input.client, input.prefix, {
          ...input.nativePlan,
          generation: input.generation,
          size,
          ...(nativeAfter === undefined ? {} : { after: nativeAfter }),
        }),
      );
      const keys = result.hits.map((hit) => ({
        id: hit.id,
        pool: poolId,
        partition: hit.partition,
        name: null,
        securityRevision: hit.securityRevision,
        after: JSON.stringify(hit.sort),
      }));
      return {
        keys,
        after: keys.at(-1)?.after ?? JSON.stringify(nativeAfter ?? null),
        exhausted: keys.length === 0,
      };
    },
    currentMatches: input.currentMatches,
  });
  const grouping = createHydrationSource({
    pool: input.pool,
    source,
    request: input.request,
    release: input.release,
    relationProperties: input.relationProperties,
    observeRelationRelease: input.observeRelationRelease,
    observeBasis: input.observeBasis,
    runSource: input.runSource,
    reserve: input.reserve,
    poolId,
    candidates,
  });
  return readReleaseChildrenPage({
    source: grouping,
    request: input.request,
    principal: input.principal,
    cursors: input.cursors,
    work: input.work,
    now: input.now,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });
}

function createHydrationSource(input: {
  pool: Pool;
  source: SourceWithNames;
  request: ReleaseGroupingRequest;
  release: FilterRelease;
  relationProperties: readonly string[];
  observeRelationRelease: () => Promise<CurrentRelationRelease | null>;
  observeBasis: () => Promise<ReleaseGroupingBasis>;
  runSource: Runner;
  reserve: (reservation: ReleaseSearchCandidateReservation) => void;
  poolId: string;
  candidates: Pick<ReleaseGroupingSource<PublicSearchHit, PublicSearchHit>, 'groups' | 'children'>;
}): ReleaseGroupingSource<PublicSearchHit, PublicSearchHit> {
  const raw = input.source;
  const reserveRead = (keys: number) => reserve(input.reserve, input.poolId, { sourceReads: 1, keys });
  const reserved: SubjectSource = {
    ...raw,
    async read(partition, ids) {
      reserveRead(ids.length);
      return input.runSource(() => raw.read(partition, ids));
    },
    count: (partition) => input.runSource(() => raw.count(partition)),
    ...(raw.matchRelationFacets
      ? {
          matchRelationFacets: (partition: number, probes: Parameters<NonNullable<SubjectSource['matchRelationFacets']>>[1]) => {
            reserveRead(probes.length);
            return input.runSource(() => raw.matchRelationFacets!(partition, probes));
          },
        }
      : {}),
    ...(raw.prepareRelationFacets
      ? {
          async prepareRelationFacets(probes: Parameters<NonNullable<SubjectSource['prepareRelationFacets']>>[0]) {
            reserveRead(probes.length);
            const page = await input.runSource(() => raw.prepareRelationFacets!(probes));
            return {
              bounds: page.bounds,
              async match() {
                reserveRead(probes.length);
                return input.runSource(() => page.match());
              },
              async revalidate() {
                reserveRead(probes.length);
                return input.runSource(() => page.revalidate());
              },
            };
          },
        }
      : {}),
  };
  const releaseTypes = new Set(admittedReleaseSearchTypes(input.release));
  const workTypes = new Set(
    Object.entries(input.release.types)
      .filter(([type, definition]) => type === 'schema:CreativeWork' || definition.bases?.includes('schema:CreativeWork'))
      .map(([type]) => type),
  );
  const properties = input.request.properties;
  if (properties) admitProperties(properties, input.release);

  async function subjects(ids: readonly string[]): Promise<Map<string, IndexedSubject>> {
    const byPartition = new Map<number, string[]>();
    for (const id of ids) {
      let partition: number;
      try {
        partition = subjectPartition(id);
      } catch {
        throw new ReleaseGroupingUnavailable();
      }
      const values = byPartition.get(partition) ?? [];
      values.push(id);
      byPartition.set(partition, values);
    }
    const result = new Map<string, IndexedSubject>();
    for (const [partition, values] of byPartition) {
      for (let offset = 0; offset < values.length; offset += REQUEST_SOURCE_KEYS) {
        const ids = values.slice(offset, offset + REQUEST_SOURCE_KEYS);
        const snapshot = await reserved.read(partition, ids);
        for (const [id, subject] of validateRequestSourceSnapshot(snapshot, partition, ids)) result.set(id, subject);
      }
    }
    return result;
  }

  async function cards(values: readonly IndexedSubject[]): Promise<Map<string, PublicSearchHit>> {
    if (!values.length) return new Map();
    const hits = values.map((subject) =>
      projectHit(subject, { descriptions: true, languages: input.request.languages }),
    );
    if (properties) {
      const facts = await input.runSource(() => projectFacts(reserved, values, properties, input.request.languages));
      hits.forEach((hit, index) => (hit.facts = facts[index]!));
    }
    reserve(input.reserve, input.poolId, { sourceReads: 1, keys: values.length });
    const publicHits = await input.runSource(() => publicHitFigures(input.pool, hits));
    return new Map(publicHits.map((hit) => [hit.id, hit]));
  }

  return {
    async observe() {
      reserve(input.reserve, input.poolId, { sourceReads: 1, authorityObservations: 1 });
      return input.observeBasis();
    },
    groups: input.candidates.groups,
    children: input.candidates.children,
    async works(_request, ids) {
      const current = await subjects(ids);
      const visible = ids.filter((id) => {
        const subject = current.get(id);
        return subject?.visibility === 'visible' && subject.redirect === null && workTypes.has(subject.type);
      });
      return cards(visible.flatMap((id) => (current.has(id) ? [current.get(id)!] : [])));
    },
    async releases(request, ids) {
      const current = await subjects(ids);
      const nativeHits = ids.flatMap((id) => {
        const subject = current.get(id);
        if (
          !subject ||
          subject.visibility !== 'visible' ||
          subject.redirect !== null ||
          !releaseTypes.has(subject.type)
        )
          return [];
        return [{ id, partition: subjectPartition(id), securityRevision: subject.securityRevision, matched: [] }];
      });
      const checked = await input.runSource(() =>
        checkHits(
          reserved,
          nativeHits,
          new Map(),
          {
            filter: request.filter,
            relationProperties: input.relationProperties,
            spoilerThreshold: request.spoilerThreshold,
            observeRelationRelease: input.observeRelationRelease,
          },
        ),
      );
      if (checked.relationRejected) throw new ReleaseGroupingRestartRequired();
      const matches = new Map(checked.passed.map(({ hit, subject }) => [hit.id, subject]));
      const linkValues = new Map<string, ReturnType<typeof releaseWorkLink>>();
      if (matches.size) {
        if (!raw.readCompleteWorkLinks) throw new ReleaseGroupingUnavailable();
        for (const [partition, part] of groupPartition([...matches.keys()])) {
          reserve(input.reserve, input.poolId, { completeWorkLinkReads: 1, keys: part.length });
          const evidence = await input.runSource(() =>
            raw.readCompleteWorkLinks!(partition, part, {
              reserve: (cost) =>
                reserve(input.reserve, input.poolId, {
                  completeWorkLinkOperations: cost.operations,
                  keys: cost.keys,
                }),
            }),
          );
          for (const id of part) {
            const value = evidence.get(id);
            if (!value) throw new ReleaseGroupingUnavailable();
            linkValues.set(id, releaseWorkLink(value.complete, value.values));
          }
        }
      }
      const cardsById = await cards([...matches.values()]);
      return new Map(
        [...matches.keys()].flatMap((id) => {
          const card = cardsById.get(id);
          const link = linkValues.get(id);
          return card && link ? [[id, { card, link }] as const] : [];
        }),
      );
    },
  };
}

function groupPartition(ids: readonly string[]): [number, string[]][] {
  const groups = new Map<number, string[]>();
  for (const id of ids) {
    const partition = subjectPartition(id);
    const values = groups.get(partition) ?? [];
    values.push(id);
    groups.set(partition, values);
  }
  return [...groups];
}
