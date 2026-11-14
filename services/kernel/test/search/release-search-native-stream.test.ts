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
import {
  ReleaseSearchRelevanceStateConflict,
  ReleaseSearchRelevanceStateExpired,
  type ReleaseSearchRelevanceBinding,
  type ReleaseSearchRelevanceLocation,
  type ReleaseSearchRelevanceState,
} from '../../src/search/release-search-relevance-state.ts';
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

function memoryRelevanceState(): ReleaseSearchRelevanceState {
  let sequence = 1;
  const uuid = () => `00000000-0000-8000-8000-${String(sequence++).padStart(12, '0')}`;
  const sessions = new Map<string, { binding: string; expires: number }>();
  const nodes = new Map<string, { parent: string | null; works: Set<string> }>();
  const branches = new Map<string, string>();
  const key = (execution: string, node: string) => `${execution}/${node}`;
  const bindingKey = (binding: ReleaseSearchRelevanceBinding) => JSON.stringify(binding);
  function session(binding: ReleaseSearchRelevanceBinding, location: ReleaseSearchRelevanceLocation, now: number) {
    const value = sessions.get(location.execution);
    if (
      !value ||
      value.binding !== bindingKey(binding) ||
      value.expires <= now ||
      !nodes.has(key(location.execution, location.node))
    )
      throw new ReleaseSearchRelevanceStateExpired();
    return value;
  }
  return {
    async start(binding, now, initialWorks = []) {
      const execution = uuid();
      const node = uuid();
      sessions.set(execution, { binding: bindingKey(binding), expires: now + 15 * 60_000 });
      nodes.set(key(execution, node), { parent: null, works: new Set(initialWorks) });
      return { execution, node };
    },
    async resume(binding, location, now) {
      session(binding, location, now).expires = now + 15 * 60_000;
    },
    async seen(binding, location, works, now) {
      session(binding, location, now);
      const candidates = new Set(works);
      const seen = new Set<string>();
      let current: string | null = location.node;
      while (current !== null) {
        const value = nodes.get(key(location.execution, current));
        if (!value) throw new ReleaseSearchRelevanceStateExpired();
        for (const id of value.works) if (candidates.has(id)) seen.add(id);
        current = value.parent;
      }
      return seen;
    },
    async advance(binding, location, branch, works, now) {
      session(binding, location, now);
      if (!works.length) return location;
      const branchKey = `${key(location.execution, location.node)}/${branch}`;
      const existing = branches.get(branchKey);
      if (existing) {
        const saved = nodes.get(key(location.execution, existing))!;
        if (JSON.stringify([...saved.works].sort()) !== JSON.stringify([...works].sort()))
          throw new ReleaseSearchRelevanceStateConflict();
        return { execution: location.execution, node: existing };
      }
      const node = uuid();
      branches.set(branchKey, node);
      nodes.set(key(location.execution, node), { parent: location.node, works: new Set(works) });
      return { execution: location.execution, node };
    },
  };
}

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
        homes: subjects.some(({ id }) => subjectPartition(id) === index) ? [{ ...home, partition: index }] : [],
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
    observe: async ({
      homesByPool,
    }: {
      deadline: number;
      homesByPool: Readonly<Record<string, readonly { partition: number; position: string }[]>>;
    }) => {
      observedHomes.push(structuredClone(homesByPool));
      return basis;
    },
  };
  const relevanceProgress = {
    principal: 'account:00000000-0000-8000-8000-000000000001',
    generation: 1,
    now: 1_800_000_000_000,
    state: memoryRelevanceState(),
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
  const streams = createReleaseSearchCandidateStreams({ pools, release, cut, context, relevanceProgress });
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
    relevanceProgress,
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

test('relevance follows native release order and emits a linked work only once', async () => {
  const f = await fixture();
  const repeated = f.id(6);
  f.subjects[6]!.type = 'edition';
  f.links.set(repeated, { complete: true, values: [{ kind: 'work', id: f.id(0) }] });
  const ids = [f.id(1), repeated, f.id(4), f.id(2), f.id(3), f.id(5)];
  const relevance = async (_request: ReleaseGroupingRequest, after: string | null, size: number) => {
    const offset = after === null ? 0 : Number(after);
    const selected = ids.slice(offset, offset + size);
    const keys = selected.map((id, index) => ({
      id,
      pool: 'pool-0',
      partition: 0,
      name: null,
      securityRevision: 0,
      after: String(offset + index + 1),
    }));
    return { keys, after: String(offset + selected.length), exhausted: selected.length === 0 };
  };
  const streams = createReleaseSearchCandidateStreams({ ...f, relevance });
  const result: { kind: string; id: string }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 8; page++) {
    const next = await streams.groups({ ...request, sort: 'relevance' }, after, 2);
    result.push(...next.keys);
    after = next.after;
    if (next.exhausted) break;
  }
  expect(result).toEqual([
    { kind: 'work', id: f.id(0) },
    { kind: 'work', id: f.id(4) },
    { kind: 'release', id: f.id(4) },
    { kind: 'work', id: f.id(2) },
    { kind: 'release', id: f.id(2) },
    { kind: 'work', id: f.id(3) },
    { kind: 'release', id: f.id(3) },
    { kind: 'work', id: f.id(5) },
    { kind: 'release', id: f.id(5) },
  ]);
});

