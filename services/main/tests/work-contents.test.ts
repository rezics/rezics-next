import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { WORK_CONTENTS_COST } from '../src/modules/work-contents/read-contract.ts';

import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects }
  from '../src/infrastructure/immutable-objects.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../src/modules/structure/format.ts';
import { CompositionCorrupt, CompositionUnavailable, orderTreeKey, type CompositionHeader }
  from '../src/modules/structure/graph.ts';
import { seekChapter } from '../src/modules/structure/reading-order.ts';
import { readCompositionPage, readCompositionSnapshot, type CompositionSnapshot }
  from '../src/modules/structure/read.ts';
import { newCost, StructureObjectCorrupt, StructureObjectUnavailable }
  from '../src/modules/structure/tree.ts';
import { WorkReadLimit, WorkReadSession } from '../src/modules/work/read-session.ts';
import { chapterStoryNumber } from '../src/modules/work-contents/read.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';


test('Reader routes expose bounded, typed Work contents and exact chapter bodies to web consumers', () => {
  const client = treaty<MainApp>('http://main.invalid');
  const typedReader = async () => {
    const page = await client.v1.works({ id: '00000000-0000-4000-8000-000000000001' }).contents.get({
      query: { language: 'en', limit: 2, parent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002' },
    });
    const next: string | null | undefined = page.data?.nextCursor;
    const occurrence: string | undefined = page.data?.items[0]?.occurrence;
    const chapter = await client.v1.chapters({ id: '00000000-0000-4000-8000-000000000003' }).get({
      query: { language: 'en', revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000004' },
    });
    const body: Record<string, any> | undefined = chapter.data?.content.body;
    const previous: string | null | undefined = chapter.data?.previous;
    const volume: 'volume' | 'part' | 'extras' | null | undefined = page.data?.items[0]?.division;
    const context: number | null | undefined = chapter.data?.parentPath[0]?.number;
    return { next, occurrence, body, previous, volume, context };
  };
  expect(typedReader).toBeFunction();
  expect(WORK_CONTENTS_COST).toEqual({ pageSize: 20, bodyBytes: 1024 * 1024,
    navigationCandidates: 20, navigationSteps: 256, legacyTitleBatch: 4, legacyTitleOwnerCalls: 5,
    numberingPlacements: 200, topGroups: 200 });
  const graph = new FusekiClient('http://127.0.0.1:1/rezics');
  const app = createMainApp(graph, { environment: { fuseki: graph,
    lineage: { dataEpoch: 'one', routingEpoch: 'one' }, objectDirectory: '.temp/work-contents' },
  account: {} as never, access: {} as never });
  const paths = app.routes.filter(route => route.method === 'GET').map(route => route.path);
  expect(paths).toContain('/v1/works/:id/contents');
  expect(paths).toContain('/v1/chapters/:id');
});


const chapterTestId = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const chapterTestBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** Counts actual immutable I/O, including repeated gets; no tree cost proxy or output LIMIT. */
class CountedChapterObjects implements ImmutableObjects {
  readonly values = new Map<string, Uint8Array>();
  gets = 0;
  bytes = 0;
  async put(bytes: Uint8Array): Promise<string> {
    const digest = createHash('sha256').update(bytes).digest('hex');
    this.values.set(digest, bytes.slice());
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    this.gets++;
    const bytes = this.values.get(digest);
    if (!bytes) throw new ObjectUnavailable('missing test immutable page');
    this.bytes += bytes.byteLength;
    if (createHash('sha256').update(bytes).digest('hex') !== digest) {
      throw new ObjectIntegrityError('test immutable page digest differs');
    }
    return bytes.slice();
  }
  reset() { this.gets = 0; this.bytes = 0; }
}

const placedChapterRecord = (n: number, parent: string, at: number,
  division?: 'volume' | 'part' | 'extras'): OccurrenceRecord => ({
  occurrence: chapterTestId(n), state: 'active', parent,
  segmentKey: 'a', orderKey: at.toString(36).padStart(8, '0'),
  role: division ? 'group' : 'chapter', labels: [{ value: `Placement ${n}`, language: 'en' }],
  introducedBy: chapterTestId(4),
  ...(division ? { qualifier: { type: 'book-group' as const, division } }
    : { target: chapterTestId(n + 100_000), selection: { mode: 'follow-context' as const } }),
});

async function chapterTreeFixture(records: OccurrenceRecord[]) {
  const objects = new CountedChapterObjects();
  const cost = newCost();
  const recordRoot = await recordTree(objects).apply(await recordTree(objects).empty(cost),
    new Map(records.map(record => [record.occurrence, record])), cost);
  const entries: OrderEntry[] = records.filter(record => record.state === 'active').map(record => ({
    occurrence: record.occurrence, parent: record.parent,
    segmentKey: record.segmentKey!, orderKey: record.orderKey!,
  }));
  const orderRoot = await orderTree(objects).apply(await orderTree(objects).empty(cost),
    new Map(entries.map(entry => [orderTreeKey(entry), entry])), cost);
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT,
    structure: chapterTestId(1), structureOf: chapterTestId(2), profile: 'book-composition',
    generation: chapterTestId(3), pageFormat: STRUCTURE_PAGE_FORMAT, records: recordRoot,
    order: orderRoot, placementCount: records.length, measures: [], model: STRUCTURE_PROFILE,
    shape: STRUCTURE_PROFILE };
  const digest = await objects.put(chapterTestBytes(manifest));
  const header: CompositionHeader = { structure: manifest.structure, component: manifest.structureOf,
    profile: 'book-composition', owner: chapterTestId(5), work: chapterTestId(5),
    mainVersion: manifest.structureOf, head: chapterTestId(4), generation: manifest.generation,
    placementCount: records.length, manifest: `urn:rezics:sha256:${digest}` };
  const graphQueries: string[] = [];
  const revisions = new Map([[header.head, { manifest: header.manifest, count: records.length }]]);
  const fuseki = { query: async (query: string) => {
    graphQueries.push(query);
    // Exact revision resolution is permitted; projection scans, computed sorts and aggregates fail.
    expect(query).not.toMatch(/OccurrencePlacement|OrderSegment|SUM\(|GROUP BY|CONCAT\(|ORDER BY/);
    const revision = [...revisions.keys()].find(id => query.includes(`<${id}> a rv:StructureRevision`));
    if (!revision || !query.includes(`rv:component <${header.structure}>`)) {
      throw new Error(`Unexpected graph population work: ${query}`);
    }
    const value = revisions.get(revision)!;
    return { results: { bindings: [{ manifest: { type: 'uri', value: value.manifest },
      count: { type: 'literal', value: String(value.count) },
      epoch: { type: 'literal', value: 'chapter-fixture' }, sequence: { type: 'literal', value: '7' } }] } };
  } } as unknown as FusekiClient;
  const env: WorkActivationEnvironment & { structureObjects: ImmutableObjects } = { fuseki,
    structureObjects: objects, lineage: { dataEpoch: 'chapter-fixture', routingEpoch: 'one' },
    objectDirectory: '.temp/chapter-seek' };
  const reset = () => { objects.reset(); graphQueries.splice(0); };
  const snapshot = () => readCompositionSnapshot(env, { structure: header.structure, header });
  const session = new WorkReadSession({ environment: env } as unknown as WorkReadSession['deps'],
    new Request('http://main.invalid'), {}, { dataEpoch: 'chapter-fixture', sequence: '7' });
  reset();
  return { objects, manifest, header, env, graphQueries, revisions, records, reset, snapshot, session };
}

async function populatedChapterFixture(chapters: number) {
  const root = chapterTestId(1);
  const volume = placedChapterRecord(10, root, 1, 'volume');
  const empty = Array.from({ length: 12 }, (_, i) => placedChapterRecord(11 + i, root, i + 2, 'part'));
  const part = placedChapterRecord(23, root, 14, 'part');
  const extras = placedChapterRecord(24, root, 15, 'extras');
  const end = placedChapterRecord(25, root, 16);
  const firstCount = Math.floor(chapters / 2);
  const volumeChapters = Array.from({ length: firstCount }, (_, i) => placedChapterRecord(1000 + i, volume.occurrence, i + 1));
  const partChapters = Array.from({ length: chapters - firstCount - 1 }, (_, i) =>
    placedChapterRecord(30_000 + i, part.occurrence, i + 1));
  const extra = placedChapterRecord(60_000, extras.occurrence, 1);
  const fixture = await chapterTreeFixture([volume, ...empty, part, extras, end, ...volumeChapters, ...partChapters, extra]);
  return { ...fixture, volume, empty, part, extras, end, volumeChapters, partChapters, extra };
}

const readableChapterTarget = async () => true;

for (const chapters of [1000, 5000, 10_000]) {
  test(`Chapter seeks and numbering read counted immutable neighbourhoods in a ${chapters} chapter Book`, async () => {
    const f = await populatedChapterFixture(chapters);
    const from = f.volumeChapters[100]!;
    const next = await seekChapter(f.env, { structure: f.header.structure, header: f.header,
      from, canReadTarget: readableChapterTarget });
    expect(next?.record.occurrence).toBe(f.volumeChapters[101]!.occurrence);
    expect(f.graphQueries).toHaveLength(1);
    expect(f.objects.gets).toBeLessThanOrEqual(35);
    expect(f.objects.bytes).toBeLessThan(1_200_000);
    f.reset();
    const previous = await seekChapter(f.env, { structure: f.header.structure, header: f.header,
      from, direction: 'previous', canReadTarget: readableChapterTarget });
    expect(previous?.record.occurrence).toBe(f.volumeChapters[99]!.occurrence);
    expect(f.graphQueries).toHaveLength(1);
    expect(f.objects.gets).toBeLessThanOrEqual(35);
    expect(f.objects.bytes).toBeLessThan(1_200_000);
    f.reset();
    const page = await readCompositionPage(f.env, { structure: f.header.structure, header: f.header,
      occurrence: f.partChapters[100]!.occurrence, limit: 1, canReadTarget: readableChapterTarget });
    f.reset();
    expect(await chapterStoryNumber(f.session, f.header, f.partChapters[100]!, page.occurrenceContext!))
      .toBe(f.volumeChapters.length + 101);
    expect(f.graphQueries).toHaveLength(1);
    expect(f.objects.gets).toBeLessThanOrEqual(100);
    expect(f.objects.bytes).toBeLessThan(4_000_000);
  });
}

test('Both chapter seek directions cross group boundaries and more than eight empty groups', async () => {
  const f = await populatedChapterFixture(1000);
  const forward = await seekChapter(f.env, { structure: f.header.structure, header: f.header,
    from: f.volumeChapters.at(-1), canReadTarget: readableChapterTarget });
  expect(forward?.record.occurrence).toBe(f.partChapters[0]!.occurrence);
  expect(f.graphQueries).toHaveLength(1);
  f.reset();
  const reverse = await seekChapter(f.env, { structure: f.header.structure, header: f.header,
    from: f.partChapters[0], direction: 'previous', canReadTarget: readableChapterTarget });
  expect(reverse?.record.occurrence).toBe(f.volumeChapters.at(-1)!.occurrence);
  expect(f.graphQueries).toHaveLength(1);
  const first = await seekChapter(f.env, { structure: f.header.structure, header: f.header,
    canReadTarget: readableChapterTarget });
  expect(first?.record.occurrence).toBe(f.volumeChapters[0]!.occurrence);
  expect(await seekChapter(f.env, { structure: f.header.structure, header: f.header,
    from: f.volumeChapters[0], direction: 'previous', canReadTarget: readableChapterTarget })).toBeNull();
  expect(await seekChapter(f.env, { structure: f.header.structure, header: f.header,
    from: f.end, canReadTarget: readableChapterTarget })).toBeNull();
});

test('Chapter seek advances denied and unacceptable neighbours and reports exhausted work honestly', async () => {
  const f = await populatedChapterFixture(1000);
  const denied = f.volumeChapters[1]!.target;
  const accepted: string[] = [];
  const result = await seekChapter(f.env, { structure: f.header.structure, header: f.header,
    from: f.volumeChapters[0], canReadTarget: async target => target !== denied,
    accept: async record => { accepted.push(record.occurrence); return record.occurrence !== f.volumeChapters[2]!.occurrence; } });
  expect(result?.record.occurrence).toBe(f.volumeChapters[3]!.occurrence);
  expect(accepted).not.toContain(f.volumeChapters[1]!.occurrence);
  expect(accepted).toContain(f.volumeChapters[2]!.occurrence);
  expect(f.graphQueries).toHaveLength(1);
  const reverse = await seekChapter(f.env, { structure: f.header.structure, header: f.header,
    from: f.volumeChapters[100], direction: 'previous',
    canReadTarget: async target => target !== f.volumeChapters[99]!.target,
    accept: async record => record.occurrence !== f.volumeChapters[98]!.occurrence });
  expect(reverse?.record.occurrence).toBe(f.volumeChapters[97]!.occurrence);
  await expect(seekChapter(f.env, { structure: f.header.structure, header: f.header,
    from: f.volumeChapters[0], canReadTarget: readableChapterTarget,
    checkDeadline: () => { throw new WorkReadLimit('test deadline exhausted'); } }))
    .rejects.toThrow('test deadline exhausted');
  await expect(seekChapter(f.env, { structure: f.header.structure, header: f.header,
    from: f.volumeChapters.at(-1), canReadTarget: readableChapterTarget, maxSteps: 8 }))
    .rejects.toBeInstanceOf(WorkReadLimit);
  await expect(seekChapter(f.env, { structure: f.header.structure, header: f.header,
    from: f.volumeChapters[0], canReadTarget: readableChapterTarget, accept: async () => false, maxSteps: 2 }))
    .rejects.toBeInstanceOf(WorkReadLimit);
});

test('Neighbour seeks preserve an exact fixed Content revision for the publication acceptance gate', async () => {
  const first = placedChapterRecord(1000, chapterTestId(1), 1);
  const second = placedChapterRecord(1001, chapterTestId(1), 2);
  second.selection = { mode: 'fixed-revision', revision: 'urn:rezics:content:revision:00000000-0000-4000-8000-000000000099' };
  const third = placedChapterRecord(1002, chapterTestId(1), 3);
  const f = await chapterTreeFixture([first, second, third]);
  const pins: Array<OccurrenceRecord['selection']> = [];
  const result = await seekChapter(f.env, { structure: f.header.structure, header: f.header, from: first,
    canReadTarget: readableChapterTarget, accept: async record => {
      pins.push(record.selection);
      return record.selection?.mode !== 'fixed-revision';
    } });
  expect(pins).toEqual([second.selection, third.selection]);
  expect(result?.record.occurrence).toBe(third.occurrence);
  expect(f.graphQueries).toHaveLength(1);
});

test('Exact historical chapter seeks reuse their revision when the current generation and counts differ', async () => {
  const f = await populatedChapterFixture(1000);
  const historical = f.header.head;
  const currentHeader = { ...f.header, head: chapterTestId(6), generation: chapterTestId(7),
    placementCount: 55_000, manifest: `urn:rezics:sha256:${'f'.repeat(64)}` };
  const snapshot = await readCompositionSnapshot(f.env, { structure: f.header.structure,
    header: currentHeader, revision: historical });
  expect(snapshot.revision).toBe(historical);
  f.reset();
  const result = await seekChapter(f.env, { structure: f.header.structure, snapshot,
    from: f.volumeChapters[10], canReadTarget: readableChapterTarget });
  expect(result?.record.occurrence).toBe(f.volumeChapters[11]!.occurrence);
  expect(result?.page.revision).toBe(historical);
  expect(f.graphQueries).toHaveLength(0);
  await expect(readCompositionPage(f.env, { structure: f.header.structure, snapshot,
    revision: currentHeader.head, limit: 1, canReadTarget: readableChapterTarget }))
    .rejects.toBeInstanceOf(CompositionUnavailable);
});

test('Reverse sibling pages preserve forward ordinals and exact continuation anchors', async () => {
  const f = await populatedChapterFixture(1000);
  const snapshot = await f.snapshot();
  const page = await readCompositionPage(f.env, { structure: f.header.structure, snapshot,
    parent: f.volume.occurrence, reverse: true, limit: 2, outline: true,
    canReadTarget: readableChapterTarget });
  expect(page.occurrences.map(record => record.occurrence)).toEqual(f.volumeChapters.slice(-2).reverse().map(record => record.occurrence));
  expect(page.offset).toBe(f.volumeChapters.length - 1);
  expect(page.siblingCount).toBe(f.volumeChapters.length);
  const continuation = await readCompositionPage(f.env, { structure: f.header.structure, snapshot,
    parent: f.volume.occurrence, reverse: true, after: page.next!, limit: 2, outline: true,
    canReadTarget: readableChapterTarget });
  expect(continuation.occurrences.map(record => record.occurrence)).toEqual(f.volumeChapters.slice(-4, -2).reverse().map(record => record.occurrence));
  expect(continuation.offset).toBe(f.volumeChapters.length - 3);
  const exact = await readCompositionPage(f.env, { structure: f.header.structure, snapshot,
    occurrence: f.volumeChapters.at(-1)!.occurrence, limit: 1, canReadTarget: readableChapterTarget });
  expect(exact.occurrenceContext?.ordinal).toBe(f.volumeChapters.length);
  expect(f.graphQueries).toHaveLength(1);
});

test('Story numbering includes volume and part children, excludes extras, and counts top-level chapters', async () => {
  const f = await populatedChapterFixture(1000);
  const snapshot = await f.snapshot();
  for (const [record, number] of [[f.volumeChapters[0]!, 1], [f.partChapters[0]!, f.volumeChapters.length + 1],
    [f.extra, null], [f.end, 1000]] as const) {
    const page = await readCompositionPage(f.env, { structure: f.header.structure, snapshot,
      occurrence: record.occurrence, limit: 1, canReadTarget: readableChapterTarget });
    expect(await chapterStoryNumber(f.session, f.header, record, page.occurrenceContext!, snapshot)).toBe(number);
  }
  expect(f.graphQueries).toHaveLength(1);
});

test('Books exceeding the physical top-level numbering budget return no invented chapter number', async () => {
  const records = Array.from({ length: 10_000 }, (_, i) => placedChapterRecord(i + 1000, chapterTestId(1), i + 1));
  const f = await chapterTreeFixture(records);
  const page = await readCompositionPage(f.env, { structure: f.header.structure, header: f.header,
    occurrence: records[0]!.occurrence, limit: 1, canReadTarget: readableChapterTarget });
  f.reset();
  expect(await chapterStoryNumber(f.session, f.header, records[0]!, page.occurrenceContext!)).toBeNull();
  expect(f.graphQueries).toHaveLength(1);
  expect(f.objects.gets).toBeLessThanOrEqual(12);
  expect(f.objects.bytes).toBeLessThan(500_000);
});

test('Missing, corrupt and order/record-mismatched immutable neighbourhoods fail explicitly', async () => {
  const f = await populatedChapterFixture(1000);
  const snapshot = await f.snapshot();
  const rootDigest = snapshot.manifest.order.page.slice(7);
  const original = f.objects.values.get(rootDigest)!;
  f.objects.values.delete(rootDigest);
  await expect(seekChapter(f.env, { structure: f.header.structure, snapshot,
    from: f.volumeChapters[0], canReadTarget: readableChapterTarget })).rejects.toBeInstanceOf(StructureObjectUnavailable);
  f.objects.values.set(rootDigest, chapterTestBytes({ invalid: true }));
  await expect(seekChapter(f.env, { structure: f.header.structure, snapshot,
    from: f.volumeChapters[0], canReadTarget: readableChapterTarget })).rejects.toBeInstanceOf(StructureObjectCorrupt);
  f.objects.values.set(rootDigest, original);
  const missingAnchorOrder = await orderTree(f.objects).apply(snapshot.manifest.order,
    new Map([[orderTreeKey(f.volumeChapters[0]! as OrderEntry), null]]), newCost());
  const missingAnchor: CompositionSnapshot = { ...snapshot, cost: newCost(),
    manifest: { ...snapshot.manifest, order: missingAnchorOrder } };
  await expect(seekChapter(f.env, { structure: f.header.structure, snapshot: missingAnchor,
    from: f.volumeChapters[0], canReadTarget: readableChapterTarget })).rejects.toBeInstanceOf(CompositionCorrupt);
  const missingRecordRoot = await recordTree(f.objects).apply(snapshot.manifest.records,
    new Map([[f.volumeChapters[1]!.occurrence, null]]), newCost());
  const missingRecord: CompositionSnapshot = { ...snapshot, cost: newCost(),
    manifest: { ...snapshot.manifest, records: missingRecordRoot } };
  await expect(seekChapter(f.env, { structure: f.header.structure, snapshot: missingRecord,
    from: f.volumeChapters[0], canReadTarget: readableChapterTarget })).rejects.toBeInstanceOf(StructureObjectCorrupt);
  const mismatched = { ...f.volumeChapters[1]!, orderKey: 'zzzzzzzz' };
  const cost = newCost();
  const records = await recordTree(f.objects).apply(snapshot.manifest.records,
    new Map([[mismatched.occurrence, mismatched]]), cost);
  const brokenSnapshot: CompositionSnapshot = { ...snapshot, cost: newCost(),
    manifest: { ...snapshot.manifest, records } };
  await expect(seekChapter(f.env, { structure: f.header.structure, snapshot: brokenSnapshot,
    from: f.volumeChapters[0], canReadTarget: readableChapterTarget })).rejects.toBeInstanceOf(StructureObjectCorrupt);
});
