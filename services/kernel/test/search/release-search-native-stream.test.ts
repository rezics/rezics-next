import { expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import {
  createReleaseSearchCandidateStreams,
  observeReleaseSearchCandidates,
  type ReleaseSearchCandidatePool,
  type ReleaseSearchCandidateReservation,
} from '../../src/search/release-search-native-stream.ts';
import {
  ReleaseGroupingRestartRequired,
  ReleaseGroupingUnavailable,
  type ReleaseGroupingBasis,
  type ReleaseGroupingRequest,
} from '../../src/search/release-search-grouping.ts';
import { subjectPartition, type IndexedSubject, type NativeWorkLinkEvidence } from '../../src/search/source.ts';

const request: ReleaseGroupingRequest = {
  releaseDigest: 'active',
  filter: { type: { in: ['edition'] } },
  sort: 'name',
  languages: ['ja', 'en'],
  spoilerThreshold: 0,
  groupLimit: 1,
  childLimit: 2,
  previewLimit: 1,
};

async function fixture() {
  const id = (index: number) =>
    index === 0 ? '00000000-0000-8000-8000-001000000000' : `10000000-0000-8000-8000-${String(index).padStart(12, '0')}`;
  const subjects: IndexedSubject[] = Array.from({ length: 7 }, (_, index) => ({
    id: id(index),
    type: index === 0 ? 'work' : index === 6 ? 'other' : 'edition',
    visibility: 'visible',
    redirect: null,
    securityRevision: 0,
    labels: [{ language: 'en', value: String(index) }],
    aliases: [],
    descriptions: [],
    // Deliberately misleading sampled facts must never establish ownership.
    statements: [{ property: 'schema:exampleOfWork', value: id(9), facet: { kind: 'item' } }],
  }));
  const links = new Map<string, NativeWorkLinkEvidence>([
    [
      id(1),
      {
        complete: true,
        values: [
          { kind: 'work', id: id(0) },
          { kind: 'work', id: id(0) },
        ],
      },
    ],
    [id(2), { complete: true, values: [] }],
    [id(3), { complete: true, values: [{ kind: 'unknown' }] }],
    [
      id(4),
      {
        complete: true,
        values: [
          { kind: 'work', id: id(0) },
          { kind: 'work', id: id(8) },
        ],
      },
    ],
    [id(5), { complete: false, values: [{ kind: 'work', id: id(0) }] }],
  ]);
  const reservations: ReleaseSearchCandidateReservation[] = [];
  const reads: string[][] = [];
  const observedHomes: Readonly<Record<string, readonly { partition: number; position: string }[]>>[] = [];
  let basis: ReleaseGroupingBasis = {
    releaseDigest: 'active',
    epoch: 'all-source-cuts',
    physical: { generation: 1, incarnation: 'one', indexUuid: 'physical-one' },
    calendarReadyFor: null,
  };
  const home = { partition: 0, generation: '1', epoch: 1, position: '0' };
  const pools: ReleaseSearchCandidatePool[] = [0, 1].map((index) => ({
    id: `pool-${index}`,
    names: {
      observe: async () => ({
        generation: String(index),
        homes: subjects.some(({ id }) => subjectPartition(id) === index)
          ? [{ ...home, partition: index }]
          : [],
      }),
      read: async ({ partition, after, limit }) => ({
        home: { ...home, partition },
        candidates: subjects
          .filter(({ id }) => subjectPartition(id) === partition && (after === null || id > after.id))
          .slice(0, limit)
          .map(({ id, securityRevision }) => ({ id, securityRevision, name: id })),
      }),
    },
    source: {
      read: async (partition, ids) => ({
        partition,
        position: 0n,
        subjects: subjects.filter(({ id }) => subjectPartition(id) === partition && ids.includes(id)),
      }),
      readCompleteWorkLinks: async (_partition, ids) => {
        reads.push([...ids]);
        return new Map(ids.filter((id) => links.has(id)).map((id) => [id, links.get(id)!]));
      },
    },
  }));
  const context = {
    deadline: Date.now() + 10_000,
    reserve: (value: ReleaseSearchCandidateReservation) => {
      reservations.push(value);
    },
    observe: async ({ homesByPool }: {
      deadline: number;
      homesByPool: Readonly<Record<string, readonly { partition: number; position: string }[]>>;
    }) => {
      observedHomes.push(structuredClone(homesByPool));
      return basis;
    },
  };
  const release: FilterRelease = {
    types: {
      work: { bases: ['schema:CreativeWork'] },
      edition: { bases: ['schema:CreativeWork'], facets: ['schema:exampleOfWork'] },
      other: {},
    },
    properties: { 'schema:exampleOfWork': { datatype: 'wikibase-item' } },
  };
  const cut = await observeReleaseSearchCandidates(pools, context);
  const streams = createReleaseSearchCandidateStreams({ pools, release, cut, context });
  return {
    id,
    subjects,
    links,
    reads,
    reservations,
    observedHomes,
    pools,
    streams,
    cut,
    context,
    release,
    change: (patch: Partial<ReleaseGroupingBasis>) => {
      basis = { ...basis, ...patch };
    },
  };
}

test('complete native ownership classifies distinct works and ungroupable releases without sampled links', async () => {
  const f = await fixture();
  const keys: { kind: string; id: string }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await f.streams.groups(request, after, 1);
    keys.push(...result.keys);
    after = result.after;
    if (result.exhausted) break;
    if (page === 19) throw new Error('Native EOF was never proven');
  }
  expect(keys.filter(({ kind }) => kind === 'work').map(({ id }) => id)).toEqual(
    Array.from({ length: 6 }, (_, i) => f.id(i)),
  );
  expect(keys.filter(({ kind }) => kind === 'release').map(({ id }) => id)).toEqual([2, 3, 4, 5].map(f.id));
  expect(JSON.stringify(keys)).not.toContain(f.id(9));
  expect(new Set(keys.map(({ kind, id }) => `${kind}:${id}`)).size).toBe(keys.length);
  const empty = await f.streams.groups(request, after, 1);
  expect(empty.keys).toEqual([]);
  expect(empty.exhausted).toBe(true);
  expect(f.reads.some((ids) => ids.includes(f.id(3)))).toBe(true);
  expect(
    f.reservations.some(({ pool, authorityObservations }) => pool === 'pool-1' && authorityObservations === 1),
  ).toBe(true);
  expect(f.observedHomes[0]).toEqual({
    'pool-0': [{ partition: 0, position: '0' }],
    'pool-1': [{ partition: 1, position: '0' }],
  });
});