test('a stale native filter candidate cannot claim a work before its first current match', async () => {
  const f = await fixture();
  f.subjects[6]!.type = 'edition';
  f.links.set(f.id(6), { complete: true, values: [{ kind: 'work', id: f.id(0) }] });
  const ids = [f.id(1), f.id(6)];
  const relevance = async (_request: ReleaseGroupingRequest, after: string | null, size: number) => {
    const offset = after === null ? 0 : Number(after);
    const selected = ids.slice(offset, offset + size);
    const keys = selected.map((id, index) => ({
      id,
      pool: 'pool-0',
      partition: 0,
      name: null,
      securityRevision: 0,
      after: String(offset + index + 1),
    }));
    return { keys, after: String(offset + selected.length), exhausted: selected.length === 0 };
  };
  const streams = createReleaseSearchCandidateStreams({
    ...f,
    relevance,
    currentMatches: async (_request, keys) => new Set(keys.filter(({ id }) => id === f.id(6)).map(({ id }) => id)),
  });
  const page = await streams.groups({ ...request, sort: 'relevance' }, null, 2);
  expect(page.keys).toEqual([{ kind: 'work', id: f.id(0) }]);
});

test('a valid inline relevance cursor seeds private progress during protocol migration', async () => {
  const f = await fixture();
  const relevanceRequest = { ...request, sort: 'relevance' as const };
  f.subjects[6]!.type = 'edition';
  f.links.set(f.id(6), { complete: true, values: [{ kind: 'work', id: f.id(0) }] });
  const ids = [f.id(1), f.id(6)];
  const relevance = async (_request: ReleaseGroupingRequest, after: string | null, size: number) => {
    const offset = after === null ? 0 : Number(after);
    const selected = ids.slice(offset, offset + size);
    const keys = selected.map((id, index) => ({
      id,
      pool: 'pool-0',
      partition: 0,
      name: null,
      securityRevision: 0,
      after: String(offset + index + 1),
    }));
    return { keys, after: String(offset + selected.length), exhausted: selected.length === 0 };
  };
  const streams = createReleaseSearchCandidateStreams({ ...f, relevance });
  const first = await streams.groups(relevanceRequest, null, 1);
  expect(first.keys).toEqual([{ kind: 'work', id: f.id(0) }]);
  const current = JSON.parse(first.after) as { binding: string; namesAfter: string };
  const legacy = JSON.stringify({
    version: 1,
    binding: current.binding,
    namesAfter: current.namesAfter,
    seenWorks: [f.id(0)],
  });
  const resumed = await streams.groups(relevanceRequest, legacy, 1);
  expect(resumed.keys).toEqual([]);
  expect(JSON.parse(resumed.after)).toHaveProperty('relevance');
});

