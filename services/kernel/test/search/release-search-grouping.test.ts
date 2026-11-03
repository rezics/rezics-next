import { expect, test } from 'bun:test';
import {
  readReleaseChildren,
  readReleaseGroups,
  releaseWorkLink,
  RELEASE_GROUPING_LIMITS,
  ReleaseGroupingRestartRequired,
  ReleaseGroupingUnavailable,
  type ReleaseGroupingBasis,
  type ReleaseGroupingRequest,
  type ReleaseGroupingSource,
  type ReleaseWorkLink,
  type ReleaseGroupContinuation,
} from '../../src/search/release-search-grouping.ts';

const physical = { generation: 1, incarnation: 'first', indexUuid: 'physical-1' };
const request: ReleaseGroupingRequest = {
  releaseDigest: 'active',
  filter: { type: { in: ['release'] } },
  sort: 'name',
  languages: ['ja', 'en'],
  spoilerThreshold: 0,
  groupLimit: 1,
  childLimit: 2,
  previewLimit: 1,
};

function fixture(count = 3) {
  let basis: ReleaseGroupingBasis = { releaseDigest: 'active', physical, calendarReadyFor: physical, epoch: '1' };
  const groups = [
    { kind: 'work' as const, id: 'a' },
    { kind: 'work' as const, id: 'b' },
  ];
  const releases = new Map<string, { card: string; link: ReleaseWorkLink }>();
  for (const work of ['a', 'b'])
    for (let index = 0; index < count; index++)
      releases.set(`${work}${index}`, { card: `${work}${index}`, link: { kind: 'linked', work } });
  const calls: { method: string; size: number }[] = [];
  const page = <Key>(keys: Key[], after: string | null, size: number) => {
    const start = Number(after ?? 0);
    const end = Math.min(keys.length, start + size);
    return { keys: keys.slice(start, end), after: String(end), exhausted: end === keys.length };
  };
  const source: ReleaseGroupingSource<string, string> = {
    async observe() {
      calls.push({ method: 'observe', size: 0 });
      return basis;
    },
    async groups(_request, after, size) {
      calls.push({ method: 'groups', size });
      return page(groups, after, size);
    },
    async children(_request, work, after, size) {
      calls.push({ method: 'children', size });
      return page(
        Array.from({ length: count }, (_, index) => `${work}${index}`),
        after,
        size,
      );
    },
    async works(_request, ids) {
      calls.push({ method: 'works', size: ids.length });
      return new Map(ids.map((id) => [id, `Work ${id}`]));
    },
    async releases(_request, ids) {
      calls.push({ method: 'releases', size: ids.length });
      return new Map(ids.flatMap((id) => (releases.has(id) ? [[id, releases.get(id)!] as const] : [])));
    },
  };
  return {
    source,
    calls,
    releases,
    change: (patch: Partial<ReleaseGroupingBasis>) => {
      basis = { ...basis, ...patch };
    },
  };
}

test('complete links keep absent, unknown, contradictory and duplicate canonical works truthful', () => {
  expect(releaseWorkLink(true, [])).toEqual({ kind: 'missing' });
  expect(releaseWorkLink(true, [{ kind: 'none' }])).toEqual({ kind: 'missing' });
  expect(releaseWorkLink(true, [{ kind: 'unknown' }])).toEqual({ kind: 'unknown' });
  const work = { kind: 'work' as const, id: 'canonical' };
  expect(releaseWorkLink(true, [work, work])).toEqual({ kind: 'linked', work: 'canonical' });
  expect(releaseWorkLink(false, [work])).toEqual({ kind: 'unproven' });
  for (const other of [{ kind: 'none' as const }, { kind: 'work' as const, id: 'different' }])
    expect(releaseWorkLink(true, [work, other])).toEqual({ kind: 'conflicting' });
  expect(releaseWorkLink(true, [work, { kind: 'unknown' }])).toEqual({ kind: 'unknown' });
  expect(releaseWorkLink(true, [work, { kind: 'unavailable' }])).toEqual({ kind: 'unavailable' });
});

test('group and child cursors advance independently without treating previews as complete', async () => {
  const { source } = fixture();
  const first = await readReleaseGroups(source, request);
  expect(first.status).toBe('ready');
  const group = first.values[0]!;
  if (group.kind !== 'work') throw new Error('Expected work');
  expect(group.releases).toEqual(['a0']);
  expect(group.next).not.toBeNull();
  const children = await readReleaseChildren(source, request, 'a', group.next!);
  expect(children.values).toEqual(['a1', 'a2']);
  expect(children.next).toBeNull();
  const second = await readReleaseGroups(source, request, first.next!);
  expect(second.values.map((value) => value.id)).toEqual(['b']);
  expect(second.next).toBeNull();
  await expect(readReleaseChildren(source, request, 'b', group.next!)).rejects.toBeInstanceOf(
    ReleaseGroupingRestartRequired,
  );
});

test('only current matches with one proven canonical work can become children', async () => {
  const { source, releases } = fixture(7);
  releases.delete('a0'); // Native hydration rejected a current date/producer/disclosure predicate.
  const reasons = ['missing', 'unknown', 'conflicting', 'unavailable', 'unproven'] as const;
  reasons.forEach((kind, index) => releases.set(`a${index + 1}`, { card: `a${index + 1}`, link: { kind } }));
  const page = await readReleaseChildren(source, request, 'a');
  expect(page.values).toEqual(['a6']);
  expect(page.next).toBeNull();
  source.groups = async () => ({ keys: [{ kind: 'release', id: 'a3' }], after: '1', exhausted: true });
  expect((await readReleaseGroups(source, request)).values).toEqual([
    { kind: 'release', id: 'a3', release: 'a3', workLink: 'conflicting' },
  ]);
});

