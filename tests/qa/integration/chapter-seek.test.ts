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

/** Use the existing immutable format, counted tree writer and current placement
 * projection. The fixture installs no additional navigation index. */
async function book(f: Fixture, groupCount: number, childrenPerGroup: number) {
  const salt = randomUUID().slice(0, 8);
  const id = (index: number) => `${ID}${salt}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
  const structure = id(1), owner = id(2), component = id(3), historical = id(4), current = id(5);
  const records: OccurrenceRecord[] = [];
  let identity = 100;
  const record = (parent: string, index: number, role: 'chapter' | 'group',
    division?: 'volume' | 'extras'): OccurrenceRecord => {
    const occurrence = id(identity++);
    const value: OccurrenceRecord = { occurrence, state: 'active', parent,
      segmentKey: Math.floor(index / 32).toString(36).padStart(6, '0'),
      orderKey: (index % 32).toString(36).padStart(2, '0'), role, introducedBy: historical,
      labels: [{ value: role === 'chapter' ? 'Chapter' : 'Volume', language: 'en' }],
      ...(role === 'chapter' ? { target: id(1_000_000 + identity), selection: { mode: 'follow-context' as const } }
        : { qualifier: { type: 'book-group' as const, division: division ?? 'volume' } }) };
    records.push(value);
    return value;
  };
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
  const cost = newCost(), recordIndex = recordTree(f.objects), orderIndex = orderTree(f.objects);
  const immutableRecords = await recordIndex.apply(await recordIndex.empty(cost),
    new Map(records.map(value => [value.occurrence, value])), cost);
  const ordered: OrderEntry[] = records.map(({ parent, segmentKey, orderKey, occurrence }) =>
    ({ parent, segmentKey: segmentKey!, orderKey: orderKey!, occurrence }));
  const immutableOrder = await orderIndex.apply(await orderIndex.empty(cost),
    new Map(ordered.map(value => [orderTreeKey(value), value])), cost);
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure,
    structureOf: component, profile: 'book-composition', generation: id(6), pageFormat: STRUCTURE_PAGE_FORMAT,
    records: immutableRecords, order: immutableOrder, placementCount: records.length, measures: [],
    model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const store = async (value: StructureManifest) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    checkStructureManifest(bytes);
    return `urn:rezics:sha256:${await f.objects.put(bytes)}`;
  };
  const historicalManifest = await store(manifest);
  const currentFixed: OccurrenceRecord = { ...fixed, selection: { mode: 'fixed-revision', revision: newPin } };
  const currentRecords = await recordIndex.apply(immutableRecords, new Map([[fixed.occurrence, currentFixed]]), cost);
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
    const selection = value.occurrence === fixed.occurrence ? currentFixed.selection : value.selection;
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
  return { structure, owner, component, historical, current, first, groups, children, extras,
    denied, unpublished, fixed, currentFixed, last, oldPin, newPin, placementCount: records.length };
}

/** Every measured graph read names the selected immutable root or its owner
 * component. Returned rows alone would not disprove a population sort/SUM. */
function expectExactGraph(f: Fixture, b: Book, revision: string) {
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

async function snapshot(f: Fixture, b: Book, revision?: string) {
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
  // Manifest + two counted order descents, with no record-tree hydration.
  expect(f.objects.gets - before).toBeLessThanOrEqual(3);
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