test('children seek independently through rejected names and bind progress to their work and complete request', async () => {
  const f = await fixture();
  const preparing = await f.streams.children(request, f.id(0), null, 1);
  expect(preparing.keys).toEqual([]);
  expect(preparing.exhausted).toBe(false);
  const child = await f.streams.children(request, f.id(0), preparing.after, 1);
  expect(child.keys).toEqual([f.id(1)]);
  expect(await f.streams.children(request, f.id(0), preparing.after, 1)).toEqual(child);
  const other = await f.streams.children(request, f.id(8), null, 2);
  expect(other.keys).toEqual([]);
  expect(other.exhausted).toBe(false);
  for (const [submitted, work] of [
    [{ ...request, languages: ['en', 'ja'] }, f.id(0)],
    [request, f.id(8)],
  ] as const)
    await expect(f.streams.children(submitted, work, child.after, 1)).rejects.toBeInstanceOf(
      ReleaseGroupingRestartRequired,
    );
});

test('full authority retires both streams on resume and during complete link reads, beyond name cuts', async () => {
  for (const concurrent of [false, true]) {
    const f = await fixture();
    const group = await f.streams.groups(request, null, 2);
    const child = await f.streams.children(request, f.id(0), null, 2);
    if (concurrent) {
      const read = f.pools[0]!.source.readCompleteWorkLinks!;
      f.pools[0]!.source.readCompleteWorkLinks = async (...args) => {
        const result = await read(...args);
        f.change({ epoch: 'disclosure-redirect-date-credit-order-change' });
        return result;
      };
    } else f.change({ physical: { ...f.cut.basis.physical, indexUuid: 'replacement' } });
    await expect(f.streams.groups(request, group.after, 2)).rejects.toBeInstanceOf(ReleaseGroupingRestartRequired);
    await expect(f.streams.children(request, f.id(0), child.after, 2)).rejects.toBeInstanceOf(
      ReleaseGroupingRestartRequired,
    );
  }
});

test('missing complete evidence fails closed and dispatch reservation failures precede owner reads', async () => {
  const f = await fixture();
  f.links.delete(f.id(1));
  await expect(f.streams.groups(request, null, 2)).rejects.toBeInstanceOf(ReleaseGroupingUnavailable);
  f.links.set(f.id(1), { complete: true, values: [{ kind: 'work', id: 'malformed-target' }] });
  await expect(f.streams.groups(request, null, 2)).rejects.toBeInstanceOf(ReleaseGroupingUnavailable);
  f.reads.length = 0;
  const streams = createReleaseSearchCandidateStreams({
    ...f,
    context: {
      ...f.context,
      reserve: (value) => {
        if (value.completeWorkLinkReads) throw new Error('no work-link allowance');
      },
    },
  });
  await expect(streams.groups(request, null, 2)).rejects.toThrow('no work-link allowance');
  expect(f.reads).toEqual([]);
});

test('a complete relation does not establish remote ownership when its canonical target is concealed', async () => {
  const f = await fixture();
  const owner = f.pools[1]!.source.read;
  let targetReads = 0;
  f.pools[1]!.source.read = async (partition, ids) => {
    const snapshot = await owner(partition, ids);
    if (!ids.includes(f.id(0))) return snapshot;
    targetReads++;
    return {
      ...snapshot,
      subjects: snapshot.subjects.map((subject) =>
        subject.id === f.id(0) ? { ...subject, visibility: 'hidden' as const } : subject,
      ),
    };
  };
  const page = await f.streams.groups(request, null, 20);
  expect(targetReads).toBeGreaterThan(0);
  expect(page.keys).not.toContainEqual({ kind: 'work', id: f.id(0) });
  expect(page.keys).toContainEqual({ kind: 'release', id: f.id(1) });
  expect(JSON.stringify(page.keys)).not.toContain(f.id(0));
});
