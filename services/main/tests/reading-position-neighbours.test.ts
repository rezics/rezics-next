import { expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { readingPositionsRoutes } from '../src/routes/reading-positions.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { READING_POSITION_COST, type ReadingOccurrence } from '../src/modules/reading-position/boundary.ts';
import { READING_CHOOSER_COST } from '../src/modules/reading-position/traversal.ts';
import { ReadingOrderIndex } from '../src/modules/reading-position/immutable-order.ts';
import { RV } from '../src/modules/work/activate.ts';
import type { ReadRow } from '../src/modules/work/read-session.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { COMPOSITION_PROFILE, orderTreeKey, placementIri } from '../src/modules/structure/graph.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, type OrderEntry } from '../src/modules/structure/format.ts';
import { newCost } from '../src/modules/structure/tree.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const binding = (value: string) => ({ type: 'literal' as const, value });
const uuid = (iri: string) => iri.slice(-36);
const key = (index: number) => String(index).padStart(5, '0');

interface Composed { work: string; structure: string; revision: string }
interface Revelation { record: string; occurrence: string }

/** A composition tree the way the order store and graph hold it: counted order pages in the immutable store, one
 * placement row per occurrence in the graph. Every object read that reaches the store is counted. */
function fixture(inventory: readonly ReadingOccurrence[], works: readonly Composed[], revelations: readonly Revelation[] = []) {
  const [root] = works as [Composed, ...Composed[]];
  const hidden = new Set<string>();
  const stored = new Map<string, Uint8Array>();
  const queries: string[] = [];
  let objectReads = 0;
  const counted: ImmutableObjects = { put: async body => {
    const digest = createHash('sha256').update(body).digest('hex'); stored.set(digest, body); return digest;
  }, get: async digest => {
    objectReads++;
    const body = stored.get(digest);
    if (!body) throw new ObjectUnavailable('missing order object');
    return body;
  } };
  const row = (item: ReadingOccurrence): ReadRow => ({ work: binding(item.work), structure: binding(item.structure),
    revision: binding(item.revision), placement: binding(placementIri(item.structure, item.occurrence)),
    occurrence: binding(item.occurrence), parent: binding(item.parent), segmentKey: binding(item.segmentKey),
    orderKey: binding(item.orderKey), role: binding(`${RV}${item.role === 'chapter' ? 'ChapterRole' : item.role === 'part' ? 'PartRole' : 'GroupRole'}`),
    ...(item.target ? { target: binding(item.target) } : {}),
    ...(item.displayLabel ? { displayLabel: binding(item.displayLabel) } : {}),
    ...(item.labels?.[0] ? { label: { ...binding(item.labels[0].value), 'xml:lang': item.labels[0].language } } : {}) });
  const byOccurrence = new Map(inventory.map(item => [item.occurrence, item]));
  const manifests = new Map<string, string>();
  const branch = 32;
  const ready = (async () => {
    const cost = newCost(), records = await recordTree(counted).empty(cost), empty = await orderTree(counted).empty(cost);
    for (const composed of works) {
      const entries = inventory.filter(item => item.structure === composed.structure).map((item): OrderEntry => ({
        parent: item.parent, segmentKey: item.segmentKey, orderKey: item.orderKey, occurrence: item.occurrence }))
        .sort((a, b) => orderTreeKey(a) < orderTreeKey(b) ? -1 : 1);
      const put = async (level: number, pageEntries: readonly unknown[]) =>
        `sha256:${await counted.put(new TextEncoder().encode(JSON.stringify({ format: STRUCTURE_PAGE_FORMAT, tree: 'order', level, entries: pageEntries })))}`;
      let level = 0;
      let children: Array<{ page: string; count: number; first: string }> = [];
      for (let at = 0; at < entries.length; at += branch) {
        const chunk = entries.slice(at, at + branch);
        children.push({ page: await put(0, chunk), count: chunk.length, first: orderTreeKey(chunk[0]!) });
      }
      while (children.length > 1) {
        level++;
        const parents: typeof children = [];
        for (let at = 0; at < children.length; at += branch) {
          const chunk = children.slice(at, at + branch);
          parents.push({ page: await put(level, chunk), count: chunk.reduce((total, child) => total + child.count, 0), first: chunk[0]!.first });
        }
        children = parents;
      }
      const order = children[0] ? { page: children[0].page, level, count: children[0].count } : empty;
      const manifest = { format: STRUCTURE_MANIFEST_FORMAT, structure: composed.structure, structureOf: id(),
        profile: 'book-composition' as const, generation: composed.structure, pageFormat: STRUCTURE_PAGE_FORMAT,
        records, order, placementCount: order.count, measures: [], model: COMPOSITION_PROFILE, shape: COMPOSITION_PROFILE };
      manifests.set(composed.revision, await counted.put(new TextEncoder().encode(JSON.stringify(manifest))));
    }
  })();
  const execute = (sparql: string): ReadRow[] => {
    const control = { epoch: binding('epoch'), sequence: binding('1') };
    if (sparql.includes('# reading-position:work\n')) {
      const resource = sparql.match(/BIND\(<([^>]+)> AS \?work\)/)![1]!;
      const composed = works.find(candidate => candidate.work === resource);
      return composed ? [{ work: binding(composed.work), structure: binding(composed.structure),
        revision: binding(composed.revision), generation: binding(composed.structure) }] : [{ work: binding(resource) }];
    }
    if (sparql.includes('# reading-position:records')) {
      // The real records read selects no label or display label: one row per occurrence.
      const values = sparql.match(/VALUES \?occurrence \{([^}]+)}/)![1]!;
      return inventory.filter(item => values.includes(item.occurrence)).map(item => {
        const { label: _label, displayLabel: _displayLabel, ...record } = row(item);
        return record;
      });
    }
    if (sparql.includes('# reading-position:parent-work')) {
      const target = sparql.match(/schema:item <([^>]+)>/)![1]!;
      return inventory.filter(item => item.role === 'part' && item.target === target).map(item => ({ occurrence: binding(item.occurrence) }));
    }
    if (sparql.includes('# reading-position:manifest')) {
      const revision = sparql.match(/<([^>]+)> a rv:StructureRevision/)![1]!;
      return [{ manifest: binding(`urn:rezics:sha256:${manifests.get(revision)!}`) }];
    }
    if (sparql.includes('# reading-position:hydrate')) {
      return [...sparql.matchAll(/\(<([^>]+)> <([^>]+)>\)/g)].flatMap(([, , occurrence]) => {
        const item = byOccurrence.get(occurrence!);
        return item ? [row(item)] : [];
      });
    }
    if (sparql.includes('# reading-position:chapter-labels')) {
      const occurrence = sparql.match(/BIND\(<([^>]+)> AS \?occurrence\)/)?.[1];
      const item = occurrence ? byOccurrence.get(occurrence) : undefined;
      if (!item) return [];
      const labels = item.labels ?? [];
      const named = (label?: { value: string; language: string }): ReadRow => {
        const record: ReadRow = {};
        if (label) record.label = { ...binding(label.value), 'xml:lang': label.language };
        if (item.displayLabel) record.displayLabel = binding(item.displayLabel);
        return record;
      };
      return labels.length ? labels.map(label => named(label)) : [named()];
    }
    if (sparql.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const resources = [...sparql.match(/VALUES \?r \{([^}]+)}/)![1]!.matchAll(/<([^>]+)>/g)].map(match => match[1]!);
      return [control, ...resources.filter(resource => !hidden.has(resource)).map(resource => ({ ...control, r: binding(resource),
        work: binding(resource), type: binding('work'), public: binding('true'), label: { ...binding('Story'), 'xml:lang': 'en' } }))];
    }
    if (sparql.includes('SELECT ?work ?structure')) throw new Error('Full composition materialization is forbidden');
    return [control];
  };
  const rows = new Map<string, Array<{ record: string; recordKind: 'entity'; continuityWork: string; occurrence: string; receipt: string }>>();
  for (const revelation of revelations) rows.set(revelation.record, [{ ...revelation, recordKind: 'entity', continuityWork: root.work, receipt: 'receipt' }]);
  const deps = { environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, structureObjects: counted,
    fuseki: { commandHealth: async () => ({ instanceId: '11111111-1111-4111-8111-111111111111',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false, publicSearchDeltaAvailable: true }),
    query: async (sparql: string) => {
      await ready; queries.push(sparql);
      return { results: { bindings: execute(sparql) } };
    } } },
    structureObjects: counted,
    access: { assertRecoveryOpen: async (): Promise<void> => undefined, activePrincipalId: async () => null,
      canReadAsBaselineMember: async () => false },
    readingPositions: { generation: async () => '1', privateSnapshot: async () => '0',
      lookup: async (records: string[]) => new Map(records.flatMap(record => rows.has(record) ? [[record, rows.get(record)!] as const] : [])),
      required: async (records: string[]) => new Set(records.filter(record => rows.has(record))) },
  } as unknown as MainWorkDependencies;
  const app = new Elysia().use(readingPositionsRoutes(deps));
  const call = async (query: Record<string, string>) => {
    await ready;
    const response = await app.handle(new Request(`http://main.local/v1/reading-positions/${uuid(root.work)}?${new URLSearchParams(query)}`));
    return { status: response.status, body: await response.json() as any };
  };
  /** What one request asks of the order store: calls into the index, and immutable pages it fetched. */
  const spend = async (query: Record<string, string>) => {
    const reads = objectReads, graph = queries.length;
    const calls: Record<string, number> = { range: 0, hydrate: 0, ordinal: 0 };
    const spies = (['range', 'hydrate', 'ordinal'] as const).map(method => {
      const original = ReadingOrderIndex.prototype[method] as (...args: unknown[]) => unknown;
      return spyOn(ReadingOrderIndex.prototype, method).mockImplementation(function (this: ReadingOrderIndex, ...args: unknown[]) {
        calls[method]!++; return original.apply(this, args) as never;
      } as never);
    });
    const answer = await call(query).finally(() => spies.forEach(spy => spy.mockRestore()));
    return { ...answer, orderCalls: calls, objectReads: objectReads - reads, graphCalls: queries.length - graph };
  };
  return { call, spend, hide: (resource: string) => hidden.add(resource) };
}

