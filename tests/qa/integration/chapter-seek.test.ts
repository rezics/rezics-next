import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FusekiClient, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects, type ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { ReadingOrderIndex } from '../../../services/main/src/modules/reading-position/immutable-order.ts';
import { orderTree, recordTree } from '../../../services/main/src/modules/structure/change.ts';
import { bookGroupQualifierId, divisionIri } from '../../../services/main/src/modules/structure/book-group.ts';
import { checkStructureManifest, STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../../../services/main/src/modules/structure/format.ts';
import { itemListIri, orderTreeKey, placementIri, readCompositionHeader } from '../../../services/main/src/modules/structure/graph.ts';
import { readCompositionPage, readCompositionSnapshot } from '../../../services/main/src/modules/structure/read.ts';
import { seekChapter } from '../../../services/main/src/modules/structure/reading-order.ts';
import { newCost } from '../../../services/main/src/modules/structure/tree.ts';
import { chapterStoryNumber } from '../../../services/main/src/modules/work-contents/read.ts';
import { GRAPHS, ID, RV, iri, lit, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { WorkReadSession, WorkReadLimit } from '../../../services/main/src/modules/work/read-session.ts';

/** Count actual cold S3 reads, rather than the length of a returned page. */
class ObservedObjects implements ImmutableObjects {
  gets = 0;
  bytes = 0;
  constructor(readonly source: ImmutableObjects) {}
  put(bytes: Uint8Array) { return this.source.put(bytes); }
  async get(digest: string) {
    const bytes = await this.source.get(digest);
    this.gets++;
    this.bytes += bytes.length;
    return bytes;
  }
  reset() { this.gets = 0; this.bytes = 0; }
}

class ObservedGraph extends FusekiClient {
  reads: Array<{ query: string; bindings: number; bytes: number }> = [];
  override async query(query: string, maxBytes?: number): Promise<SparqlResult> {
    const result = await super.query(query, maxBytes);
    this.reads.push({ query, bindings: result.results?.bindings.length ?? 0,
      bytes: Buffer.byteLength(JSON.stringify(result)) });
    return result;
  }
}

async function fixture() {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.MAIN_OBJECT_DIRECTORY || !Bun.env.MAIN_S3_ENDPOINT) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const graph = new ObservedGraph(Bun.env.FUSEKI_URL);
  const source = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await source.initialize();
  const objects = new ObservedObjects(source);
  const env: WorkActivationEnvironment & { structureObjects: ImmutableObjects } = {
    fuseki: graph, structureObjects: objects, objectDirectory: Bun.env.MAIN_OBJECT_DIRECTORY,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH } };
  const reset = () => { objects.reset(); graph.reads = []; };
  const observed = () => ({ gets: objects.gets, bytes: objects.bytes,
    queries: graph.reads.length, bindings: graph.reads.reduce((sum, read) => sum + read.bindings, 0),
    graphBytes: graph.reads.reduce((sum, read) => sum + read.bytes, 0) });
  const session = () => new WorkReadSession({ environment: env } as MainWorkDependencies,
    new Request('http://main.local/v1/chapters'), {}, { dataEpoch: env.lineage.dataEpoch, sequence: '2' });
  return { graph, objects, env, reset, observed, session };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Book = Awaited<ReturnType<typeof book>>;
const contentRevision = () => `urn:rezics:content:revision:${randomUUID()}`;

function bookIdentities() {
  const salt = randomUUID().slice(0, 8);
  const id = (index: number) => `${ID}${salt}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
  return { salt, id, structure: id(1), owner: id(2), component: id(3), historical: id(4), current: id(5) };
}

function bookRecords(ids: ReturnType<typeof bookIdentities>) {
  const records: OccurrenceRecord[] = [];
  let identity = 100;
  const record = (parent: string, index: number, role: 'chapter' | 'group',
    division?: 'volume' | 'part' | 'extras'): OccurrenceRecord => {
    const occurrence = ids.id(identity++);
    const value: OccurrenceRecord = { occurrence, state: 'active', parent,
      segmentKey: Math.floor(index / 32).toString(36).padStart(6, '0'),
      orderKey: (index % 32).toString(36).padStart(2, '0'), role, introducedBy: ids.historical,
      labels: [{ value: role === 'chapter' ? 'Chapter' : 'Volume', language: 'en' }],
      ...(role === 'chapter' ? { target: ids.id(1_000_000 + identity), selection: { mode: 'follow-context' as const } }
        : { qualifier: { type: 'book-group' as const, division: division ?? 'volume' } }) };
    records.push(value);
    return value;
  };
  return { records, record };
}

/** Use the existing immutable format, counted tree writer and current placement
 * projection. The fixture installs no additional navigation index. */
async function book(f: Fixture, groupCount: number, childrenPerGroup: number) {
  const ids = bookIdentities(), { structure } = ids;
  const { records, record } = bookRecords(ids);
  const first = record(structure, 0, 'chapter');
  const groups: OccurrenceRecord[] = [], children: OccurrenceRecord[][] = [];
  for (let group = 0; group < groupCount; group++) {
    const parent = record(structure, group + 1, 'group');
    groups.push(parent);
    children.push(Array.from({ length: childrenPerGroup }, (_, index) => record(parent.occurrence, index, 'chapter')));
  }
  const extras = record(structure, groupCount + 1, 'group', 'extras');
  const denied = record(extras.occurrence, 0, 'chapter');
  const unpublished = record(extras.occurrence, 1, 'chapter');
  const fixed = record(extras.occurrence, 2, 'chapter');
  const oldPin = contentRevision(), newPin = contentRevision();
  fixed.selection = { mode: 'fixed-revision', revision: oldPin };
  const last = record(structure, groupCount + 2, 'chapter');
  const currentFixed: OccurrenceRecord = { ...fixed, selection: { mode: 'fixed-revision', revision: newPin } };
  const installed = await installBook(f, ids, records, currentFixed);
  return { ...installed, first, groups, children, extras,
    denied, unpublished, fixed, currentFixed, last, oldPin, newPin };
}

async function installBook(f: Fixture, ids: ReturnType<typeof bookIdentities>,
  records: OccurrenceRecord[], currentFixed?: OccurrenceRecord) {
  const { salt, id, structure, owner, component, historical, current } = ids;
  const cost = newCost(), recordIndex = recordTree(f.objects), orderIndex = orderTree(f.objects);
  const immutableRecords = await recordIndex.apply(await recordIndex.empty(cost),
    new Map(records.map(value => [value.occurrence, value])), cost);
  const ordered: OrderEntry[] = records.map(({ parent, segmentKey, orderKey, occurrence }) =>
    ({ parent, segmentKey: segmentKey!, orderKey: orderKey!, occurrence }));
  const immutableOrder = await orderIndex.apply(await orderIndex.empty(cost),
    new Map(ordered.map(value => [orderTreeKey(value), value])), cost);
  const groups = records.filter(value => value.state === 'active' && value.parent === structure && value.role === 'group');
  const topGroups = await orderIndex.apply(await orderIndex.empty(cost),
    new Map(groups.map(value => {
      const entry: OrderEntry = { parent: value.parent, segmentKey: value.segmentKey!,
        orderKey: value.orderKey!, occurrence: value.occurrence };
      return [orderTreeKey(entry), entry];
    })), cost);
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure,
    structureOf: component, profile: 'book-composition', generation: id(6), pageFormat: STRUCTURE_PAGE_FORMAT,
    records: immutableRecords, order: immutableOrder, topGroups, placementCount: records.length, measures: [],
    model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const store = async (value: StructureManifest) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    checkStructureManifest(bytes);
    return `urn:rezics:sha256:${await f.objects.put(bytes)}`;
  };
  const historicalManifest = await store(manifest);
  const currentRecords = currentFixed
    ? await recordIndex.apply(immutableRecords, new Map([[currentFixed.occurrence, currentFixed]]), cost) : immutableRecords;
  const currentManifest = await store({ ...manifest, generation: id(7), records: currentRecords });
  await f.graph.update(`PREFIX rv: <${RV}> INSERT DATA {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(structure)} a rv:Structure ; rv:structureProfile rv:BookComposition ; rv:structureOf ${iri(component)} ;
        rv:structureHead ${iri(current)} ; rv:selectedGeneration ${iri(id(7))} .
      ${iri(id(7))} a rv:StructureGeneration ; rv:structure ${iri(structure)} ; rv:generationState rv:Active ; rv:placementCount ${records.length} .
      ${iri(owner)} a <https://schema.org/Book> ; rv:mainVersion ${iri(component)} .
      ${iri(component)} a rv:MainVersion .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(historical)} a rv:StructureRevision ; rv:component ${iri(structure)} ; rv:manifest ${iri(historicalManifest)} ;
        rv:placementCount ${records.length} ; rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence 1 .
      ${iri(current)} a rv:StructureRevision ; rv:component ${iri(structure)} ; rv:manifest ${iri(currentManifest)} ;
        rv:placementCount ${records.length} ; rv:dataEpoch ${lit(f.env.lineage.dataEpoch)} ; rv:sequence 2 ;
        rv:predecessor ${iri(historical)} .
    }
  }`);
  const segments = new Map<string, { id: string; parent: string; key: string; count: number }>();
  for (const value of records) {
    const key = `${value.parent}\u0001${value.segmentKey}`;
    const segment = segments.get(key) ?? { id: `urn:rezics:chapter-seek-segment:${salt}:${segments.size}`,
      parent: value.parent, key: value.segmentKey!, count: 0 };
    segment.count++;
    segments.set(key, segment);
  }
  const projection: string[] = [...segments.values()].map(segment => `${iri(segment.id)} a rv:OrderSegment ;
    rv:generation ${iri(id(7))} ; rv:parent ${iri(segment.parent)} ; rv:segmentKey ${lit(segment.key)} ;
    rv:memberCount ${segment.count} .`);
  for (const value of records) {
    const placement = placementIri(id(7), value.occurrence);
    const segment = segments.get(`${value.parent}\u0001${value.segmentKey}`)!;
    const list = itemListIri(id(7), value.parent);
    const qualifier = value.qualifier?.type === 'book-group' ? bookGroupQualifierId(placement) : null;
    const selection = currentFixed && value.occurrence === currentFixed.occurrence ? currentFixed.selection : value.selection;
    projection.push(`${iri(placement)} a rv:OccurrencePlacement, <https://schema.org/ListItem> ;
      rv:generation ${iri(id(7))} ; rv:occurrence ${iri(value.occurrence)} ;
      rv:occurrenceRole rv:${value.role === 'chapter' ? 'ChapterRole' : 'GroupRole'} ;
      rv:orderSegment ${iri(segment.id)} ; rv:orderKey ${lit(value.orderKey!)} ;
      <https://schema.org/position> ${lit(`${value.segmentKey}-${value.orderKey}`)} ;
      <https://schema.org/item> ${iri(value.target ?? qualifier ?? value.occurrence)} .
      ${iri(value.occurrence)} rv:introducedBy ${iri(historical)} .
      ${iri(list)} a <https://schema.org/ItemList> ; rv:generation ${iri(id(7))} ;
        rv:parent ${iri(value.parent)} ; <https://schema.org/itemListElement> ${iri(placement)} .
      ${selection ? `${iri(placement)} rv:selectionMode rv:${selection.mode === 'fixed-revision' ? 'FixedRevision' : 'FollowContext'} .` : ''}
      ${selection?.mode === 'fixed-revision' ? `${iri(placement)} rv:pinnedRevision ${iri(selection.revision)} .` : ''}
      ${qualifier && value.qualifier?.type === 'book-group' ? `${iri(placement)} rv:qualifier ${iri(qualifier)} .
        ${iri(qualifier)} a rv:BookGroup ; rv:generation ${iri(id(7))} ; rv:bookDivision <${divisionIri(value.qualifier.division)}> .` : ''}`);
  }
  for (let offset = 0; offset < projection.length; offset += 250) {
    await f.graph.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${projection.slice(offset, offset + 250).join('\n')} } }`);
  }
  return { structure, owner, component, historical, current, placementCount: records.length };
}

