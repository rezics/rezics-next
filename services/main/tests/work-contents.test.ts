import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { workContentsRoutes } from '../src/routes/work-contents.ts';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ContentCore } from '../../content/src/core.ts';
import { RightsStore } from '../src/modules/rights/store.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { disclosureContent } from '../src/modules/disclosure/assembly.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { createMainApp } from '../src/app.ts';
import { FusekiClient, FusekiHttpError } from '../src/infrastructure/fuseki.ts';
import { WORK_CONTENTS_COST } from '../src/modules/work-contents/read-contract.ts';

import { ObjectIntegrityError, ObjectNotFound, ObjectUnavailable, type ImmutableObjects }
  from '../src/infrastructure/immutable-objects.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../src/modules/structure/format.ts';
import { CompositionCorrupt, CompositionUnavailable, orderTreeKey, readCompositionHeader, type CompositionHeader }
  from '../src/modules/structure/graph.ts';
import { seekChapter } from '../src/modules/structure/reading-order.ts';
import { readCompositionPage, readCompositionSnapshot, type CompositionSnapshot }
  from '../src/modules/structure/read.ts';
import { newCost, StructureObjectCorrupt, StructureObjectUnavailable }
  from '../src/modules/structure/tree.ts';
import { WorkReadLimit, WorkReadMissing, WorkReadMoved, WorkReadSession, WorkReadUnavailable }
  from '../src/modules/work/read-session.ts';
import { readWorkBasis } from '../src/modules/work/read-header.ts';
import { chapterStoryNumber, readChapter, readContents } from '../src/modules/work-contents/read.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
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
    topGroups: 200 });
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
    if (!bytes) throw new ObjectNotFound('missing test immutable page');
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