function book(count: number, hiddenTargets = new Set<number>()) {
  const work = id(), structure = id(), revision = id();
  const hiddenResources = new Map<number, string>();
  const chapters: ReadingOccurrence[] = Array.from({ length: count }, (_, index) => {
    if (hiddenTargets.has(index + 1)) hiddenResources.set(index + 1, id());
    return { occurrence: id(), work, structure, revision, parent: structure, segmentKey: 'a', orderKey: key(index + 1),
      role: 'chapter', target: hiddenResources.get(index + 1) ?? 'https://schema.org/DigitalDocument',
      labels: [{ value: `Chapter ${index + 1}`, language: 'en' }] };
  });
  const f = fixture(chapters, [{ work, structure, revision }]);
  for (const resource of hiddenResources.values()) f.hide(resource);
  return { ...f, work, chapters, at: (chapter: number) => chapters[chapter - 1]!.occurrence };
}

/** A series of volumes, each a composed Work of chapters, as the graph and order store hold it. */
function serial(volumeCount: number, chapterCount: number) {
  const series = id(), seriesStructure = id(), seriesRevision = id();
  const volumes = Array.from({ length: volumeCount }, () => ({ work: id(), structure: id(), revision: id() }));
  const inventory: ReadingOccurrence[] = [];
  const parts = volumes.map((volume, index) => {
    const part: ReadingOccurrence = { occurrence: id(), work: series, structure: seriesStructure, revision: seriesRevision,
      parent: seriesStructure, segmentKey: 'a', orderKey: key(index + 1), role: 'part', target: volume.work };
    inventory.push(part);
    for (let chapter = 1; chapter <= chapterCount; chapter++) inventory.push({ occurrence: id(), work: volume.work,
      structure: volume.structure, revision: volume.revision, parent: volume.structure, segmentKey: 'a', orderKey: key(chapter),
      role: 'chapter', target: 'https://schema.org/DigitalDocument' });
    return part;
  });
  const composed = [{ work: series, structure: seriesStructure, revision: seriesRevision }, ...volumes];
  return { inventory, volumes, parts, composed, chapters: inventory.filter(item => item.role === 'chapter') };
}