/** Keep a traversal oracle while authoring mixed sibling order. The oracle
 * counts chapters through volumes/parts and excludes extras, independently of
 * the reader's rank/subtree arithmetic. */
async function numberedBook(f: Fixture, chapterCount: number, divisions: Array<{
  after: number; division: 'volume' | 'part' | 'extras'; chapters: number;
}> = []) {
  const ids = bookIdentities(), { records, record } = bookRecords(ids);
  const direct: OccurrenceRecord[] = [], grouped: OccurrenceRecord[][] = [];
  const numbers = new Map<string, number | null>();
  let sibling = 0, story = 0;
  for (let at = 0; at <= chapterCount; at++) {
    for (const division of divisions.filter(value => value.after === at)) {
      const group = record(ids.structure, sibling++, 'group', division.division);
      const children: OccurrenceRecord[] = [];
      for (let child = 0; child < division.chapters; child++) {
        const chapter = record(group.occurrence, child, 'chapter');
        numbers.set(chapter.occurrence, division.division === 'extras' ? null : ++story);
        children.push(chapter);
      }
      grouped.push(children);
    }
    if (at < chapterCount) {
      const chapter = record(ids.structure, sibling++, 'chapter');
      numbers.set(chapter.occurrence, ++story);
      direct.push(chapter);
    }
  }
  return { ...await installBook(f, ids, records), direct, grouped, numbers, groupCount: divisions.length };
}