test('relevance resumes beyond 128 works with current ownership, interleaved repeats and replayable branches', async () => {
  const f = await fixture();
  const relevanceRequest = { ...request, sort: 'relevance' as const };
  const stale = f.id(2000);
  const workIds = Array.from({ length: 129 }, (_, index) => f.id(1000 + index));
  const releaseIds = Array.from({ length: 129 }, (_, index) => f.id(3000 + index * 2));
  const repeatIds = Array.from({ length: 129 }, (_, index) => f.id(3001 + index * 2));
  const subject = (id: string, type: string): IndexedSubject => ({
    id,
    type,
    visibility: 'visible',
    redirect: null,
    securityRevision: 0,
    labels: [{ language: 'en', value: id }],
    aliases: [],
    descriptions: [],
    statements: [],
  });
  for (const id of workIds) f.subjects.push(subject(id, 'work'));
  f.subjects.push(subject(stale, 'edition'));
  f.links.set(stale, { complete: true, values: [{ kind: 'work', id: workIds[0]! }] });
  const nativeIds = [stale];
  for (let index = 0; index < workIds.length; index++) {
    const work = workIds[index]!;
    const release = releaseIds[index]!;
    const repeat = repeatIds[index]!;
    f.subjects.push(subject(release, 'edition'), subject(repeat, 'edition'));
    f.links.set(release, { complete: true, values: [{ kind: 'work', id: work }] });
    f.links.set(repeat, { complete: true, values: [{ kind: 'work', id: work }] });
    nativeIds.push(release);
    if (index === 0 || index % 5 === 0) nativeIds.push(repeatIds[Math.max(0, index - 1)]!);
  }
  const nativeWindowSizes: number[] = [];
  const relevance = async (_request: ReleaseGroupingRequest, after: string | null, size: number) => {
    const offset = after === null ? 0 : Number(after);
    const selected = nativeIds.slice(offset, offset + size);
    nativeWindowSizes.push(selected.length);
    const keys = selected.map((id, index) => ({
      id,
      pool: 'pool-0',
      partition: subjectPartition(id),
      name: null,
      securityRevision: 0,
      after: String(offset + index + 1),
    }));
    return { keys, after: String(offset + selected.length), exhausted: selected.length === 0 };
  };
  const currentMatches = async (_request: ReleaseGroupingRequest, keys: readonly { id: string }[]) =>
    new Set(keys.filter(({ id }) => id !== stale).map(({ id }) => id));
  const streams = createReleaseSearchCandidateStreams({ ...f, relevance, currentMatches });
  const reopened = createReleaseSearchCandidateStreams({ ...f, relevance, currentMatches });
  const results: { kind: string; id: string }[] = [];
  let after: string | null = null;
  let firstAfter: string | undefined;
  let firstNext: Awaited<ReturnType<typeof streams.groups>> | undefined;
  let maxPositionBytes = 0;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await streams.groups(relevanceRequest, after, 20);
    results.push(...page.keys);
    after = page.after;
    const position = JSON.parse(page.after) as { seenWorks?: unknown; relevance?: Record<string, unknown> };
    expect(position.seenWorks).toBeUndefined();
    expect(Object.keys(position.relevance ?? {}).sort()).toEqual(['execution', 'node']);
    maxPositionBytes = Math.max(maxPositionBytes, Buffer.byteLength(page.after));
    if (pageNumber === 0) firstAfter = page.after;
    if (pageNumber === 1) firstNext = page;
    if (page.exhausted) break;
  }
  expect(firstAfter).toBeDefined();
  expect(firstNext).toBeDefined();
  const replay = await reopened.groups(relevanceRequest, firstAfter!, 20);
  expect(replay.keys).toEqual(firstNext!.keys);
  expect(replay.after).toBe(firstNext!.after);
  expect(maxPositionBytes).toBeLessThan(512);
  expect(results.filter(({ kind }) => kind === 'work').map(({ id }) => id)).toEqual(workIds);
  expect(new Set(results.filter(({ kind }) => kind === 'work').map(({ id }) => id)).size).toBe(129);
  expect(results.some(({ id }) => id === stale)).toBe(false);
  expect(Math.max(...nativeWindowSizes)).toBeLessThanOrEqual(20);
  f.change({ epoch: 'changed-after-relevance-page' });
  await expect(reopened.groups(relevanceRequest, firstAfter!, 20)).rejects.toBeInstanceOf(
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