async function chapterTreeFixture(records: OccurrenceRecord[], includeTopGroups = true,
  profile: 'book-composition' | 'work-composition' | 'recipe-composition' = 'book-composition') {
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
  const groupOccurrences = new Set(records.filter(record => record.state === 'active'
    && record.role === 'group' && record.parent === chapterTestId(1)).map(record => record.occurrence));
  const groupEntries = entries.filter(entry => groupOccurrences.has(entry.occurrence));
  const topGroups = includeTopGroups ? await orderTree(objects).apply(await orderTree(objects).empty(cost),
    new Map(groupEntries.map(entry => [orderTreeKey(entry), entry])), cost) : undefined;
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT,
    structure: chapterTestId(1), structureOf: chapterTestId(2), profile,
    generation: chapterTestId(3), pageFormat: STRUCTURE_PAGE_FORMAT, records: recordRoot,
    order: orderRoot, ...(topGroups ? { topGroups } : {}),
    placementCount: records.length, measures: [], model: STRUCTURE_PROFILE,
    shape: STRUCTURE_PROFILE };
  const digest = await objects.put(chapterTestBytes(manifest));
  const header: CompositionHeader = { structure: manifest.structure, component: manifest.structureOf,
    profile, owner: chapterTestId(5), work: chapterTestId(5),
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

test('Work parts retain all thousand occurrence identities with bounded I/O at larger stored populations', async () => {
  for (const size of [1000, 10_000]) {
    const records: OccurrenceRecord[] = Array.from({ length: size }, (_, index) => ({
      occurrence: chapterTestId(1000 + index), state: 'active', parent: chapterTestId(1),
      segmentKey: 'a', orderKey: index.toString(36).padStart(8, '0'), role: 'part',
      target: chapterTestId(100_000 + index % 4), labels: [{ value: `Episode ${index + 1}`, language: 'en' }],
      introducedBy: chapterTestId(4), qualifier: { type: 'work-part', displayLabel: `Episode ${index + 1}`,
        inclusion: 'required' },
    }));
    const f = await chapterTreeFixture(records, true, 'work-composition');
    const snapshot = await f.snapshot();
    const seen: string[] = [];
    let after: string | undefined;
    do {
      f.objects.reset();
      const page = await readCompositionPage(f.env, { structure: f.header.structure, header: f.header,
        snapshot, parent: f.header.structure, limit: WORK_CONTENTS_COST.pageSize,
        ...(after ? { after } : {}), outline: true, canReadTarget: readableChapterTarget });
      expect(f.objects.gets).toBeLessThanOrEqual(64);
      expect(f.objects.bytes).toBeLessThanOrEqual(WORK_CONTENTS_COST.bodyBytes);
      expect(page.occurrences.every(record => record.role === 'part' && !record.selection)).toBe(true);
      expect(page.childCounts).toBeUndefined();
      expect(page.placementCount).toBe(0); // Physical counts are withheld by this profile.
      seen.push(...page.occurrences.map(record => record.occurrence));
      after = page.next ?? undefined;
      if (size > 1000) break; // Same page bound with ten times as much stored inventory.
    } while (after);
    expect(seen).toEqual(records.slice(0, size === 1000 ? size : WORK_CONTENTS_COST.pageSize)
      .map(record => record.occurrence));
    expect(new Set(seen).size).toBe(seen.length);
    if (size === 1000) expect(after).toBeUndefined();
    expect(f.graphQueries).toHaveLength(1);
  }
});

test('Work part continuation withholds hidden and absent targets without losing repeated readable uses', async () => {
  const root = chapterTestId(1);
  const readable = chapterTestId(20);
  const hidden = chapterTestId(21);
  const absent = chapterTestId(22);
  const records: OccurrenceRecord[] = [readable, hidden, absent, readable].map((target, index) => ({
    occurrence: chapterTestId(100 + index), state: 'active', parent: root, role: 'part', target,
    segmentKey: 'a', orderKey: (index + 1).toString(36).padStart(8, '0'),
    labels: [{ value: `Use ${index + 1}`, language: 'en' }], introducedBy: chapterTestId(4),
    qualifier: { type: 'work-part', displayLabel: `Use ${index + 1}`, inclusion: 'optional' },
  }));
  const f = await chapterTreeFixture(records, true, 'work-composition');
  const snapshot = await f.snapshot();
  const read = (after?: string) => readCompositionPage(f.env, { structure: root, header: f.header,
    snapshot, parent: root, limit: 1, outline: true, ...(after ? { after } : {}),
    canReadTarget: async target => target === readable,
    canReadTargets: async targets => new Set(targets.filter(target => target === readable)),
  });
  const first = await read();
  expect(first.occurrences.map(record => record.occurrence)).toEqual([records[0]!.occurrence]);
  expect(first.next).not.toBeNull();
  const second = await read(first.next!);
  expect(second.occurrences.map(record => record.occurrence)).toEqual([records[3]!.occurrence]);
  expect(second.occurrences[0]).toMatchObject({ role: 'part', target: readable,
    qualifier: { type: 'work-part', displayLabel: 'Use 4', inclusion: 'optional' } });
  expect(second.next).toBeNull();
  expect(first.placementCount).toBe(0);
  expect(second.placementCount).toBe(0);
});

test('Catalog and concealed native chapters retain bounded ordered inventory positions', async () => {
  const root = chapterTestId(1);
  const catalogTargets = structureProfileFor('book-composition').catalogTargetTypes!;
  const records = [placedChapterRecord(10, root, 1), placedChapterRecord(11, root, 2),
    ...catalogTargets.map((target, index) => {
      const { selection: _selection, ...record } = placedChapterRecord(12 + index, root, 3 + index);
      return { ...record, target };
    })];
  const fixture = await chapterTreeFixture(records);
  const targetReads: string[] = [];
  const page = await readCompositionPage(fixture.env, { structure: fixture.header.structure,
    header: fixture.header, parent: root, limit: records.length, outline: true,
    canReadTarget: async target => {
      targetReads.push(target);
      // Both an absent target and a hidden target have no disclosed native identity.
      return false;
    } });
  expect(targetReads).toEqual(records.slice(0, 2).map(record => record.target!));
  expect(page.occurrences.map(record => record.occurrence)).toEqual(records.map(record => record.occurrence));
  expect(page.occurrences.slice(0, 2)).toMatchObject([{ labels: [] }, { labels: [] }]);
  for (const record of page.occurrences.slice(0, 2)) {
    expect(record.target).toBeUndefined();
    expect(record.selection).toBeUndefined();
  }
  expect(page.occurrences.slice(2).map(record => record.target)).toEqual([...catalogTargets]);
  expect(page.occurrences.slice(2).map(record => record.labels)).toEqual(records.slice(2).map(record => record.labels));
  expect(page.next).toBeNull();
  expect(page.offset).toBe(0);
  expect(fixture.graphQueries).toHaveLength(1);
  expect(fixture.objects.gets).toBeLessThanOrEqual(12);
});

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
  const historicalChapter = f.partChapters[100]!;
  const historicalPage = await readCompositionPage(f.env, { structure: f.header.structure, snapshot,
    occurrence: historicalChapter.occurrence, limit: 1, canReadTarget: readableChapterTarget });
  expect(await chapterStoryNumber(f.session, currentHeader, historicalChapter,
    historicalPage.occurrenceContext!, snapshot)).toBe(f.volumeChapters.length + 101);
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

for (const chapters of [201, 10_000]) {
  test(`All ${chapters} ungrouped chapters retain story numbers with constant numbering I/O`, async () => {
    const records = Array.from({ length: chapters }, (_, i) => placedChapterRecord(i + 1000, chapterTestId(1), i + 1));
    const f = await chapterTreeFixture(records);
    for (const [record, number] of [[records[0]!, 1], [records.at(-1)!, chapters]] as const) {
      const page = await readCompositionPage(f.env, { structure: f.header.structure, header: f.header,
        occurrence: record.occurrence, limit: 1, canReadTarget: readableChapterTarget });
      expect(page.occurrenceContext?.ordinal).toBe(number);
      f.reset();
      expect(await chapterStoryNumber(f.session, f.header, record, page.occurrenceContext!)).toBe(number);
      expect(f.graphQueries).toHaveLength(1);
      expect(f.objects.gets).toBeLessThanOrEqual(12);
      expect(f.objects.bytes).toBeLessThan(500_000);
    }
  });
}

test('A volume and 200 top-level chapters retain exact child and later chapter numbers', async () => {
  const volume = placedChapterRecord(10, chapterTestId(1), 1, 'volume');
  const children = Array.from({ length: 500 }, (_, i) => placedChapterRecord(i + 30_000, volume.occurrence, i + 1));
  const chapters = Array.from({ length: 200 }, (_, i) => placedChapterRecord(i + 1000, chapterTestId(1), i + 2));
  const f = await chapterTreeFixture([volume, ...children, ...chapters]);
  for (const [record, number] of [[children[0]!, 1], [children.at(-1)!, 500],
    [chapters[0]!, 501], [chapters.at(-1)!, 700]] as const) {
    const page = await readCompositionPage(f.env, { structure: f.header.structure, header: f.header,
      occurrence: record.occurrence, limit: 1, canReadTarget: readableChapterTarget });
    f.reset();
    expect(await chapterStoryNumber(f.session, f.header, record, page.occurrenceContext!)).toBe(number);
    expect(f.graphQueries).toHaveLength(1);
    expect(f.objects.gets).toBeLessThanOrEqual(20);
    expect(f.objects.bytes).toBeLessThan(500_000);
  }
});

test('Sparse groups interspersed through 10000 top-level chapters number from bounded group-tree work', async () => {
  const root = chapterTestId(1);
  const volume = placedChapterRecord(10, root, 10_005, 'volume');
  const part = placedChapterRecord(11, root, 50_005, 'part');
  const extras = placedChapterRecord(12, root, 90_005, 'extras');
  const chapters = Array.from({ length: 10_000 }, (_, i) => placedChapterRecord(i + 1000, root, (i + 1) * 10));
  const volumeChapters = Array.from({ length: 500 }, (_, i) => placedChapterRecord(i + 30_000, volume.occurrence, i + 1));
  const partChapters = Array.from({ length: 300 }, (_, i) => placedChapterRecord(i + 40_000, part.occurrence, i + 1));
  const extra = placedChapterRecord(50_000, extras.occurrence, 1);
  const f = await chapterTreeFixture([...chapters, volume, part, extras, ...volumeChapters, ...partChapters, extra]);
  for (const [record, number] of [[chapters[0]!, 1], [chapters[999]!, 1000],
    [volumeChapters[0]!, 1001], [volumeChapters.at(-1)!, 1500], [chapters[1000]!, 1501],
    [partChapters[0]!, 5501], [chapters[5000]!, 5801], [extra, null], [chapters.at(-1)!, 10_800]] as const) {
    const page = await readCompositionPage(f.env, { structure: f.header.structure, header: f.header,
      occurrence: record.occurrence, limit: 1, canReadTarget: readableChapterTarget });
    f.reset();
    expect(await chapterStoryNumber(f.session, f.header, record, page.occurrenceContext!)).toBe(number);
    expect(f.graphQueries).toHaveLength(1);
    expect(f.objects.gets).toBeLessThanOrEqual(35);
    expect(f.objects.bytes).toBeLessThan(1_200_000);
  }
});

for (const groups of [200, 201, 10_000]) {
  test(`A Book with ${groups} groups preserves the 200-group numbering eligibility with bounded I/O`, async () => {
    const groupRecords = Array.from({ length: groups }, (_, i) =>
      placedChapterRecord(i + 1000, chapterTestId(1), i + 1, 'volume'));
    const chapter = placedChapterRecord(30_000, chapterTestId(1), groups + 1);
    const f = await chapterTreeFixture([...groupRecords, chapter]);
    const page = await readCompositionPage(f.env, { structure: f.header.structure, header: f.header,
      occurrence: chapter.occurrence, limit: 1, canReadTarget: readableChapterTarget });
    f.reset();
    expect(await chapterStoryNumber(f.session, f.header, chapter, page.occurrenceContext!))
      .toBe(groups > WORK_CONTENTS_COST.topGroups ? null : 1);
    expect(f.graphQueries).toHaveLength(1);
    expect(f.objects.gets).toBeLessThanOrEqual(12);
    expect(f.objects.bytes).toBeLessThan(500_000);
  });
}

test('A retained manifest without its group root needs explicit preparation, not invented no-number output', async () => {
  const chapter = placedChapterRecord(1000, chapterTestId(1), 1);
  const f = await chapterTreeFixture([chapter], false);
  const page = await readCompositionPage(f.env, { structure: f.header.structure, header: f.header,
    occurrence: chapter.occurrence, limit: 1, canReadTarget: readableChapterTarget });
  f.reset();
  await expect(chapterStoryNumber(f.session, f.header, chapter, page.occurrenceContext!))
    .rejects.toThrow('composition group root requires bounded preparation');
  expect(f.graphQueries).toHaveLength(1);
  expect(f.objects.gets).toBe(1);
  expect(f.objects.bytes).toBeLessThan(20_000);
  const snapshot = await f.snapshot();
  await expect(chapterStoryNumber(f.session, f.header, chapter, page.occurrenceContext!, snapshot))
    .rejects.toBeInstanceOf(StructureObjectUnavailable);
});

test('Group numbering refuses a retained group absent from the exact all-role order root', async () => {
  const f = await populatedChapterFixture(1000);
  const snapshot = await f.snapshot();
  const exact = await readCompositionPage(f.env, { structure: f.header.structure, snapshot,
    occurrence: f.end.occurrence, limit: 1, canReadTarget: readableChapterTarget });
  const order = await orderTree(f.objects).apply(snapshot.manifest.order,
    new Map([[orderTreeKey(f.volume as OrderEntry), null]]), newCost());
  const broken = { ...snapshot, cost: newCost(), manifest: { ...snapshot.manifest, order } };
  await expect(chapterStoryNumber(f.session, f.header, f.end, exact.occurrenceContext!, broken))
    .rejects.toBeInstanceOf(StructureObjectCorrupt);
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

/** Public graph/SQL boundaries around the real composition, tree and Content
 * owners. No development writer or retained-population enumeration participates. */
async function readerOwnerFixture(records: OccurrenceRecord[], profile: 'book-composition' | 'recipe-composition' = 'book-composition') {
  const f = await chapterTreeFixture(records, true, profile);
  const published = { ...f.header };
  const state = { public: true, publication: true, visible: true, structureVisible: true, target: true,
    graphFailure: null as Error | null, contentFailure: null as Error | null,
    rightsFailure: null as Error | null, assessment: 'current' as 'current' | 'withdrawn' | 'replaced',
    publicDomain: false, bodyVisible: true, hydrated: false, afterHydration: null as (() => void) | null,
    metadataAvailability: 'available', metadataDigest: null as string | null, metadataReads: 0, bodyReads: 0, rightsReads: 0,
    publicationRevision: null as string | null,
    representation: 'available' as 'available' | 'erased' | 'unavailable' | 'missing' | 'corrupt',
    wrongResource: false, revokeAfterBody: false, headerAbsent: false, headerBroken: false };
  const originalQuery = f.env.fuseki.query.bind(f.env.fuseki);
  const uri = (value: string) => ({ type: 'uri' as const, value });
  const literal = (value: string) => ({ type: 'literal' as const, value });
  const contentRows = new Map(records.filter(r => r.target).map((record, index) => {
    const id = chapterTestId(200_000 + index).slice(-36), variant = chapterTestId(300_000 + index);
    const body = { body: `Chapter ${index + 1}\nThe exact public chapter beside the river.` };
    const bytes = Buffer.from(JSON.stringify(body));
    return [record.target!, { id, variant_id: variant, resource_id: record.target!, body,
      serialized_bytes: bytes, byte_digest: createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length,
      total_bytes: bytes.length, model: 'content-shape-v1', availability: 'available', language_kind: 'tag',
      language_tag: 'en', original_language_tag: 'en', direction: 'ltr', source_revision: null, predecessor: null, provenance: [] }];
  }));
  const content = new ContentCore({ query: async (_sql: string, values: [string[]]) => {
    if (state.contentFailure) throw state.contentFailure;
    if (_sql.includes('SELECT id,availability,byte_digest')) {
      state.metadataReads++;
      return { rows: [...contentRows.values()].filter(row => values[0].includes(row.id)).map(row => ({
        id: row.id, availability: state.metadataAvailability, byte_digest: state.metadataDigest ?? row.byte_digest,
      })) };
    }
    state.bodyReads++;
    const rows = [...contentRows.values()].filter(row => values[0].includes(row.id)).flatMap(row =>
      state.representation === 'missing' ? [] : [{ ...row,
        availability: state.representation === 'corrupt' ? 'available' : state.representation,
        byte_digest: state.representation === 'corrupt' ? '0'.repeat(64) : row.byte_digest,
        resource_id: state.wrongResource ? chapterTestId(999) : row.resource_id,
        provenance: state.publicDomain ? { kind: 'admitted-public-domain-v1', rightsAssessmentId: chapterTestId(900).slice(-36) } : row.provenance }]);
    if (state.revokeAfterBody) state.target = false;
    state.hydrated = true;
    return { rows };
  } } as unknown as Pool);
  configureFixtureDisclosureAncestry(f.env, target => target.work
    ? { resource: target.work, head: chapterTestId(6), protectedRevision: target.workRevision } : undefined);
  configureDisclosure(f.env, fixtureDisclosureReader(async targets => targets.map(target =>
    target.component === 'body' && !state.bodyVisible ? 'hidden' : 'visible')));
  f.session.deps.content = disclosureContent(content, f.env);
  f.session.deps.contentAuthoring = content;
  const rightsPool = { query: async (_sql: string, values: [string | string[], string | string[]]) => {
    state.rightsReads++;
    if (state.rightsFailure) throw state.rightsFailure;
    const row = { assessment_head: chapterTestId(state.assessment === 'current' ? 900 : 901).slice(-36), basis: 'public_domain', outcome: 'supported' };
    return { rows: state.assessment === 'withdrawn' ? [] : Array.isArray(values[0])
      ? values[0].map((work, index) => ({ ...row, work_id: work, assessment_id: values[1][index] })) : [row] };
  } } as unknown as Pool;
  f.session.deps.rights = { store: new RightsStore(rightsPool, rightsPool) } as WorkReadSession['deps']['rights'];
  Object.assign(f.env.fuseki, {
    commandHealth: async () => ({ profiles: { 'work-metadata-v1': 'owner-fixture' } }),
    query: async (query: string) => {
      if (state.graphFailure) throw state.graphFailure;
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return { results: { bindings: [{
        epoch: literal('chapter-fixture'), sequence: literal('7'), r: uri(f.header.work), type: literal('work'),
        work: uri(f.header.work), head: uri(chapterTestId(6)), public: literal(String(state.public)),
        label: { ...literal('Public Work'), 'xml:lang': 'en' },
      }] } };
      if (query.includes('SELECT ?epoch ?sequence')) return { results: { bindings: [{ epoch: literal('chapter-fixture'), sequence: literal('7') }] } };
      if (query.includes('SELECT ?head ?main ?mainHead')) return { results: { bindings: [{
        head: uri(chapterTestId(6)), main: uri(f.header.component), mainHead: uri(chapterTestId(7)),
        public: literal(String(state.public)), type: uri('https://schema.org/Book'),
      }] } };
      if (query.includes('SELECT ?structuredDecision')) return { results: { bindings: profile === 'recipe-composition' && state.publication ? [{
        structuredDecision: uri(chapterTestId(8)), structuredSource: uri('urn:rezics:work-source:owner-fixture'),
        structuredStructure: uri(published.structure), structuredProfile: uri(structureProfileFor(profile).graphProfile),
        structuredRevision: uri(published.head), structuredGeneration: uri(published.generation),
        structuredRoot: uri(published.manifest), structuredExact: literal('true'),
      }] : [] } };
      if (query.includes('SELECT ?selection ?language')) return { results: { bindings: state.publication
        ? [{ selection: uri(chapterTestId(9)), language: literal('en') }] : [] } };
      if (query.includes('SELECT ?work ?parent')) return { results: { bindings: [{ work: uri(f.header.work) }] } };
      if (query.includes('SELECT ?resource ?head')) return { results: { bindings: [{ resource: uri(f.header.work), head: uri(chapterTestId(6)) }] } };
      if (query.includes('SELECT ?target WHERE') && query.includes('VALUES ?target')) return { results: { bindings: [] } };
      if (query.includes('SELECT ?component ?profile ?head')) return { results: { bindings: state.headerAbsent ? []
        : state.headerBroken ? [{}] : [{ component: uri(f.header.component), profile: uri(structureProfileFor(profile).graphProfile),
          head: uri(f.header.head), generation: uri(f.header.generation), count: literal(String(f.header.placementCount)),
          manifest: uri(f.header.manifest) }] } };
      if (query.includes('SELECT ?owner')) return { results: { bindings: [{ owner: uri(f.header.work) }] } };
      if (query.includes('SELECT ?structure')) return { results: { bindings: [{ structure: uri(f.header.structure) }] } };
      if (query.includes('SELECT DISTINCT ?target')) return { results: { bindings: state.target ? [{ target: uri(records[0]?.target ?? f.header.work) }] : [] } };
      if (query.includes('SELECT DISTINCT ?variant ?revision')) {
        const row = [...contentRows.values()].find(row => query.includes(`<${row.resource_id}>`));
        return { results: { bindings: row && state.target ? [{ variant: uri(row.variant_id),
          revision: uri(state.publicationRevision ?? `urn:rezics:content:revision:${row.id}`) }] : [] } };
      }
      return originalQuery(query);
    },
  });
  f.session.summaries = async resources => resources.map(reference => ({ reference, status: state.visible ? 'available' : 'unavailable',
    type: 'work', name: { value: 'Public Work', language: 'en', direction: 'ltr' }, avatar: null })) as Awaited<ReturnType<WorkReadSession['summaries']>>;
  const bodyDisclosure = f.session.disclosure.bind(f.session);
  f.session.disclosure = async (targets, channel) => targets.every(target => target.owner === 'content' && target.component === 'body')
    ? bodyDisclosure(targets, channel) : targets.map(target => state.visible
      && (target.component !== 'structure' || state.structureVisible) ? 'visible' : 'hidden');
  // The real delivery adapter first permits the body. Mutations occur in the
  // subsequent Work fence, after native hydration and that adapter's own cut.
  const summaries = f.session.summaries.bind(f.session);
  f.session.summaries = async resources => {
    const mutation = state.afterHydration;
    if (mutation && state.hydrated) { state.afterHydration = null; mutation(); }
    return summaries(resources);
  };
  return { ...f, state, contentRows };
}

test('the public Book chain selects exact chapters and native bytes through one real immutable composition', async () => {
  const records = [placedChapterRecord(10, chapterTestId(1), 1), placedChapterRecord(11, chapterTestId(1), 2)];
  const f = await readerOwnerFixture(records);
  expect(await readWorkBasis(f.session, f.header.work)).toMatchObject({ disclosure: 'public', publicationState: 'published', selectedLanguage: 'en' });
  const contents = await readContents(f.session, f.header.work, {});
  expect(contents.compositionRevision).toBe(f.header.head);
  expect(contents.items.map(item => item.occurrence)).toEqual(records.map(item => item.occurrence));
  const chapter = await readChapter(f.session, records[0]!.occurrence, {});
  expect(chapter).toMatchObject({ compositionRevision: f.header.head, selectedRevision: contents.items[0]!.selectedRevision,
    previous: null, next: records[1]!.occurrence, number: 1,
    content: { body: { body: 'Chapter 1\nThe exact public chapter beside the river.' } } });
  const exact = await f.session.deps.content!.readExactBatch([chapter.content.reference.revisionId], async ids => new Set(ids));
  expect(exact[0]).toMatchObject({ status: 'available', serializedJson: chapter.content.serializedJson, reference: chapter.content.reference });
  // Two chapters need no population replay, native write, or preparation fallback.
  expect(f.objects.gets).toBeLessThan(32);
});

for (const surface of ['contents', 'chapter'] as const) {
  test(`an Account without an acting Agent reads public ${surface} through its normal route`, async () => {
    const record = placedChapterRecord(10, chapterTestId(1), 1);
    const f = await readerOwnerFixture([record]);
    let verifications = 0, choices = 0; const viewers: boolean[] = [];
    f.session.deps.account = { verify: async (_request, scopes) => {
      expect(scopes).toEqual(['work:read']); verifications++;
      return { issuer: 'account', subject: 'empty-account' };
    } };
    f.session.deps.access = { assertRecoveryOpen: async () => undefined,
      activePrincipalId: async () => { throw new Error('public read must not require Agent eligibility'); } } as never;
    f.session.deps.sessionAgents = { readMain: async () => { choices++; return null; },
      readSession: async () => { choices++; return null; } } as never;
    configureDisclosure(f.env, fixtureDisclosureReader(async (targets, viewer) => {
      viewers.push(viewer.signedIn); return targets.map(() => 'visible');
    }));
    const path = surface === 'contents' ? `/v1/works/${f.header.work.slice(-36)}/contents`
      : `/v1/chapters/${record.occurrence.slice(-36)}`;
    const app = new Elysia().use(workContentsRoutes(f.session.deps));
    const response = await app.handle(new Request(`http://main.test${path}`, { headers: { authorization: 'Bearer reader' } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    if (surface === 'contents') expect(body).toMatchObject({ items: [{ occurrence: record.occurrence, availability: 'available' }] });
    else expect(body).toMatchObject({ occurrence: record.occurrence, content: { body: { body: expect.stringContaining('exact public chapter') } } });
    expect(verifications).toBe(1); expect(choices).toBe(0);
    expect(viewers.length).toBeGreaterThan(0); expect(viewers.every(Boolean)).toBe(true);
  });
}

test('catalogue-visible Book metadata does not admit contents or chapters without a current public Main text selection', async () => {
  const record = placedChapterRecord(10, chapterTestId(1), 1);
  for (const explicitLanguage of [false, true]) {
    const f = await readerOwnerFixture([record]); f.state.publication = false;
    const options = explicitLanguage ? { language: 'en' } : {};
    expect(await readWorkBasis(f.session, f.header.work)).toMatchObject({ disclosure: 'public', publicationState: 'unpublished' });
    await expect(readContents(f.session, f.header.work, options)).rejects.toBeInstanceOf(WorkReadMissing);
    await expect(readChapter(f.session, record.occurrence, { language: 'en' })).rejects.toBeInstanceOf(WorkReadMissing);
  }
  const otherLanguage = await readerOwnerFixture([record]);
  otherLanguage.session.options.language = 'fr';
  await expect(readContents(otherLanguage.session, otherLanguage.header.work, { language: 'fr' })).rejects.toBeInstanceOf(WorkReadMissing);
  await expect(readChapter(otherLanguage.session, record.occurrence, { language: 'fr' })).rejects.toBeInstanceOf(WorkReadMissing);
  const preview = await readerOwnerFixture([record]); preview.state.publication = false;
  preview.session.principal = { issuer: 'account', subject: 'owner' };
  preview.session.options.actingSubject = chapterTestId(800);
  preview.session.deps.access = { canPreviewWork: async () => true, canReadWork: async () => false } as never;
  expect((await readContents(preview.session, preview.header.work, { language: 'en' })).items).toHaveLength(1);
});

for (const assessment of ['withdrawn', 'replaced'] as const) {
  test(`a ${assessment} public-domain assessment suppresses exact chapter bytes and body-derived titles`, async () => {
    const record = { ...placedChapterRecord(10, chapterTestId(1), 1), labels: [] };
    const chapter = await readerOwnerFixture([record]);
    chapter.state.publicDomain = true; chapter.state.assessment = assessment;
    await expect(readChapter(chapter.session, record.occurrence, {})).rejects.toBeInstanceOf(WorkReadMissing);
    const contents = await readerOwnerFixture([record]);
    contents.state.publicDomain = true; contents.state.assessment = assessment;
    expect((await readContents(contents.session, contents.header.work, {})).items[0]?.label).toBeNull();
  });
}

test('the rights owner failure keeps its SQL cause and recovers without changing the selected chapter', async () => {
  const record = placedChapterRecord(10, chapterTestId(1), 1);
  const f = await readerOwnerFixture([record]); f.state.publicDomain = true;
  const cause = Object.assign(new Error('rights transport lost'), { code: '08006' });
  f.state.rightsFailure = cause;
  const error = await readChapter(f.session, record.occurrence, {}).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(WorkReadUnavailable);
  let current = error; const causes: unknown[] = [];
  while (current instanceof Error) { causes.push(current); current = current.cause; }
  expect(causes).toContain(cause);
  f.state.rightsFailure = null;
  expect((await readChapter(f.session, record.occurrence, {})).content.body).toMatchObject({ body: expect.stringContaining('exact public chapter') });
});

test('current public-domain chapters and titles stay readable while original text does not depend on rights availability', async () => {
  const record = { ...placedChapterRecord(10, chapterTestId(1), 1), labels: [] };
  for (const publicDomain of [false, true]) {
    const f = await readerOwnerFixture([record]); f.state.publicDomain = publicDomain;
    if (!publicDomain) f.state.rightsFailure = new Error('unrelated rights outage');
    expect((await readContents(f.session, f.header.work, {})).items[0]?.label).toEqual({ value: 'Chapter 1', language: 'en' });
    expect((await readChapter(f.session, record.occurrence, {})).content.body).toMatchObject({ body: expect.stringContaining('exact public chapter') });
    expect(f.state.metadataReads).toBe(2);
  }
});

test('a full page of body-derived public-domain titles uses bounded hydration and shared delivery probes', async () => {
  const records = Array.from({ length: 20 }, (_, index) => ({
    ...placedChapterRecord(10 + index, chapterTestId(1), index + 1), labels: [],
  }));
  const f = await readerOwnerFixture(records); f.state.publicDomain = true;
  const contents = await readContents(f.session, f.header.work, {});
  expect(contents.items.map(item => item.label?.value)).toEqual(records.map((_record, index) => `Chapter ${index + 1}`));
  expect(f.state.bodyReads).toBe(5); expect(f.state.metadataReads).toBe(1); expect(f.state.rightsReads).toBe(2);
  await f.session.fenceDependencies();
  expect(f.state.bodyReads).toBe(5); expect(f.state.metadataReads).toBe(2); expect(f.state.rightsReads).toBe(3);
});

test('the shared title rights probe preserves a recoverable SQL failure', async () => {
  const records = [10, 11].map((number, index) => ({
    ...placedChapterRecord(number, chapterTestId(1), index + 1), labels: [],
  }));
  const f = await readerOwnerFixture(records); f.state.publicDomain = true;
  const cause = Object.assign(new Error('batch rights transport lost'), { code: '08006' });
  f.state.rightsFailure = cause;
  const error = await readContents(f.session, f.header.work, {}).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(WorkReadUnavailable);
  const causes: unknown[] = []; let current = error;
  while (current instanceof Error) { causes.push(current); current = current.cause; }
  expect(causes).toContain(cause);
  f.state.rightsFailure = null;
  expect((await readContents(f.session, f.header.work, {})).items.map(item => item.label?.value)).toEqual(['Chapter 1', 'Chapter 2']);
});

test('derived titles retain a rights owner failure instead of becoming a successful empty label', async () => {
  const record = { ...placedChapterRecord(10, chapterTestId(1), 1), labels: [] };
  const f = await readerOwnerFixture([record]); f.state.publicDomain = true;
  const cause = Object.assign(new Error('rights unavailable for title'), { code: '08006' });
  f.state.rightsFailure = cause;
  const error = await readContents(f.session, f.header.work, {}).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(WorkReadUnavailable);
  const causes: unknown[] = []; let current = error;
  while (current instanceof Error) { causes.push(current); current = current.cause; }
  expect(causes).toContain(cause);
});

for (const change of ['rights', 'disclosure', 'erased'] as const) {
  test(`a body-derived title is discarded after a later ${change} revocation`, async () => {
    const record = { ...placedChapterRecord(10, chapterTestId(1), 1), labels: [] };
    const f = await readerOwnerFixture([record]); f.state.publicDomain = true;
    f.state.afterHydration = () => {
      if (change === 'rights') f.state.assessment = 'withdrawn';
      if (change === 'disclosure') f.state.bodyVisible = false;
      if (change === 'erased') f.state.metadataAvailability = 'erased';
    };
    const contents = await readContents(f.session, f.header.work, {});
    expect(contents.items[0]?.label ?? null).toBeNull();
    expect(f.state.hydrated).toBe(true);
  });
}

for (const change of ['rights', 'disclosure', 'erased'] as const) {
  test(`the Work read envelope retains the requested body's ${change} fence after hydration returns`, async () => {
    const record = placedChapterRecord(10, chapterTestId(1), 1);
    const f = await readerOwnerFixture([record]); f.state.publicDomain = true;
    expect((await readChapter(f.session, record.occurrence, {})).content.body).toMatchObject({ body: expect.stringContaining('exact public chapter') });
    if (change === 'rights') f.state.assessment = 'withdrawn';
    if (change === 'disclosure') f.state.bodyVisible = false;
    if (change === 'erased') f.state.metadataAvailability = 'erased';
    await expect(f.session.fenceDependencies()).rejects.toBeInstanceOf(WorkReadMoved);
  });
}

test('the requested single chapter body passes a final disclosure fence after later Work awaits', async () => {
  const record = placedChapterRecord(10, chapterTestId(1), 1);
  const f = await readerOwnerFixture([record]);
  f.state.afterHydration = () => { f.state.bodyVisible = false; };
  await expect(readChapter(f.session, record.occurrence, {})).rejects.toBeInstanceOf(WorkReadMissing);
  expect(f.state.hydrated).toBe(true);
  expect(f.state.visible).toBe(true); expect(f.state.target).toBe(true);
});

test('the requested chapter also repeats its public-domain rights fence after later Work awaits', async () => {
  const record = placedChapterRecord(10, chapterTestId(1), 1);
  const f = await readerOwnerFixture([record]); f.state.publicDomain = true;
  f.state.afterHydration = () => { f.state.assessment = 'withdrawn'; };
  await expect(readChapter(f.session, record.occurrence, {})).rejects.toBeInstanceOf(WorkReadMissing);
  expect(f.state.hydrated).toBe(true);
});

test('the exact representation metadata failure retains its cause and recovers without a body fallback', async () => {
  const record = placedChapterRecord(10, chapterTestId(1), 1);
  const f = await readerOwnerFixture([record]);
  const owner = f.session.deps.contentAuthoring!, read = owner.readExactMetadataBatch.bind(owner);
  const cause = Object.assign(new Error('metadata statement lost'), { code: '08006' }); let unavailable = true;
  owner.readExactMetadataBatch = async (...args) => {
    if (unavailable) throw cause;
    return read(...args);
  };
  await expect(readChapter(f.session, record.occurrence, {})).rejects.toMatchObject({ cause });
  unavailable = false;
  expect((await readChapter(f.session, record.occurrence, {})).content.body).toMatchObject({ body: expect.stringContaining('exact public chapter') });
});

for (const change of ['erased', 'digest'] as const) {
  test(`the exact native metadata fence discards chapter bytes after a concurrent ${change} transition`, async () => {
    const record = placedChapterRecord(10, chapterTestId(1), 1);
    const f = await readerOwnerFixture([record]);
    f.state.afterHydration = () => {
      if (change === 'erased') f.state.metadataAvailability = 'erased';
      else f.state.metadataDigest = '0'.repeat(64);
    };
    await expect(readChapter(f.session, record.occurrence, {})).rejects.toBeInstanceOf(change === 'erased' ? WorkReadMissing : WorkReadUnavailable);
    expect(f.state.metadataReads).toBeGreaterThan(0);
  });
}

test('published Recipe contents retain the publication revision when a private edit advances its head', async () => {
  const record = placedChapterRecord(10, chapterTestId(1), 1, 'part');
  delete record.qualifier;
  const f = await readerOwnerFixture([record], 'recipe-composition');
  const published = f.header.head;
  const privateRoot = await chapterTreeFixture([], true, 'recipe-composition');
  for (const [digest, bytes] of privateRoot.objects.values) f.objects.values.set(digest, bytes);
  f.header.head = chapterTestId(50);
  f.header.manifest = privateRoot.header.manifest;
  f.header.placementCount = 0;
  f.revisions.set(f.header.head, { manifest: f.header.manifest, count: 0 });
  const page = await readContents(f.session, f.header.work, {});
  expect(page.compositionRevision).toBe(published);
  expect(page.items.map(item => item.occurrence)).toEqual([record.occurrence]);
});

test('a catalogue-visible Recipe cannot expose its current composition after publication or exact disclosure is revoked', async () => {
  for (const withheld of ['publication', 'structureVisible'] as const) {
    const record = placedChapterRecord(10, chapterTestId(1), 1, 'part');
    delete record.qualifier;
    const f = await readerOwnerFixture([record], 'recipe-composition');
    f.state[withheld] = false;
    expect((await readWorkBasis(f.session, f.header.work)).disclosure).toBe('public');
    await expect(readContents(f.session, f.header.work, {})).rejects.toBeInstanceOf(WorkReadMissing);
    expect(f.objects.gets).toBe(0);
  }
});

for (const failure of ['missing', 'integrity', 'dependency', 'format'] as const) {
  test(`the chapter chain distinguishes immutable ${failure} with its original cause`, async () => {
    const record = placedChapterRecord(10, chapterTestId(1), 1);
    const f = await readerOwnerFixture([record]);
    const digest = f.header.manifest.slice(-64);
    const original = f.objects.values.get(digest)!;
    let cause: Error | null = null;
    if (failure === 'missing') f.objects.values.delete(digest);
    if (failure === 'integrity') f.objects.values.set(digest, chapterTestBytes({ changed: true }));
    if (failure === 'dependency') {
      cause = new ObjectUnavailable('owner offline', { status: 503 });
      f.objects.get = async () => { throw cause; };
    }
    if (failure === 'format') {
      const invalid = await f.objects.put(chapterTestBytes({ unsupported: true }));
      f.header.manifest = `urn:rezics:sha256:${invalid}`;
      f.revisions.set(f.header.head, { manifest: f.header.manifest, count: 1 });
    }
    const error = await readChapter(f.session, record.occurrence, {}).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(WorkReadUnavailable);
    expect((error as WorkReadUnavailable).code).toBe({ missing: 'composition_object_missing', integrity: 'composition_integrity_mismatch',
      dependency: 'composition_dependency_unavailab', format: 'composition_is_corrupt' }[failure]);
    expect((error as Error).cause).toBeInstanceOf(Error);
    if (cause) expect(((error as Error).cause as Error).cause).toBe(cause);
    expect(original.length).toBeGreaterThan(0);
  });
}

for (const representation of ['missing', 'corrupt', 'unavailable', 'erased'] as const) {
  test(`a published chapter distinguishes ${representation} from a readable exact body`, async () => {
    const record = placedChapterRecord(10, chapterTestId(1), 1);
    const f = await readerOwnerFixture([record]);
    f.state.representation = representation;
    const error = await readChapter(f.session, record.occurrence, {}).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(representation === 'erased' ? WorkReadMissing : WorkReadUnavailable);
    if (error instanceof WorkReadUnavailable) expect(error.code).toBe({ missing: 'published_chapter_object_missing',
      corrupt: 'chapter_integrity_mismatch', unavailable: 'chapter_dependency_unavailable' }[representation as 'missing' | 'corrupt' | 'unavailable']);
  });
}

test('the public chapter chain rechecks revocation and exact representation ownership', async () => {
  const record = placedChapterRecord(10, chapterTestId(1), 1);
  const f = await readerOwnerFixture([record]);
  f.state.wrongResource = true;
  await expect(readChapter(f.session, record.occurrence, {})).rejects.toThrow('Content and publication disagree');
  f.state.wrongResource = false;
  f.state.revokeAfterBody = true;
  await expect(readChapter(f.session, record.occurrence, {})).rejects.toBeInstanceOf(WorkReadMoved);
  const revoked = await readerOwnerFixture([record]);
  revoked.state.target = false;
  await expect(readChapter(revoked.session, record.occurrence, {})).rejects.toBeInstanceOf(WorkReadMissing);
  f.state.revokeAfterBody = false;
  f.state.target = true;
  f.state.visible = false;
  await expect(readChapter(f.session, record.occurrence, {})).rejects.toBeInstanceOf(WorkReadMissing);
});

test('chapter and title-body dependencies retain their causes and reject another exact revision', async () => {
  const record = placedChapterRecord(10, chapterTestId(1), 1);
  record.labels = [];
  const f = await readerOwnerFixture([record]);
  const database = Object.assign(new Error('exact owner unavailable'), { code: '08006' });
  f.state.contentFailure = database;
  await expect(readChapter(f.session, record.occurrence, {})).rejects.toMatchObject({ code: 'content_owner_is_unavailable', cause: database });
  await expect(readContents(f.session, f.header.work, {})).rejects.toMatchObject({ code: 'content_owner_is_unavailable', cause: database });
  f.state.contentFailure = null;
  const read = f.contentRows.values().next().value!;
  expect((await readChapter(f.session, record.occurrence, {})).content.reference.revisionId).toBe(read.id);
  const owner = f.session.deps.content!;
  const actual = owner.readExactBatch.bind(owner);
  f.session.deps.content = {
    owningResourceForRevision: owner.owningResourceForRevision.bind(owner),
    readExactBatch: async (...args) => (await actual(...args)).map(exact =>
      exact.status === 'available' ? { ...exact, revisionId: chapterTestId(999).slice(-36) } : exact),
  };
  await expect(readChapter(f.session, record.occurrence, {})).rejects.toThrow('Content and publication disagree');
  await expect(readContents(f.session, f.header.work, {})).rejects.toThrow('Chapter publication differs from its Content');
  f.session.deps.content!.readExactBatch = async () => [];
  await expect(readChapter(f.session, record.occurrence, {})).rejects.toThrow('Content owner result is incomplete');
  await expect(readContents(f.session, f.header.work, {})).rejects.toThrow('Content owner result is incomplete');
  const graph = new FusekiHttpError('graph held', 503, 'Unavailable');
  f.state.graphFailure = graph;
  await expect(readContents(f.session, f.header.work, {})).rejects.toMatchObject({ code: 'composition_graph_unavailable', cause: graph });
});

test('a corrupt publication pointer cannot read bytes from another revision namespace', async () => {
  const record = placedChapterRecord(10, chapterTestId(1), 1);
  record.labels = [];
  let reads = 0;
  for (const revision of [chapterTestId(200_000), 'urn:rezics:content:revision:invalid']) {
    const f = await readerOwnerFixture([record]);
    f.session.deps.content!.readExactBatch = async () => { reads++; return []; };
    f.state.publicationRevision = revision;
    await expect(readChapter(f.session, record.occurrence, {})).rejects.toThrow('Chapter publication is corrupt');
    await expect(readContents(f.session, f.header.work, {})).rejects.toThrow('Chapter publication is corrupt');
  }
  expect(reads).toBe(0);
});

test('corrupt composition metadata is distinct from an absent Structure and a missing occurrence', async () => {
  const record = placedChapterRecord(10, chapterTestId(1), 1);
  const f = await readerOwnerFixture([record]);
  f.state.headerAbsent = true;
  expect(await readCompositionHeader(f.env, f.header.structure)).toBeNull();
  f.state.headerAbsent = false;
  f.state.headerBroken = true;
  await expect(readContents(f.session, f.header.work, {})).rejects.toMatchObject({ code: 'composition_is_corrupt' });
  f.state.headerBroken = false;
  await expect(readChapter(f.session, chapterTestId(999), {})).rejects.toBeInstanceOf(WorkReadMissing);
});