test('high fanout resumes bounded preparation and reaches explicit empty EOF', async () => {
  const { source, releases, calls } = fixture(100);
  releases.clear();
  let cursor: ReleaseGroupContinuation | undefined;
  let preparations = 0;
  for (let step = 0; step < 10; step++) {
    const start = calls.length;
    const page = await readReleaseGroups(source, request, cursor);
    expect(page.values).toEqual([]);
    expect(page.usage.seeks).toBe(calls.length - start);
    expect(page.usage.seeks).toBeLessThanOrEqual(RELEASE_GROUPING_LIMITS.seeks);
    expect(page.usage.keys).toBeLessThanOrEqual(RELEASE_GROUPING_LIMITS.keys);
    if (!page.next) {
      expect(page.status).toBe('ready');
      break;
    }
    expect(page.status).toBe('preparing');
    preparations++;
    cursor = page.next;
    if (step === 9) throw new Error('Preparation did not terminate');
  }
  expect(preparations).toBeGreaterThan(0);
});

test('every request meaning change retires either continuation before hydration', async () => {
  const { source, calls } = fixture();
  const first = await readReleaseGroups(source, request);
  const group = first.values[0]!;
  if (group.kind !== 'work') throw new Error('Expected work');
  const changes: Partial<ReleaseGroupingRequest>[] = [
    { languages: ['en', 'ja'] },
    { sort: 'relevance', text: 'edition' },
    { spoilerThreshold: 1 },
    { filter: { statement: { property: 'schema:datePublished', range: { type: 'time', gte: '2024-02-29' } } } },
    { filter: { statement: { property: 'schema:publisher', in: ['new-publisher'] } } },
    { groupLimit: 2 },
    { childLimit: 3 },
    { previewLimit: 2 },
  ];
  for (const patch of changes) {
    const start = calls.length;
    await expect(readReleaseGroups(source, { ...request, ...patch }, first.next!)).rejects.toBeInstanceOf(
      ReleaseGroupingRestartRequired,
    );
    await expect(readReleaseChildren(source, { ...request, ...patch }, 'a', group.next!)).rejects.toBeInstanceOf(
      ReleaseGroupingRestartRequired,
    );
    expect(calls.slice(start).map(({ method }) => method)).toEqual(['observe', 'observe']);
  }
});

test('a matching child beyond the first bounded window keeps its work in the group stream', async () => {
  const { source, releases } = fixture(100);
  for (let index = 0; index < 99; index++) releases.delete(`a${index}`);
  let cursor: ReleaseGroupContinuation | undefined;
  for (let step = 0; step < 5; step++) {
    const page = await readReleaseGroups(source, request, cursor);
    if (page.values.length) {
      expect(page.values[0]).toMatchObject({ kind: 'work', id: 'a', releases: ['a99'], next: null });
      expect((await readReleaseGroups(source, request, page.next!)).values[0]?.id).toBe('b');
      return;
    }
    expect(page.status).toBe('preparing');
    cursor = page.next!;
  }
  throw new Error('Lost the pending work');
});

test('active release, physical identity and current source changes retire both cursors', async () => {
  for (const patch of [
    { releaseDigest: 'next-release' },
    { epoch: 'disclosure-or-redirect-or-date-or-credit-change' },
    { physical: { ...physical, indexUuid: 'replacement' } },
    { physical: { ...physical, incarnation: 'replacement' } },
  ]) {
    const { source, change } = fixture();
    const first = await readReleaseGroups(source, request);
    const group = first.values[0]!;
    if (group.kind !== 'work') throw new Error('Expected work');
    change(patch);
    await expect(readReleaseGroups(source, request, first.next!)).rejects.toBeInstanceOf(
      ReleaseGroupingRestartRequired,
    );
    await expect(readReleaseChildren(source, request, 'a', group.next!)).rejects.toBeInstanceOf(
      ReleaseGroupingRestartRequired,
    );
  }
  const { source, change } = fixture();
  const read = source.releases;
  source.releases = async (...args) => {
    const values = await read(...args);
    change({ epoch: 'concurrent-change' });
    return values;
  };
  await expect(readReleaseGroups(source, request)).rejects.toBeInstanceOf(ReleaseGroupingRestartRequired);
});

test('precise ranges need readiness for this exact physical generation', async () => {
  const { source, change } = fixture();
  const precise = {
    ...request,
    filter: { statement: { property: 'schema:datePublished', range: { type: 'time' as const, gte: '2024-02-29' } } },
  };
  for (const calendarReadyFor of [null, { ...physical, indexUuid: 'other' }, { ...physical, generation: 2 }]) {
    change({ calendarReadyFor });
    await expect(readReleaseGroups(source, precise)).rejects.toBeInstanceOf(ReleaseGroupingUnavailable);
  }
  change({ calendarReadyFor: physical });
  expect((await readReleaseGroups(source, precise)).values).toHaveLength(1);
});

test('native overflow, duplicate children and nonadvancing seeks fail closed', async () => {
  for (const malformed of [
    { keys: ['a0', 'a0'], after: '2', exhausted: true },
    { keys: ['a0', 'a1', 'a2'], after: '3', exhausted: true },
    { keys: [], after: '0', exhausted: false },
  ]) {
    const { source } = fixture();
    source.children = async () => malformed;
    // An empty seek may first move from null to 0; repeating it must fail on the second seek.
    await expect(readReleaseChildren(source, request, 'a')).rejects.toBeInstanceOf(ReleaseGroupingUnavailable);
  }
});
