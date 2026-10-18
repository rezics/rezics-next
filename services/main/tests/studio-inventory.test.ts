import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ControlDenied } from '../src/modules/access/topology-control.ts';
import { readStudioWork, readStudioWorks, studioSearchQuery, studioTitleKey, STUDIO_WORK_COST,
  type StudioWorkFilters } from '../src/modules/studio/works.ts';
import { countStudioChapterOccurrences, readStudioChapterCount } from '../src/modules/studio/chapters.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadMoved, WorkReadSession, WorkReadUnavailable,
  type ReadRow } from '../src/modules/work/read-session.ts';
import { ObjectNotFound, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { orderTreeKey } from '../src/modules/structure/graph.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type StructureManifest } from '../src/modules/structure/format.ts';
import { newCost } from '../src/modules/structure/tree.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const bookType = 'https://schema.org/Book', documentType = 'https://schema.org/DigitalDocument';
const scalarCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const term = (value: string) => ({ type: 'literal' as const, value });
const result = (rows: ReadRow[]) => ({ results: { bindings: rows } });
type Work = { id: string; main: string; title: string; type: string; created: string; updated: string;
  state: 'empty' | 'draft' | 'published'; relationship: 'authored' | 'curated' };
const work = (n: number, title = `Studio needle ${n}`): Work => ({ id: id(100 + n), main: id(10_000 + n),
  title, type: bookType, created: `2026-09-01T12:00:00.${String(n).padStart(6, '0')}Z`,
  updated: `2026-09-01T12:00:00.${String(n).padStart(6, '0')}Z`, state: 'empty', relationship: 'authored' });

/** Owner boundary doubles: no public API proof or native query-plan qualification. */
function inventoryFixture(works: Work[]) {
  const agent = id(1), position = { dataEpoch: 'fixture', sequence: '1' };
  let denied = false, stamp = 'controller-1', failCounts = false;
  const graphQueries: string[] = [], graphCalls: string[] = [];
  const admission = (item: Work) => ({ id: item.id, work: item.id, writer: agent, generation: '1',
    created_at: new Date(item.created), created_key: item.created, updated_key: item.updated,
    action: 'work.create', state: 'sealed', graph_outcome: 'succeeded' });
  const check = (actor: string) => { if (denied || actor !== agent) throw new ControlDenied('Agent is not controlled'); };
  const access = {
    async studioWorks(_principal: unknown, actor: string, after: string, limit: number) {
      check(actor);
      return { stamp, rows: works.filter(item => item.id > after)
        .sort((a, b) => scalarCompare(a.id, b.id)).slice(0, limit).map(admission) };
    },
    async studioWork(_principal: unknown, actor: string, target: string) {
      check(actor);
      const item = works.find(item => item.id === target);
      return { stamp, row: item ? admission(item) : null };
    },
    async studioWorkDetails() { return { edits: [], submissions: [] }; },
  };
  const head = (item: Work): ReadRow => ({ admission: term(item.id), work: term(item.id), main: term(item.main),
    head: term(`${item.id}/head`), mainHead: term(`${item.main}/head`), title: term(item.title),
    hasText: term(String(item.state !== 'empty')), hasPublication: term(String(item.state === 'published')) });
  const env = { fuseki: { async query(query: string) {
    graphCalls.push(query);
    if (failCounts) throw new WorkReadUnavailable('Composition owner is unavailable');
    return result([]);
  } } };
  function session(cursor?: string, limit = 5) {
    return { principal: { issuer: 'fixture', subject: 'owner', emailVerified: true }, deps: { studioAccess: access, environment: env },
      options: { actingSubject: agent, cursor, limit }, position,
      observeDependency() {},
      async summaries() { return []; },
      async query(query: string) {
        graphQueries.push(query);
        if (query.includes('SELECT ?admission')) return works.filter(item => query.includes(`("${item.id}" <${agent}>)`)
          && (/FILTER NOT EXISTS\s*\{\s*GRAPH[^\n]+rv:NativeAgentCredit/.test(query)
            ? item.relationship === 'curated' : item.relationship === 'authored')
          && (![bookType, documentType].some(type => query.includes(`?work a <${type}>`))
            || query.includes(`?work a <${item.type}>`))).map(head).reverse();
        if (query.includes('SELECT ?main ?head')) return works.filter(item => query.includes(`<${item.id}>`)).map(head);
        if (query.includes('SELECT ?type')) return works.filter(item => query.includes(`<${item.id}>`))
          .map(item => ({ type: term(item.type) }));
        if (query.includes('SELECT ?work ?type')) return works.filter(item => query.includes(`<${item.id}>`))
          .map(item => ({ work: term(item.id), type: term(item.type) }));
        if (query.includes('SELECT ?work ?contribution')) return works.filter(item => query.includes(`<${item.id}>`) && item.state !== 'empty')
          .map(item => ({ work: term(item.id), contribution: term(`${item.id}/text`), language: term('en'), draft: term(`${item.id}/draft`),
            ...(item.state === 'published' ? { publication: term(`${item.id}/publication`) } : {}) }));
        return [];
      },
    } as unknown as WorkReadSession;
  }
  return { agent, works, position, session, graphQueries, graphCalls,
    deny: () => { denied = true; }, moveAuthority: () => { stamp = 'controller-2'; },
    failCounts: () => { failCounts = true; } };
}

describe('Studio inventory contract', () => {
  test('NFKC title matching uses Unicode scalar length and locale-independent lowercase', () => {
    expect(studioSearchQuery('  ＳＴＵＤＩＯ ＮＥＥＤＬＥ  ')).toBe('studio needle');
    expect(studioSearchQuery('  \uFB03 再会 İ  ')).toBe('ffi 再会 i\u0307');
    expect(studioSearchQuery('😀'.repeat(200))).toBe('😀'.repeat(200));
    expect(() => studioSearchQuery('😀'.repeat(201))).toThrow(WorkReadInvalid);
    expect(() => studioSearchQuery('\uD800')).toThrow(WorkReadInvalid);
  });

  test('normalized title search and every order cover the full authorized cut before pagination', async () => {
    const items = Array.from({ length: 227 }, (_, n) => work(n, n < 204 ? `Other ${n}`
      : `ＳＴＵＤＩＯ ＮＥＥＤＬＥ ${Math.floor((226 - n) / 2)} 再会`));
    // Three distinct orders, tied creation/update times, and astral title keys.
    for (const item of items.slice(204)) item.created = item.updated = '2026-09-01T12:00:00.000000Z';
    items[204]!.updated = '2026-09-03T12:00:00.000000Z';
    items[226]!.title = 'Studio needle 😀';
    items[225]!.title = 'Studio needle \uE000';
    const f = inventoryFixture(items);
    for (const sort of ['recent', 'created', 'title'] as const) {
      const found: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await readStudioWorks(f.session(cursor), f.agent, { q: '  studio NEEDLE  ', sort });
        expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
        found.push(...page.items.map(item => item.id));
        cursor = page.nextCursor ?? undefined;
        expect(found.length).toBeLessThanOrEqual(23);
      } while (cursor);
      const expected = items.slice(204).sort((a, b) => (sort === 'title'
        ? scalarCompare(studioTitleKey(a.title), studioTitleKey(b.title))
        : scalarCompare(sort === 'recent' ? b.updated : b.created, sort === 'recent' ? a.updated : a.created))
        || scalarCompare(a.id, b.id));
      expect(found).toEqual(expected.map(item => item.id));
      expect(new Set(found).size).toBe(23);
    }
    expect((await readStudioWorks(f.session(), f.agent, { q: 'no matching title' })).nextCursor).toBeNull();
    expect((await readStudioWorks(f.session(), f.agent, { q: '再会' })).items).toHaveLength(5);
    expect(f.graphQueries.every(query => !query.includes('LCASE'))).toBe(true);
  });

  test('binds normalized query, defaulted sort, filters, limit, Agent, source and live authority', async () => {
    const f = inventoryFixture(Array.from({ length: 23 }, (_, n) => work(n)));
    const first = await readStudioWorks(f.session(), f.agent, { q: 'ＳＴＵＤＩＯ' });
    expect(first.nextCursor).toBeString();
    const cursor = first.nextCursor!;
    const same = await readStudioWorks(f.session(cursor), f.agent, { q: ' studio ', sort: 'recent' });
    expect(same.items.map(item => item.id)).not.toEqual(first.items.map(item => item.id));
    for (const filters of [{ q: 'changed' }, { sort: 'title' }, { state: 'draft' }, { type: documentType }, { view: 'curated' }]) {
      await expect(readStudioWorks(f.session(cursor), f.agent, { q: 'studio', ...filters } as StudioWorkFilters))
        .rejects.toBeInstanceOf(WorkReadInvalid);
    }
    await expect(readStudioWorks(f.session(cursor, 6), f.agent, { q: 'studio' })).rejects.toBeInstanceOf(WorkReadInvalid);
    f.position.sequence = '2';
    await expect(readStudioWorks(f.session(cursor), f.agent, { q: 'studio' })).rejects.toBeInstanceOf(WorkReadMoved);
    f.position.sequence = '1';
    f.moveAuthority();
    await expect(readStudioWorks(f.session(cursor), f.agent, { q: 'studio' })).rejects.toBeInstanceOf(WorkReadMoved);
    f.deny();
    const before = f.graphQueries.length;
    await expect(readStudioWorks(f.session('invalid'), f.agent, { q: 'x'.repeat(201) })).rejects.toBeInstanceOf(ControlDenied);
    expect(f.graphQueries).toHaveLength(before);
  });

  test('type and state filters precede page selection, and over-budget inventory cannot look exhausted', async () => {
    const items = Array.from({ length: 42 }, (_, n) => ({ ...work(n), type: n < 21 ? documentType : bookType,
      state: n < 30 ? 'draft' as const : 'empty' as const }));
    const f = inventoryFixture(items);
    const page = await readStudioWorks(f.session(undefined, 20), f.agent, { type: bookType, state: 'empty' });
    expect(page.items).toHaveLength(12);
    expect(page.items.every(item => item.types.includes(bookType) && item.state === 'empty')).toBe(true);
    expect(page.nextCursor).toBeNull();
    const curatedItems = Array.from({ length: 205 }, (_, n) => ({ ...work(n),
      relationship: n < 204 ? 'curated' as const : 'authored' as const }));
    const views = inventoryFixture(curatedItems);
    expect((await readStudioWorks(views.session(), views.agent, { view: 'authored' })).items.map(item => item.id))
      .toEqual([curatedItems[204]!.id]);
    expect((await readStudioWorks(views.session(), views.agent, { view: 'curated' })).items).toHaveLength(5);
    const large = inventoryFixture(Array.from({ length: STUDIO_WORK_COST.inventoryBatches * STUDIO_WORK_COST.candidateAdmissions + 1 }, (_, n) => work(n)));
    await expect(readStudioWorks(large.session(), large.agent, {})).rejects.toBeInstanceOf(WorkReadLimit);
  });

  test('list and exact reads require Book count completeness and non-Book null, without chapter body access', async () => {
    const f = inventoryFixture([work(1), { ...work(2), type: documentType }]);
    const page = await readStudioWorks(f.session(), f.agent, {});
    expect(page.items.find(item => item.types.includes(bookType))!.chapterCount).toEqual({ value: 0, complete: true });
    expect(page.items.find(item => item.types.includes(documentType))!.chapterCount).toBeNull();
    expect((await readStudioWork(f.session(), f.agent, f.works[0]!.id)).item.chapterCount).toEqual({ value: 0, complete: true });
    expect((await readStudioWork(f.session(), f.agent, f.works[1]!.id)).item.chapterCount).toBeNull();
    f.failCounts();
    expect((await readStudioWorks(f.session(), f.agent, {})).items.find(item => item.types.includes(bookType))!.chapterCount)
      .toEqual({ value: 0, complete: false });
    expect((await readStudioWork(f.session(), f.agent, f.works[0]!.id)).item.chapterCount).toEqual({ value: 0, complete: false });
    expect(f.graphCalls.every(query => query.includes('SELECT ?structure'))).toBe(true);
  });
});

const chapter = (n: number, role = 'chapter') => ({ occurrence: id(n), state: 'active', role });
const countPage = (occurrences: ReturnType<typeof chapter>[], next: string | null = null) =>
  ({ revision: id(90), occurrences, next });

test('nested volume/part/extras and paginated chapter occurrences retain honest lower bounds', async () => {
  const pages = new Map([
    [':', countPage([chapter(10, 'group'), chapter(11, 'group')], 'root-next')],
    [':root-next', countPage([chapter(20)])],
    [`${id(10)}:`, countPage([chapter(12, 'group'), chapter(21)], 'volume-next')],
    [`${id(10)}:volume-next`, countPage([chapter(22)])],
    [`${id(11)}:`, countPage([chapter(23)])],
    [`${id(12)}:`, countPage([chapter(24)])],
  ]);
  expect(await countStudioChapterOccurrences(async (parent, after) => pages.get(`${parent ?? ''}:${after ?? ''}`)!))
    .toEqual({ value: 5, complete: true });
  expect(await countStudioChapterOccurrences(async () => countPage([]))).toEqual({ value: 0, complete: true });
  expect(await countStudioChapterOccurrences(async parent => {
    if (parent) throw new WorkReadUnavailable('child unavailable');
    return countPage([chapter(10, 'group')]);
  })).toEqual({ value: 0, complete: false });
  expect(await countStudioChapterOccurrences(async () => countPage([chapter(20)], 'next'), { remaining: 1 }))
    .toEqual({ value: 1, complete: false });
  expect(await countStudioChapterOccurrences(async (_parent, after) => after
    ? { ...countPage([chapter(21)]), revision: id(91) } : countPage([chapter(20)], 'next')))
    .toEqual({ value: 1, complete: false });
  expect(await countStudioChapterOccurrences(async () => countPage([chapter(20)], 'next')))
    .toEqual({ value: 1, complete: false });
  // More than the old 100-row contents window, without losing any placement.
  expect(await countStudioChapterOccurrences(async (_parent, after) => {
    const start = Number(after ?? 0), end = Math.min(start + 20, 125);
    return countPage(Array.from({ length: end - start }, (_, n) => chapter(start + n)), end < 125 ? String(end) : null);
  })).toEqual({ value: 125, complete: true });
  expect(await countStudioChapterOccurrences(async (_parent, after) => {
    const start = Number(after ?? 0);
    return countPage([chapter(start)], String(start + 1));
  })).toEqual({ value: 20, complete: false });
  await expect(countStudioChapterOccurrences(async () => { throw new WorkReadMoved('Count basis changed'); }))
    .rejects.toBeInstanceOf(WorkReadMoved);
});

test('owning API count traverses real immutable pages, counts repeated targets and excludes removed occurrences', async () => {
  const book = id(5), main = id(2), structure = id(1), revision = id(4), generation = id(3);
  const values = new Map<string, Uint8Array>();
  let fail = false;
  const objects: ImmutableObjects = {
    async put(bytes) { const digest = createHash('sha256').update(bytes).digest('hex'); values.set(digest, bytes); return digest; },
    async get(digest) { if (fail) throw new ObjectNotFound('missing immutable page'); return values.get(digest)!; },
  };
  const record = (n: number, parent: string, role = 'chapter'): OccurrenceRecord => ({ ...chapter(n, role),
    state: 'active', role: role as 'chapter' | 'group', parent, segmentKey: 'a', orderKey: String(n).padStart(8, '0'),
    labels: [{ value: `Chapter ${n}`, language: 'en' }], introducedBy: revision,
    ...(role === 'group' ? { qualifier: { type: 'book-group' as const, division: 'volume' as const } }
      : { target: id(999), selection: { mode: 'follow-context' as const } }) });
  const records = [record(10, structure, 'group'), record(11, id(10), 'group'), record(12, structure, 'group'),
    ...Array.from({ length: 21 }, (_, n) => record(100 + n, structure)), record(121, id(11)), record(122, id(12))];
  const removed = { ...record(999, structure), state: 'removed' as const };
  const cost = newCost();
  const recordRoot = await recordTree(objects).apply(await recordTree(objects).empty(cost),
    new Map([...records, removed].map(item => [item.occurrence, item])), cost);
  const entries = records.map(item => ({ occurrence: item.occurrence, parent: item.parent,
    segmentKey: item.segmentKey!, orderKey: item.orderKey! }));
  const order = await orderTree(objects).apply(await orderTree(objects).empty(cost),
    new Map(entries.map(item => [orderTreeKey(item), item])), cost);
  const topGroups = await orderTree(objects).apply(await orderTree(objects).empty(cost),
    new Map(entries.filter(item => [id(10), id(12)].includes(item.occurrence)).map(item => [orderTreeKey(item), item])), cost);
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: main,
    profile: 'book-composition', generation, pageFormat: STRUCTURE_PAGE_FORMAT, records: recordRoot,
    order, topGroups, placementCount: records.length, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
  const environment = { structureObjects: objects, fuseki: { async query(query: string) {
    if (query.includes('SELECT ?structure')) return result([{ structure: term(structure) }]);
    if (query.includes('SELECT ?component')) return result([{ component: term(main), profile: term('https://rezics.com/vocab/BookComposition'),
      head: term(revision), generation: term(generation), count: term(String(records.length)), manifest: term(`urn:rezics:sha256:${digest}`) }]);
    if (query.includes('SELECT ?owner')) return result([{ owner: term(book) }]);
    if (query.includes('SELECT ?manifest')) return result([{ manifest: term(`urn:rezics:sha256:${digest}`),
      count: term(String(records.length)), epoch: term('fixture'), sequence: term('1') }]);
    throw new Error(`Unexpected count graph query: ${query}`);
  } } };
  const session = new WorkReadSession({ environment } as unknown as WorkReadSession['deps'],
    new Request('http://main.invalid'), {}, { dataEpoch: 'fixture', sequence: '1' });
  expect(await readStudioChapterCount(session, book, main)).toEqual({ value: 23, complete: true });
  const api = inventoryFixture([{ ...work(0), id: book, main }]);
  const apiSession = () => Object.assign(api.session(), { deps: { ...api.session().deps, environment } });
  expect((await readStudioWorks(apiSession(), api.agent, {})).items[0]!.chapterCount).toEqual({ value: 23, complete: true });
  expect((await readStudioWork(apiSession(), api.agent, book)).item.chapterCount).toEqual({ value: 23, complete: true });
  expect(await readStudioChapterCount(session, book, main, { remaining: 1 })).toMatchObject({ complete: false });
  fail = true;
  expect(await readStudioChapterCount(session, book, main)).toEqual({ value: 0, complete: false });
});
