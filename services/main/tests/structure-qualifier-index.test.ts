import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects }
  from '../src/infrastructure/immutable-objects.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { CompositionUnavailable, derivedId, orderTreeKey, type CompositionHeader }
  from '../src/modules/structure/graph.ts';
import { checkStructureManifest, STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT,
  STRUCTURE_PROFILE, type OccurrenceRecord, type StructureManifest }
  from '../src/modules/structure/format.ts';
import { newCost, StructureObjectCorrupt, StructureObjectUnavailable } from '../src/modules/structure/tree.ts';
import { type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

import { createQualifierKeyIndex, prepareQualifierKeyIndexBatch, qualifierKeyOf, qualifierKeyPrefix,
  qualifierKeyTree, qualifierSourceRoot, updateQualifierKeyIndex }
  from '../src/modules/structure/qualifier-index.ts';
import { WorkReadMoved } from '../src/modules/work/read-session.ts';
import { readCompositionOccurrenceByQualifierKey } from '../src/modules/structure/read.ts';

const id = (name: string) => derivedId(`qualifier-key:${name}`);
const structure = id('structure'), zone = id('zone'), generation = id('generation');
const revision = id('revision');
type LegacyManifest = Extract<StructureManifest, { format: 'rezics-structure-manifest-v1' }>;
type IndexedManifest = Extract<StructureManifest, { format: 'rezics-structure-manifest-v2' }>;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function memoryObjects() {
  const retained = new Map<string, Uint8Array>();
  const reads: Array<{ digest: string; bytes: number; tree?: string }> = [];
  const objects: ImmutableObjects = {
    put: async bytes => {
      const digest = createHash('sha256').update(bytes).digest('hex');
      retained.set(digest, bytes.slice()); return digest;
    },
    get: async digest => {
      const bytes = retained.get(digest);
      if (!bytes) throw new ObjectUnavailable('Missing retained test object');
      if (createHash('sha256').update(bytes).digest('hex') !== digest) {
        throw new ObjectIntegrityError('Retained test object differs from its digest');
      }
      reads.push({ digest, bytes: bytes.length, tree: JSON.parse(new TextDecoder().decode(bytes)).tree });
      return bytes.slice();
    },
  };
  return { objects, retained, reads, reset: () => { reads.length = 0; } };
}

function mount(name: string, routeSegment: string, overrides: Partial<OccurrenceRecord> = {}): OccurrenceRecord {
  return { occurrence: id(`occurrence:${name}`), state: 'active', parent: structure,
    segmentKey: 'a', orderKey: name.replace(/[^a-z0-9]/g, '') || 'a', role: 'mount',
    target: id(`target:${name}`), labels: [], introducedBy: revision,
    qualifier: { type: 'zone-mount', zone, routeSegment, disclosure: 'public' }, ...overrides };
}

async function manifestFor(objects: ImmutableObjects, records: readonly OccurrenceRecord[],
  selectedGeneration = generation): Promise<LegacyManifest> {
  const cost = newCost(), recordsTree = recordTree(objects), ordered = orderTree(objects);
  const active = records.filter(record => record.state === 'active');
  return { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: zone, profile: 'zone-navigation',
    generation: selectedGeneration, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordsTree.apply(await recordsTree.empty(cost),
      new Map(records.map(record => [record.occurrence, record])), cost),
    order: await ordered.apply(await ordered.empty(cost), new Map(active.map(record => {
      const entry = { parent: record.parent, segmentKey: record.segmentKey!, orderKey: record.orderKey!,
        occurrence: record.occurrence };
      return [orderTreeKey(entry), entry];
    })), cost), placementCount: active.length, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
}

test('ordinary retained manifests preserve their serialized bytes without qualifier coverage', async () => {
  const store = memoryObjects();
  const original = await manifestFor(store.objects, [mount('legacy', 'legacy')]);
  const bytes = encode(original), digest = await store.objects.put(bytes);
  expect(encode(checkStructureManifest(await store.objects.get(digest)))).toEqual(bytes);
  expect(original).not.toHaveProperty('qualifierKeys');
  const cost = newCost();
  expect((await recordTree(store.objects).lookup(original.records, [id('occurrence:legacy')], cost))
    .get(id('occurrence:legacy'))).toEqual(mount('legacy', 'legacy'));
  expect(cost.pagesRead).toBe(original.records.level + 1);
});

async function indexed(objects: ImmutableObjects, manifest: StructureManifest,
  records: readonly OccurrenceRecord[]): Promise<IndexedManifest> {
  return { ...manifest, format: 'rezics-structure-manifest-v2',
    qualifierKeys: await createQualifierKeyIndex(objects, manifest, records, newCost()) };
}

async function fixture(records: readonly OccurrenceRecord[]) {
  const store = memoryObjects(), revisions = new Map<string, StructureManifest>();
  const root = await indexed(store.objects, await manifestFor(store.objects, records), records);
  revisions.set(revision, root);
  let current = revision;
  const header = async (): Promise<CompositionHeader> => {
    const manifest = revisions.get(current)!;
    return { structure, profile: 'zone-navigation', owner: zone, component: zone,
      mainVersion: zone, work: zone, head: current, generation: manifest.generation,
      placementCount: manifest.placementCount, manifest: `urn:rezics:sha256:${await store.objects.put(encode(manifest))}` };
  };
  const environment = { structureObjects: store.objects, fuseki: { query: async (query: string) => {
    expect(query).toContain('SELECT ?manifest');
    expect(query).not.toContain('?order');
    const selected = [...revisions.keys()].find(value => query.includes(`<${value}> a rv:StructureRevision`));
    if (!selected) throw new Error('Unexpected immutable revision query');
    const manifest = revisions.get(selected)!;
    const binding = (value: string) => ({ type: 'literal', value });
    return { results: { bindings: [{ manifest: binding(`urn:rezics:sha256:${await store.objects.put(encode(manifest))}`),
      count: binding(String(manifest.placementCount)), epoch: binding(id('epoch')), sequence: binding(selected === revision ? '7' : '8') }] } };
  } } } as unknown as WorkActivationEnvironment;
  const lookup = async (routeSegment: string, input: Partial<Parameters<typeof readCompositionOccurrenceByQualifierKey>[1]> = {}) => {
    const selectedHeader = await header();
    store.reset();
    return readCompositionOccurrenceByQualifierKey(environment, {
      structure, key: { type: 'zone-mount', zone, routeSegment }, header: selectedHeader,
      canReadOwner: async () => true, canReadTarget: async () => true, ...input,
    });
  };
  return { ...store, root, revisions, lookup, setCurrent: (value: string) => { current = value; } };
}

test('retained qualifier hit and exact miss read tree paths while unrelated placements grow', async () => {
  for (const size of [100, 1000, 10000]) {
    const sought = mount('selected', 'selected');
    const records = [sought, ...Array.from({ length: size }, (_, index) => mount(`unrelated${index}`, `unrelated-${index}`))];
    const f = await fixture(records);
    for (const exact of [false, true]) for (const segment of ['selected', 'absent']) {
      const result = await f.lookup(segment, exact ? { revision } : {});
      expect(result.outcome).toBe(segment === 'selected' ? 'found' : 'missing');
      expect(result.occurrences).toEqual(segment === 'selected' ? [sought] : []);
      expect(result.sourcePosition).toEqual({ datasetId: 'product', dataEpoch: id('epoch'), sequence: '7' });
      expect(result).not.toHaveProperty('placementCount');
      expect(result).not.toHaveProperty('next');
      expect(f.reads.some(read => read.tree === 'order')).toBe(false);
      expect(f.reads.length).toBeLessThanOrEqual(1 + 2 * (f.root.qualifierKeys!.root.level + 1)
        + (segment === 'selected' ? f.root.records.level + 1 : 0));
      expect(result.cost.pagesRead).toBe(f.reads.length);
      expect(f.reads.reduce((sum, read) => sum + read.bytes, 0)).toBeLessThan(750_000);
    }
  }
});

test('only active immutable Zone mount qualifiers produce source keys', () => {
  const active = mount('active', 'active');
  expect(qualifierKeyOf(active)).toEqual({ type: 'zone-mount', zone, routeSegment: 'active' });
  expect(qualifierKeyOf({ ...active, state: 'removed', segmentKey: undefined, orderKey: undefined,
    removedBy: revision })).toBeNull();
  expect(qualifierKeyOf({ ...active, role: 'group', target: undefined, qualifier: undefined })).toBeNull();
  expect(qualifierKeyOf({ ...active, role: 'part', qualifier: {
    type: 'work-part', displayLabel: '0.5 special', inclusion: 'extra',
  } })).toBeNull();
  expect(qualifierKeyPrefix({ type: 'zone-mount', zone, routeSegment: 'a' }))
    .not.toBe(qualifierKeyPrefix({ type: 'zone-mount', zone, routeSegment: 'a-b' }));
});

test('key mutation and removal preserve exact retained lookups while current postings change', async () => {
  const before = mount('selected', 'old');
  const f = await fixture([before]);
  const after = { ...before, qualifier: { type: 'zone-mount' as const, zone, routeSegment: 'new', disclosure: 'public' as const } };
  const changedSource = await manifestFor(f.objects, [after], id('changed-generation'));
  const changed: IndexedManifest = { ...changedSource, format: 'rezics-structure-manifest-v2',
    qualifierKeys: (await updateQualifierKeyIndex(f.objects, f.root, changedSource, [{ before, after }], newCost()))! };
  f.revisions.set(id('changed-revision'), changed); f.setCurrent(id('changed-revision'));
  expect((await f.lookup('old')).outcome).toBe('missing');
  expect((await f.lookup('new')).occurrences).toEqual([after]);
  expect((await f.lookup('old', { revision })).occurrences).toEqual([before]);
  expect((await f.lookup('new', { revision })).outcome).toBe('missing');
  const removed: OccurrenceRecord = { ...after, state: 'removed', segmentKey: undefined,
    orderKey: undefined, removedBy: id('remove-revision') };
  const removedSource = await manifestFor(f.objects, [removed], id('removed-generation'));
  const removedManifest: IndexedManifest = { ...removedSource, format: 'rezics-structure-manifest-v2',
    qualifierKeys: (await updateQualifierKeyIndex(f.objects, changed, removedSource,
      [{ before: after, after: removed }], newCost()))! };
  f.revisions.set(id('remove-revision'), removedManifest); f.setCurrent(id('remove-revision'));
  expect((await f.lookup('new')).outcome).toBe('missing');
  expect((await f.lookup('new', { revision: id('changed-revision') })).occurrences).toEqual([after]);
  const replacement = await indexed(f.objects, await manifestFor(f.objects, [before], id('replacement-generation')), [before]);
  f.revisions.set(id('replace-revision'), replacement); f.setCurrent(id('replace-revision'));
  expect((await f.lookup('old')).occurrences).toEqual([before]);
  expect((await f.lookup('new')).outcome).toBe('missing');
});

test('disclosed duplicates decide ambiguity without hidden counts or private target authority', async () => {
  const publicMount = mount('public', 'duplicate');
  const privateMount = mount('private', 'duplicate', { qualifier: {
    type: 'zone-mount', zone, routeSegment: 'duplicate', disclosure: 'private',
  } });
  const deniedTarget = mount('denied', 'duplicate');
  const f = await fixture([publicMount, privateMount, deniedTarget]);
  const visible = (record: OccurrenceRecord) => record.qualifier?.type === 'zone-mount'
    && record.qualifier.disclosure === 'public';
  const targetCalls: string[] = [];
  const result = await f.lookup('duplicate', { visible, canReadTarget: async target => {
    targetCalls.push(target); return target !== deniedTarget.target;
  } });
  expect(result.outcome).toBe('found'); expect(result.occurrences).toEqual([publicMount]);
  expect(targetCalls).not.toContain(privateMount.target!);
  expect(result).not.toHaveProperty('placementCount'); expect(result).not.toHaveProperty('next');
  const ambiguous = await f.lookup('duplicate', { visible });
  expect(ambiguous.outcome).toBe('ambiguous'); expect(ambiguous.occurrences).toHaveLength(2);
  expect(new Set(ambiguous.occurrences.map(record => record.occurrence)))
    .toEqual(new Set([publicMount.occurrence, deniedTarget.occurrence]));
  expect((await f.lookup('duplicate', { visible, canReadTarget: async () => false })).outcome).toBe('missing');
  expect((await f.lookup('duplicate', { visible: () => false })).outcome).toBe('missing');
});

test('current rights and owner fences still apply to an exact immutable key lookup', async () => {
  const record = mount('selected', 'selected'), f = await fixture([record]);
  let ownerCalls = 0;
  await expect(f.lookup('selected', { revision, canReadOwner: async () => ++ownerCalls === 1 }))
    .rejects.toBeInstanceOf(CompositionUnavailable);
  expect(ownerCalls).toBe(2);
  let targetCalls = 0;
  await expect(f.lookup('selected', { revision, canReadTarget: async () => ++targetCalls === 1 }))
    .rejects.toBeInstanceOf(WorkReadMoved);
  expect(targetCalls).toBe(2);
  expect((await f.lookup('selected', { revision, canReadTarget: async () => false })).outcome).toBe('missing');
  ownerCalls = 0;
  await expect(f.lookup('absent', { canReadOwner: async () => ++ownerCalls === 1 }))
    .rejects.toBeInstanceOf(CompositionUnavailable);
  expect(ownerCalls).toBe(2);
});

test('missing legacy coverage is unavailable and maintenance cannot invent a complete empty root', async () => {
  const f = await fixture([mount('legacy', 'legacy')]);
  const { qualifierKeys: _coverage, ...legacy } = f.root;
  const legacyRoot: LegacyManifest = { ...legacy, format: STRUCTURE_MANIFEST_FORMAT };
  f.revisions.set(revision, legacyRoot);
  expect(await updateQualifierKeyIndex(f.objects, legacyRoot, legacyRoot, [], newCost())).toBeUndefined();
  for (const segment of ['legacy', 'absent']) {
    await expect(f.lookup(segment)).rejects.toBeInstanceOf(StructureObjectUnavailable);
    expect(f.reads.some(read => read.tree === 'order')).toBe(false);
  }
});

test('source coverage binds the exact records root before reporting an empty key result', async () => {
  const f = await fixture([mount('selected', 'selected')]);
  expect(f.root.qualifierKeys!.sourceRoot).toBe(qualifierSourceRoot(f.root));
  const different = await manifestFor(f.objects, [mount('other', 'other')]);
  f.revisions.set(revision, { ...f.root, records: different.records });
  await expect(f.lookup('absent')).rejects.toBeInstanceOf(StructureObjectCorrupt);
  expect(f.reads.some(read => read.tree === 'order')).toBe(false);
});

test('missing and corrupt retained key objects fail without falling back to the order tree', async () => {
  for (const failure of ['missing', 'corrupt'] as const) {
    const f = await fixture([mount('selected', 'selected')]);
    const digest = f.root.qualifierKeys!.root.page.slice(7);
    if (failure === 'missing') f.retained.delete(digest);
    else f.retained.set(digest, encode({ altered: true }));
    for (const segment of ['selected', 'absent']) {
      await expect(f.lookup(segment)).rejects.toBeInstanceOf(failure === 'missing'
        ? StructureObjectUnavailable : StructureObjectCorrupt);
      expect(f.reads.some(read => read.tree === 'order')).toBe(false);
    }
  }
});

test('a posting is a candidate and cannot override authoritative immutable occurrence qualifiers', async () => {
  const actual = mount('selected', 'actual'), f = await fixture([actual]);
  const tree = qualifierKeyTree(f.objects);
  const originalKey = `${qualifierKeyPrefix({ type: 'zone-mount', zone, routeSegment: 'actual' })}${actual.occurrence}`;
  const forgedKey = `${qualifierKeyPrefix({ type: 'zone-mount', zone, routeSegment: 'spoof' })}${actual.occurrence}`;
  const forgedRoot = await tree.apply(f.root.qualifierKeys.root, new Map<string, { key: string; occurrence: string } | null>([
    [originalKey, null], [forgedKey, { key: forgedKey, occurrence: actual.occurrence }],
  ]), newCost());
  f.revisions.set(revision, { ...f.root, qualifierKeys: { ...f.root.qualifierKeys, root: forgedRoot } });
  await expect(f.lookup('spoof')).rejects.toBeInstanceOf(StructureObjectCorrupt);
  expect(f.reads.some(read => read.tree === 'order')).toBe(false);
});

test('bounded record preparation resumes exact source coverage after reopening the immutable store', async () => {
  const store = memoryObjects();
  const records = Array.from({ length: 1025 }, (_, index) => mount(`prepare${index}`, `prepare-${index}`));
  const manifest = await manifestFor(store.objects, records);
  let result = await prepareQualifierKeyIndexBatch(store.objects, manifest);
  expect(result.complete).toBe(false); expect(result.index).toBeUndefined();
  expect(result.progress.visited).toBe(256);
  const savedProgress = JSON.stringify(result.progress), sourcePage = manifest.records.page.slice(7);
  const retainedPage = store.retained.get(sourcePage)!;
  store.retained.delete(sourcePage);
  await expect(prepareQualifierKeyIndexBatch(store.objects, manifest, result.progress))
    .rejects.toBeInstanceOf(StructureObjectUnavailable);
  expect(JSON.stringify(result.progress)).toBe(savedProgress);
  store.retained.set(sourcePage, retainedPage);
  let turns = 1;
  while (!result.complete) {
    store.reset();
    const saved = JSON.parse(JSON.stringify(result.progress));
    const reopened: ImmutableObjects = { put: bytes => store.objects.put(bytes), get: digest => store.objects.get(digest) };
    const cost = newCost();
    const resumed = await prepareQualifierKeyIndexBatch(reopened, manifest, saved, cost);
    expect(resumed.progress.visited - saved.visited).toBeLessThanOrEqual(256);
    expect(store.reads.some(read => read.tree === 'order')).toBe(false);
    expect(cost.pagesRead).toBe(store.reads.length);
    result = resumed; turns++;
    expect(turns).toBeLessThan(10);
  }
  expect(turns).toBe(5); expect(result.progress.visited).toBe(records.length);
  expect(result.index!.sourceRoot).toBe(qualifierSourceRoot(manifest));
  expect(result.index!.root.count).toBe(records.length);
  const tree = qualifierKeyTree(store.objects);
  const prefix = qualifierKeyPrefix({ type: 'zone-mount', zone, routeSegment: 'prepare-1024' });
  const candidate = await tree.range(result.index!.root, prefix, `${prefix}\uffff`, 2, newCost());
  expect(candidate.map(entry => entry.occurrence)).toEqual([records[1024]!.occurrence]);
  const changed = await manifestFor(store.objects, [mount('changed', 'changed')]);
  await expect(prepareQualifierKeyIndexBatch(store.objects, changed, result.progress))
    .rejects.toBeInstanceOf(StructureObjectCorrupt);
});

test('hidden duplicate exhaustion cannot manufacture an empty result', async () => {
  const records = Array.from({ length: 4097 }, (_, index) => mount(`hidden${index}`, 'hidden-duplicate', {
    qualifier: { type: 'zone-mount', zone, routeSegment: 'hidden-duplicate', disclosure: 'private' },
  }));
  const f = await fixture(records);
  await expect(f.lookup('hidden-duplicate', { visible: () => false }))
    .rejects.toBeInstanceOf(StructureObjectUnavailable);
  expect(f.reads.some(read => read.tree === 'order')).toBe(false);
  expect(f.reads.length).toBeLessThan(160);
  expect(f.reads.reduce((sum, read) => sum + read.bytes, 0)).toBeLessThan(4 * 1024 * 1024);
});

test('construction and maintenance reject fabricated source records before asserting coverage', async () => {
  const original = mount('selected', 'actual'), f = await fixture([original]);
  const fabricated = { ...original, qualifier: { type: 'zone-mount' as const, zone,
    routeSegment: 'fabricated', disclosure: 'public' as const } };
  await expect(createQualifierKeyIndex(f.objects, f.root, [fabricated], newCost()))
    .rejects.toBeInstanceOf(StructureObjectCorrupt);
  await expect(createQualifierKeyIndex(f.objects, f.root, [{ ...original, occurrence: id('absent-source') }], newCost()))
    .rejects.toBeInstanceOf(StructureObjectCorrupt);
  await expect(createQualifierKeyIndex(f.objects, f.root, [], newCost()))
    .rejects.toBeInstanceOf(StructureObjectCorrupt);
  const next = await manifestFor(f.objects, [fabricated], id('next-generation'));
  await expect(updateQualifierKeyIndex(f.objects, f.root, next, [{ before: original,
    after: { ...fabricated, occurrence: id('absent-source') } }], newCost()))
    .rejects.toBeInstanceOf(StructureObjectCorrupt);
  await expect(updateQualifierKeyIndex(f.objects, f.root, next,
    [{ before: fabricated, after: fabricated }], newCost())).rejects.toBeInstanceOf(StructureObjectCorrupt);
});

test('identical route segments in a different immutable Zone qualifier do not collide', async () => {
  const matching = mount('matching', 'shared');
  const other = mount('otherzone', 'shared', { qualifier: {
    type: 'zone-mount', zone: id('other-zone'), routeSegment: 'shared', disclosure: 'public',
  } });
  const f = await fixture([matching, other]);
  const found = await f.lookup('shared');
  expect(found.outcome).toBe('found'); expect(found.occurrences).toEqual([matching]);
  expect(f.reads.some(read => read.tree === 'order')).toBe(false);
});

test('disclosed key candidates remain scoped to the selected immutable parent', async () => {
  const group = mount('group', 'unused', { role: 'group', target: undefined, qualifier: undefined });
  const top = mount('top', 'shared'), nested = mount('nested', 'shared', { parent: group.occurrence });
  const f = await fixture([group, top, nested]);
  expect((await f.lookup('shared')).occurrences).toEqual([top]);
  expect((await f.lookup('shared', { parent: group.occurrence })).occurrences).toEqual([nested]);
  expect((await f.lookup('absent', { parent: group.occurrence })).outcome).toBe('missing');
  await expect(f.lookup('absent', { parent: id('unknown-parent') })).rejects.toBeInstanceOf(CompositionUnavailable);
  expect(f.reads.some(read => read.tree === 'order')).toBe(false);
});

test('single-key write maintenance copies bounded paths as unrelated qualifiers grow', async () => {
  for (const size of [100, 1000, 10000]) {
    const original = mount('selected', 'selected');
    const unrelated = Array.from({ length: size }, (_, index) => mount(`write${index}`, `write-${index}`));
    const f = await fixture([original, ...unrelated]);
    const changed = { ...original, qualifier: { type: 'zone-mount' as const, zone,
      routeSegment: 'changed', disclosure: 'public' as const } };
    const source = await manifestFor(f.objects, [changed, ...unrelated], id('write-generation'));
    f.reset();
    const cost = newCost();
    const coverage = (await updateQualifierKeyIndex(f.objects, f.root, source,
      [{ before: original, after: changed }], cost))!;
    expect(coverage.sourceRoot).toBe(qualifierSourceRoot(source));
    expect(coverage.root.count).toBe(size + 1);
    expect(f.reads.some(read => read.tree === 'order')).toBe(false);
    expect(cost.pagesRead).toBe(f.reads.length);
    expect(cost.pagesRead).toBeLessThanOrEqual(2 * (f.root.records.level + 1)
      + 2 * (f.root.qualifierKeys.root.level + 1) + 2);
    expect(cost.pagesWritten).toBeLessThanOrEqual(2 * (f.root.qualifierKeys.root.level + 1) + 2);
    expect(f.reads.reduce((sum, read) => sum + read.bytes, 0)).toBeLessThan(2 * 1024 * 1024);
    f.revisions.set(id('write-revision'), { ...source, format: 'rezics-structure-manifest-v2', qualifierKeys: coverage });
    f.setCurrent(id('write-revision'));
    expect((await f.lookup('selected')).outcome).toBe('missing');
    expect((await f.lookup('changed')).occurrences).toEqual([changed]);
    expect((await f.lookup('selected', { revision })).occurrences).toEqual([original]);
  }
});

test('preparation cannot claim exact EOF when the source record count is incomplete', async () => {
  const store = memoryObjects(), original = await manifestFor(store.objects, [mount('source', 'source')]);
  const inconsistent = { ...original, records: { ...original.records, count: original.records.count + 1 } };
  await expect(prepareQualifierKeyIndexBatch(store.objects, inconsistent)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  const truncated = { ...original, records: { ...original.records, count: 0 } };
  await expect(prepareQualifierKeyIndexBatch(store.objects, truncated)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  await expect(createQualifierKeyIndex(store.objects, truncated, [], newCost())).rejects.toBeInstanceOf(StructureObjectCorrupt);
});