const found = (side: { status: string; occurrence?: string }) => side.status === 'found' ? side.occurrence : side.status;

test('a reader at chapter 240 of a 300-chapter Work has both neighbours', async () => {
  const f = book(300);
  const answer = await f.call({ around: f.at(240) });
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ scope: 'neighbours', resolved: 'start', complete: true, nextCursor: null });
  expect(answer.body.neighbours.previous).toEqual({ status: 'found', occurrence: f.at(239) });
  expect(answer.body.neighbours.next).toEqual({ status: 'found', occurrence: f.at(241) });
  expect(answer.body.items.map((item: ReadingOccurrence) => item.occurrence)).toEqual([f.at(239), f.at(241)]);
  // A sibling ordinal counts placements the reader may not see; the neighbour read never returns one.
  for (const item of answer.body.items) expect(item.ordinal).toBeUndefined();
  expect(answer.body.items[0].labels).toEqual([{ value: 'Chapter 239', language: 'en' }]);
  const ends = await Promise.all([1, 300].map(chapter => f.call({ around: f.at(chapter) })));
  expect(ends[0]!.body.neighbours).toMatchObject({ previous: { status: 'none' }, next: { status: 'found', occurrence: f.at(2) } });
  expect(ends[1]!.body.neighbours).toMatchObject({ previous: { status: 'found', occurrence: f.at(299) }, next: { status: 'none' } });
  expect(ends[0]!.body.items).toHaveLength(1);
});