/** Every measured graph read names the selected immutable root or its owner
 * component. Returned rows alone would not disprove a population sort/SUM. */
function expectExactGraph(f: Fixture, b: Awaited<ReturnType<typeof installBook>>, revision: string) {
  expect(f.graph.reads).toHaveLength(3);
  const [header, owner, exact] = f.graph.reads;
  expect(header!.query).toContain(`${iri(b.structure)} a rv:Structure`);
  expect(owner!.query).toContain(iri(b.component));
  expect(exact!.query).toContain(`${iri(revision)} a rv:StructureRevision`);
  for (const read of f.graph.reads) {
    expect(read.bindings).toBe(1);
    expect(read.query).not.toMatch(/ORDER\s+BY|GROUP\s+BY|SUM\s*\(|rv:OrderSegment|rv:ChapterRole|rv:OccurrencePlacement/iu);
  }
  expect(f.observed().graphBytes).toBeLessThan(8_192);
}

async function snapshot(f: Fixture, b: Awaited<ReturnType<typeof installBook>>, revision?: string) {
  const session = f.session(), cache = new ReadingOrderIndex(session, f.objects);
  const header = await readCompositionHeader(f.env, b.structure);
  if (!header) throw new Error('fixture header missing');
  return { session, selected: await readCompositionSnapshot(f.env, {
    structure: b.structure, header, ...(revision ? { revision } : {}), objects: cache.objects }) };
}

test('chapter neighbourhood: 1,000/5,000/10,000 actual children stay local across groups, denied candidates and fixed pins', async () => {
  const preparation = performance.now(), f = await fixture();
  const books: Book[] = [];
  for (const count of [1_000, 5_000, 10_000]) books.push(await book(f, 1, count));
  expect(performance.now() - preparation).toBeLessThan(600_000);
  const measurements = [];
  for (const b of books) {
    f.reset();
    const { selected } = await snapshot(f, b);
  expect(selected.manifest.placementCount).toBe(b.placementCount);
    expect(selected.manifest.order.count).toBe(b.placementCount);
    expect(selected.manifest.records.count).toBe(b.placementCount);
    const accepted: string[] = [];
    const next = await seekChapter(f.env, { structure: b.structure, snapshot: selected,
      from: b.children[0]!.at(-1)!, canReadTarget: async target => target !== b.denied.target,
      accept: async candidate => { accepted.push(candidate.occurrence); return candidate.occurrence !== b.unpublished.occurrence; } });
    expect(next?.record.occurrence).toBe(b.fixed.occurrence);
    expect(next?.record.selection).toEqual({ mode: 'fixed-revision', revision: b.newPin });
    expect(accepted).toEqual([b.unpublished.occurrence, b.fixed.occurrence]);
    expectExactGraph(f, b, b.current);
    measurements.push(f.observed());
    expect(f.objects.gets).toBeLessThanOrEqual(20);
    expect(f.objects.bytes).toBeLessThan(1_600_000);

    f.reset();
    const historical = await snapshot(f, b, b.historical);
    const retained = await seekChapter(f.env, { structure: b.structure, snapshot: historical.selected,
      from: b.children[0]!.at(-1)!, canReadTarget: async target => target !== b.denied.target,
      accept: async candidate => candidate.occurrence !== b.unpublished.occurrence });
    expect(retained?.record.selection).toEqual({ mode: 'fixed-revision', revision: b.oldPin });
    expect(retained?.page.revision).toBe(b.historical);
    expectExactGraph(f, b, b.historical);
    const previous = await seekChapter(f.env, { structure: b.structure, snapshot: historical.selected,
      from: b.fixed, direction: 'previous', canReadTarget: async target => target !== b.denied.target,
      accept: async candidate => candidate.occurrence !== b.unpublished.occurrence });
    expect(previous?.record.occurrence).toBe(b.children[0]!.at(-1)!.occurrence);
    expect(await seekChapter(f.env, { structure: b.structure, snapshot: historical.selected,
      from: b.first, direction: 'previous', canReadTarget: async () => true })).toBeNull();
    expect(await seekChapter(f.env, { structure: b.structure, snapshot: historical.selected,
      from: b.last, canReadTarget: async () => true })).toBeNull();
  }
  // All roots have the same height: population growth must not add a leaf walk.
  expect(measurements.map(value => value.gets)).toEqual([measurements[0]!.gets, measurements[0]!.gets, measurements[0]!.gets]);
  console.info('chapter neighbourhood physical work', JSON.stringify({ chapters: [1000, 5000, 10_000], measurements }));

  const selectedBook = books[0]!;
  const measure = async () => {
    f.reset();
    const { selected } = await snapshot(f, selectedBook);
    const found = await seekChapter(f.env, { structure: selectedBook.structure, snapshot: selected,
      from: selectedBook.children[0]!.at(-1)!, canReadTarget: async target => target !== selectedBook.denied.target,
      accept: async candidate => candidate.occurrence !== selectedBook.unpublished.occurrence });
    expect(found?.record.occurrence).toBe(selectedBook.fixed.occurrence);
    expectExactGraph(f, selectedBook, selectedBook.current);
    return f.observed();
  };
  const before = await measure();
  // Add actual unrelated groups/chapters, current placements and segments as
  // well as retained object trees. The selected cold read must be identical.
  await book(f, 3_000, 1);
  expect(await measure()).toEqual(before);
}, 600_000);

test('chapter numbering: exact child counts number 10,000 chapters; 3,000 groups refuse before hydration', async () => {
  const preparation = performance.now(), f = await fixture();
  const smallRoot = await book(f, 1, 10_000), manyGroups = await book(f, 3_000, 1);
  expect(performance.now() - preparation).toBeLessThan(600_000);
  f.reset();
  const { session, selected } = await snapshot(f, smallRoot);
  const chapter = smallRoot.children[0]!.at(-1)!;
  const exact = await readCompositionPage(f.env, { structure: smallRoot.structure,
    snapshot: selected, occurrence: chapter.occurrence, limit: 1, canReadTarget: async () => true });
  expect(exact.occurrenceContext?.ordinal).toBe(10_000);
  expect(await chapterStoryNumber(session, selected.header, chapter, exact.occurrenceContext!, selected)).toBe(10_001);
  expect(f.objects.gets).toBeLessThanOrEqual(14);
  expect(f.objects.bytes).toBeLessThan(1_200_000);
  expectExactGraph(f, smallRoot, smallRoot.current);

  f.reset();
  const large = await snapshot(f, manyGroups);
  const before = f.objects.gets;
  expect(await chapterStoryNumber(large.session, large.selected.header, manyGroups.first,
    { ordinal: 1, path: [] }, large.selected)).toBeNull();
  expect(large.selected.manifest.topGroups?.count).toBe(3_001);
  // The retained group-root count refuses numbering without reading any tree.
  expect(f.objects.gets - before).toBe(0);
  expect(f.objects.gets).toBeLessThanOrEqual(4);
  expect(f.objects.bytes).toBeLessThan(200_000);
  expectExactGraph(f, manyGroups, manyGroups.current);

  f.reset();
  const navigation = await snapshot(f, manyGroups);
  const middle = manyGroups.children[1_500]![0]!;
  const deniedNext = manyGroups.children[1_501]![0]!;
  const found = await seekChapter(f.env, { structure: manyGroups.structure,
    snapshot: navigation.selected, from: middle,
    canReadTarget: async target => target !== deniedNext.target });
  expect(found?.record.occurrence).toBe(manyGroups.children[1_502]![0]!.occurrence);
  expect(f.objects.gets).toBeLessThanOrEqual(20);
  expect(f.objects.bytes).toBeLessThan(1_600_000);
  expectExactGraph(f, manyGroups, manyGroups.current);
  await expect(seekChapter(f.env, { structure: manyGroups.structure, snapshot: large.selected,
    from: manyGroups.first, maxSteps: 1, canReadTarget: async () => false })).rejects.toBeInstanceOf(WorkReadLimit);
}, 600_000);

test('chapter numbering keeps 201/10,000 direct chapters and sparse interspersed groups eligible', async () => {
  const preparation = performance.now(), f = await fixture();
  const cases = [
    await numberedBook(f, 201),
    await numberedBook(f, 10_000),
    await numberedBook(f, 200, [{ after: 0, division: 'volume', chapters: 3 }]),
    await numberedBook(f, 10_000, [
      { after: 1, division: 'volume', chapters: 3 },
      { after: 5_000, division: 'extras', chapters: 2 },
      { after: 9_999, division: 'part', chapters: 4 },
    ]),
  ];
  expect(performance.now() - preparation).toBeLessThan(600_000);
  for (const b of cases) {
    const measurements: ReturnType<typeof f.observed>[] = [];
    const indices = [...new Set([0, 99, 199, 200, Math.floor(b.direct.length / 2), b.direct.length - 1])]
      .filter(index => index < b.direct.length);
    const targets = b.direct.length === 201 ? b.direct : [...indices.map(index => b.direct[index]!), ...b.grouped.flat()];
    const reads = [...targets.map(chapter => ({ chapter, revision: b.current })),
      { chapter: b.direct.at(-1)!, revision: b.historical }];
    for (const { chapter, revision } of reads) {
      f.reset();
      const { session, selected } = await snapshot(f, b, revision);
      expect(selected.manifest.topGroups?.count).toBe(b.groupCount);
      expect(selected.manifest.placementCount).toBe(b.placementCount);
      const exact = await readCompositionPage(f.env, { structure: b.structure, snapshot: selected,
        occurrence: chapter.occurrence, limit: 1, canReadTarget: async () => true });
      expect(exact.occurrences[0]?.occurrence).toBe(chapter.occurrence);
      expect(exact.occurrenceContext).toBeDefined();
      expect(await chapterStoryNumber(session, selected.header, chapter,
        exact.occurrenceContext!, selected)).toBe(b.numbers.get(chapter.occurrence)!);
      expectExactGraph(f, b, revision);
      expect(f.objects.gets).toBeLessThanOrEqual(b.groupCount ? 16 : 8);
      expect(f.objects.bytes).toBeLessThan(b.groupCount ? 1_600_000 : 500_000);
      measurements.push(f.observed());
    }
    console.info('chapter numbering physical work', JSON.stringify({ directChapters: b.direct.length,
      groups: b.groupCount, reads: measurements.length,
      maximumGets: Math.max(...measurements.map(value => value.gets)),
      maximumBytes: Math.max(...measurements.map(value => value.bytes)),
      maximumQueries: Math.max(...measurements.map(value => value.queries)),
      maximumBindings: Math.max(...measurements.map(value => value.bindings)),
      maximumGraphBytes: Math.max(...measurements.map(value => value.graphBytes)) }));
  }
  expect(cases[0]!.numbers.get(cases[0]!.direct[200]!.occurrence)).toBe(201);
  expect(cases[1]!.numbers.get(cases[1]!.direct[9_999]!.occurrence)).toBe(10_000);
  expect(cases[2]!.numbers.get(cases[2]!.direct[199]!.occurrence)).toBe(203);
  expect(cases[3]!.numbers.get(cases[3]!.direct[9_999]!.occurrence)).toBe(10_007);
}, 600_000);