test('the read says whether the selected position has reached the chapter', async () => {
  const f = book(300);
  const at = async (chapter: number, position: string) => (await f.call({ around: f.at(chapter), position })).body;
  expect((await at(239, f.at(240))).neighbours.reached).toBe(true);
  expect((await at(240, f.at(240))).neighbours.reached).toBe(true);
  expect((await at(241, f.at(240))).neighbours.reached).toBe(false);
  expect((await at(300, 'all')).neighbours.reached).toBe(true);
  expect(await at(1, f.at(240))).toMatchObject({ resolved: f.at(240) });
  // Anonymous Mine has not started: nothing is reached, and it is not an error.
  expect((await f.call({ around: f.at(1) })).body).toMatchObject({ resolved: 'start', neighbours: { reached: false } });
});

test('a hidden chapter between two visible ones is skipped, and a run longer than the scan window is not guessed', async () => {
  const f = book(300, new Set([241, 242, ...Array.from({ length: 40 }, (_, index) => 100 + index)]));
  const skipped = await f.call({ around: f.at(240) });
  expect(skipped.body.neighbours.next).toEqual({ status: 'found', occurrence: f.at(243) });
  expect(skipped.body.neighbours.previous).toEqual({ status: 'found', occurrence: f.at(239) });
  const hiddenOccurrences = [241, 242, ...Array.from({ length: 40 }, (_, index) => 100 + index)].map(chapter => f.at(chapter));
  for (const item of skipped.body.items) expect(hiddenOccurrences).not.toContain(item.occurrence);
  // Chapter 140 sits behind forty hidden chapters (100–139): more than one window can pass.
  const beyond = await f.call({ around: f.at(140) });
  expect(beyond.body.neighbours.previous).toEqual({ status: 'bound' });
  expect(beyond.body.neighbours.next).toEqual({ status: 'found', occurrence: f.at(141) });
  expect(beyond.body.items.map((item: ReadingOccurrence) => item.occurrence)).toEqual([f.at(141)]);
  // A shorter hidden run is crossed.
  const near = await f.call({ around: f.at(150) });
  expect(near.body.neighbours.previous).toEqual({ status: 'found', occurrence: f.at(149) });
});

test('an occurrence the reader cannot see reads exactly like one that does not exist', async () => {
  const f = book(60, new Set([30]));
  const missing = await f.call({ around: id() });
  const hiddenChapter = await f.call({ around: f.at(30) });
  const notAChapter = await f.call({ around: f.chapters[0]!.work });
  expect(missing.status).toBe(404);
  expect(hiddenChapter).toEqual(missing);
  expect(notAChapter).toEqual(missing);
  expect(JSON.stringify(hiddenChapter.body)).not.toContain(f.at(30));
  // The same holds inside a volume the reader cannot read.
  const series = serial(3, 3);
  const s = fixture(series.inventory, series.composed);
  s.hide(series.volumes[1]!.work);
  const insideHidden = await s.call({ around: series.chapters[4]!.occurrence });
  expect(insideHidden.status).toBe(404);
  expect(insideHidden).toEqual(await s.call({ around: id() }));
});

test('neighbours cross volume and group boundaries, skipping a volume the reader cannot read', async () => {
  const series = id(), seriesStructure = id(), seriesRevision = id();
  const volumes = [1, 2, 3].map(() => ({ work: id(), structure: id(), revision: id() }));
  const inventory: ReadingOccurrence[] = [];
  const group = id();
  volumes.forEach((volume, index) => {
    inventory.push({ occurrence: id(), work: series, structure: seriesStructure, revision: seriesRevision,
      parent: seriesStructure, segmentKey: 'a', orderKey: key(index + 1), role: 'part', target: volume.work });
    const chapter = (orderKey: string, parent = volume.structure): ReadingOccurrence => ({ occurrence: id(), work: volume.work,
      structure: volume.structure, revision: volume.revision, parent, segmentKey: 'a', orderKey, role: 'chapter',
      target: 'https://schema.org/DigitalDocument' });
    inventory.push(chapter('00001'), chapter('00002'));
    if (index === 1) inventory.push({ occurrence: group, work: volume.work, structure: volume.structure, revision: volume.revision,
      parent: volume.structure, segmentKey: 'a', orderKey: '00003', role: 'group', target: null },
    chapter('00001', group), chapter('00002', group));
  });
  const inVolume = (volume: number) => inventory.filter(item => item.work === volumes[volume]!.work && item.role === 'chapter');
  const [v1, v2, v3] = [inVolume(0), inVolume(1), inVolume(2)];
  const composed = [{ work: series, structure: seriesStructure, revision: seriesRevision }, ...volumes];
  const f = fixture(inventory, composed);
  const chain = [...v1, v2[0]!, v2[1]!, v2[2]!, v2[3]!, ...v3].map(item => item.occurrence);
  for (const [index, occurrence] of chain.entries()) {
    const answer = await f.call({ around: occurrence });
    expect(answer.status).toBe(200);
    expect(found(answer.body.neighbours.previous)).toBe(chain[index - 1] ?? 'none');
    expect(found(answer.body.neighbours.next)).toBe(chain[index + 1] ?? 'none');
  }
  // Volume 2 is private: its chapters and their order are not revealed, and the neighbours join the others.
  const g = fixture(inventory, composed);
  g.hide(volumes[1]!.work);
  const across = await g.call({ around: v1[1]!.occurrence });
  expect(across.body.neighbours.next).toEqual({ status: 'found', occurrence: v3[0]!.occurrence });
  expect((await g.call({ around: v3[0]!.occurrence })).body.neighbours.previous).toEqual({ status: 'found', occurrence: v1[1]!.occurrence });
});

test('the read costs the same at chapter 240 as at chapter 3, and states its bound', async () => {
  const f = book(300);
  const early = await f.spend({ around: f.at(3) });
  const late = await f.spend({ around: f.at(240) });
  expect(early.status).toBe(200);
  expect(early.orderCalls.range).toBe(2);
  expect(late.orderCalls).toEqual(early.orderCalls);
  expect(late.graphCalls).toBe(early.graphCalls);
  // Pages fetched are a root-to-leaf path per seek, not a function of the place. Chapter 3 shares the leftmost leaf
  // with the start of the sibling run, which every ordinal counts from, so compare two interior chapters.
  expect(late.objectReads).toBeGreaterThan(0);
  expect((await f.spend({ around: f.at(150) })).objectReads).toBe(late.objectReads);
  // The same holds for a Work ten times as long.
  const long = book(3000);
  const [far, near] = [await long.spend({ around: long.at(2500) }), await long.spend({ around: long.at(3) })];
  expect(far.orderCalls).toEqual(near.orderCalls);
  expect(far.graphCalls).toBe(near.graphCalls);
  expect((await long.spend({ around: long.at(1500) })).objectReads).toBe(far.objectReads);
  expect(late.body.cost.lookupScanRows).toBe(READING_POSITION_COST.lookupScanRows);
  expect(READING_POSITION_COST.lookupScanRows).toBe(READING_CHOOSER_COST.scanRows);
  // Even a worst case of hidden chapters spends at most the scan window of order reads in each direction.
  const walled = book(300, new Set([...Array.from({ length: 100 }, (_, index) => 50 + index), ...Array.from({ length: 100 }, (_, index) => 151 + index)]));
  const bounded = await walled.spend({ around: walled.at(150) });
  expect(bounded.body.neighbours.previous.status).toBe('bound');
  expect(bounded.body.neighbours.next.status).toBe('bound');
  expect(bounded.graphCalls).toBeLessThanOrEqual(2 * READING_CHOOSER_COST.scanRows * 3);
});

test('a lookup takes one of around or firstSeen and no page parameters', async () => {
  const f = book(10);
  const record = id();
  const invalid: Array<Record<string, string>> = [{ around: f.at(2), firstSeen: record }, { around: f.at(2), cursor: 'x' }, { around: f.at(2), limit: '5' },
    { around: f.at(2), q: 'chapter' }, { firstSeen: record, q: 'chapter' }];
  for (const query of invalid) {
    expect((await f.call(query)).status).toBe(400);
  }
  expect((await f.call({ around: 'chapter-2' })).status).toBe(422);
});

test('a record first appears at the chapter it is revealed in, or the first one the reader may see from there', async () => {
  const work = id(), structure = id(), revision = id();
  const hiddenTarget = id();
  const chapters: ReadingOccurrence[] = Array.from({ length: 300 }, (_, index) => ({ occurrence: id(), work, structure, revision,
    parent: structure, segmentKey: 'a', orderKey: key(index + 1), role: 'chapter',
    target: index + 1 === 100 ? hiddenTarget : 'https://schema.org/DigitalDocument',
    labels: [{ value: `Chapter ${index + 1}`, language: 'en' }], displayLabel: `Chapter ${index + 1}` }));
  const at = (chapter: number) => chapters[chapter - 1]!.occurrence;
  const [plain, withheld, spoiler, unplaced, early, late] = [id(), id(), id(), id(), id(), id()];
  const f = fixture(chapters, [{ work, structure, revision }], [
    { record: plain, occurrence: at(40) }, { record: withheld, occurrence: at(100) }, { record: spoiler, occurrence: at(260) },
    { record: early, occurrence: at(5) }, { record: late, occurrence: at(240) }]);
  f.hide(hiddenTarget);
  const seen = (record: string, position: string) => f.call({ firstSeen: record, position });
  const first = await seen(plain, at(250));
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ scope: 'first-appearance', resolved: at(250), appearance: { status: 'found', occurrence: at(40) } });
  expect(first.body.items.map((item: ReadingOccurrence) => item.occurrence)).toEqual([at(40)]);
  expect(first.body.items[0].labels).toEqual([{ value: 'Chapter 40', language: 'en' }]);
  expect(first.body.items[0].displayLabel).toBe('Chapter 40');
  const beside = await f.call({ around: at(40) });
  const earlier = beside.body.items.find((item: ReadingOccurrence) => item.occurrence === at(39));
  expect(earlier.labels).toEqual([{ value: 'Chapter 39', language: 'en' }]);
  expect(earlier.displayLabel).toBe('Chapter 39');
  expect((await seen(withheld, at(250))).body.appearance).toEqual({ status: 'found', occurrence: at(101) });
  // A record not yet shown at the reader's position, or not placed in this Work, answers as one that does not exist.
  const ahead = await seen(spoiler, at(250));
  expect(ahead.status).toBe(404);
  expect(await seen(unplaced, at(250))).toEqual(ahead);
  expect(JSON.stringify(ahead.body)).not.toContain(at(260));
  const everything = await f.call({ firstSeen: spoiler, position: 'all' });
  expect(everything.body).toMatchObject({ resolved: 'all', appearance: { status: 'found', occurrence: at(260) } });
  // The cost does not depend on where the record first appears.
  const [soon, later] = [await f.spend({ firstSeen: early, position: at(250) }), await f.spend({ firstSeen: late, position: at(250) })];
  expect(later.body.appearance).toEqual({ status: 'found', occurrence: at(240) });
  expect(later.graphCalls).toBe(soon.graphCalls);
});

test('a record revealed at a volume first appears at the first chapter the reader may see inside it', async () => {
  const { inventory, volumes, parts, composed, chapters } = serial(2, 2);
  const [volumeRecord, hiddenRecord] = [id(), id()];
  const f = fixture(inventory, composed, [
    { record: volumeRecord, occurrence: parts[1]!.occurrence }, { record: hiddenRecord, occurrence: parts[0]!.occurrence }]);
  const position = chapters[3]!.occurrence;
  expect((await f.call({ firstSeen: volumeRecord, position })).body.appearance)
    .toEqual({ status: 'found', occurrence: chapters[2]!.occurrence });
  f.hide(volumes[0]!.work);
  // A record revealed inside a volume the reader cannot read is withheld by the boundary itself, so it has no first appearance to give.
  expect((await f.call({ firstSeen: hiddenRecord, position })).status).toBe(404);
});
