import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { readingPositionsRoutes } from '../src/routes/reading-positions.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { type ReadingOccurrence, READING_POSITION_COST } from '../src/modules/reading-position/boundary.ts';
import { normalizePositionQuery, pageReadingPositions } from '../src/modules/reading-position/store.ts';
import { WorkReadInvalid } from '../src/modules/work/read-session.ts';
import { RV } from '../src/modules/work/activate.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const work = id(), structure = id(), revision = id(), reader = id();
const chapters: ReadingOccurrence[] = Array.from({ length: 1000 }, (_, index) => ({ occurrence: id(),
  work, structure, revision, parent: structure, segmentKey: 'a', orderKey: (index + 1).toString(36).padStart(4, '0'),
  role: 'chapter', target: 'https://schema.org/DigitalDocument', ordinal: index + 1,
  labels: [{ value: `Chapter ${index + 1}`, language: 'en' },
    { value: `第${index + 1}章${index === 999 ? '重逢' : '旅程'}`, language: 'zh-Hans' }] }));

test('G954: 1000 chapters remain searchable across all labels, CJK, numbers and width variants before paging', () => {
  for (const q of ['1000', '１０００', '重逢', ' CHAPTER 1000 ']) {
    const page = pageReadingPositions(chapters, { q, limit: 1 });
    expect(page.items.map(item => item.occurrence)).toEqual([chapters[999]!.occurrence]);
    expect(page.next).toBeNull(); expect(page.complete).toBe(true);
  }
  const untitled = chapters.map(({ labels: _labels, ...item }) => item);
  expect(pageReadingPositions(untitled, { q: '999', limit: 1 }).items[0]!.occurrence).toBe(chapters[998]!.occurrence);
  expect(pageReadingPositions(chapters, { q: 'missing', limit: 100 })).toEqual({ items: [], next: null, complete: true });
});

test('G954: filtered pages retain reading order and traverse exactly once without turning page size into a product limit', () => {
  for (const q of [undefined, '旅程', 'chapter 9']) {
    const found: string[] = [];
    let after: string | undefined;
    do {
      const page = pageReadingPositions(chapters, { q, limit: 13, after });
      expect(page.complete).toBe(page.next === null);
      found.push(...page.items.map(item => item.occurrence));
      after = page.next ?? undefined;
    } while (after);
    const expected = q === undefined ? chapters : chapters.filter(item => item.labels!.some(label => label.value.toLowerCase().includes(q)));
    expect(found).toEqual(expected.map(item => item.occurrence));
    expect(new Set(found).size).toBe(found.length);
  }
});

test('G954: invalid page sizes, foreign or nonmatching continuations and oversized queries fail explicitly', () => {
  for (const limit of [0, -1, 1.5, 101, NaN]) expect(() => pageReadingPositions(chapters, { limit })).toThrow(WorkReadInvalid);
  for (const after of [id(), chapters[0]!.occurrence]) {
    expect(() => pageReadingPositions(chapters, { q: '重逢', limit: 20, after })).toThrow(WorkReadInvalid);
  }
  expect(() => normalizePositionQuery('x'.repeat(READING_POSITION_COST.chooserQueryChars + 1))).toThrow(WorkReadInvalid);
  expect(pageReadingPositions([], { limit: 20, q: '' })).toEqual({ items: [], next: null, complete: true });
});

function fixture(inventory = chapters) {
  let sequence = '1', generation = '1', available = true, active = true, historyReads = 0, queryCalls = 0;
  const rows = inventory.flatMap(item => item.labels!.map(label => ({
    work: { type: 'uri', value: item.work }, structure: { type: 'uri', value: item.structure },
    revision: { type: 'uri', value: item.revision }, placement: { type: 'uri', value: item.occurrence },
    occurrence: { type: 'uri', value: item.occurrence }, parent: { type: 'uri', value: item.parent },
    segmentKey: { type: 'literal', value: item.segmentKey }, orderKey: { type: 'literal', value: item.orderKey },
    role: { type: 'uri', value: `${RV}ChapterRole` }, target: { type: 'uri', value: item.target },
    label: { type: 'literal', value: label.value, 'xml:lang': label.language },
  })));
  const deps = { environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: { query: async (sparql: string) => {
      queryCalls++;
      if (sparql.includes('SELECT ?work ?structure')) return { results: { bindings: rows } };
      const control = { epoch: { type: 'literal', value: 'epoch' }, sequence: { type: 'literal', value: sequence } };
      if (sparql.includes('SELECT ?epoch ?sequence ?hold ?r')) return { results: { bindings: [control,
        ...(available ? [{ ...control, r: { type: 'uri', value: work }, work: { type: 'uri', value: work },
          type: { type: 'literal', value: 'work' }, public: { type: 'literal', value: 'true' },
          label: { type: 'literal', value: 'Story', 'xml:lang': 'en' } }] : [])] } };
      return { results: { bindings: [control] } };
    } } },
    access: { activePrincipalId: async () => active ? 'reader' : null, canReadAsBaselineMember: async () => false },
    account: { verify: async (request: Request) => {
      if (request.headers.get('authorization') !== 'Bearer reader') throw new AccountAssertionDenied('Unknown bearer');
      return { issuer: 'https://qa.test', subject: 'reader', emailVerified: true };
    } },
    readingPositions: { generation: async () => generation, privateSnapshot: async () => { historyReads++; return '1'; },
      completed: async () => { historyReads++; return new Set(); } },
  } as unknown as MainWorkDependencies;
  const app = new Elysia().use(readingPositionsRoutes(deps));
  const call = (query: Record<string, string> = {}, token?: string) => app.handle(new Request(
    `http://main.local/v1/reading-positions/${work.slice(-36)}?${new URLSearchParams(query)}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  return { call, rows, historyReads: () => historyReads, queryCalls: () => queryCalls,
    reveal: () => { generation = '2'; },
    hide: () => { available = false; }, revoke: () => { active = false; }, move: () => { sequence = '2'; } };
}

test('G954: real chooser route searches all carried languages at fixed graph cost, and anonymous mine resolves to start', async () => {
  const f = fixture();
  let cost = 0;
  for (const q of ['重逢', '１０００', 'chapter 1000']) {
    const before = f.queryCalls();
    const response = await f.call({ q, limit: '1' }); expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.items.map((item: ReadingOccurrence) => item.occurrence)).toEqual([chapters[999]!.occurrence]);
    expect(page.items[0].labels).toEqual(chapters[999]!.labels);
    expect(page.resolved).toBe('start'); expect(page.nextCursor).toBeNull(); expect(page.complete).toBe(true);
    const calls = f.queryCalls() - before;
    if (cost) expect(calls).toBe(cost); else cost = calls;
  }
  expect(cost).toBeLessThan(10); expect(f.historyReads()).toBe(0);
});

test('G954: route binds continuations to search, position, identity and graph; filtering does not change resolved position', async () => {
  const f = fixture();
  const response = await f.call({ q: '旅程', limit: '2', position: chapters[999]!.occurrence });
  expect(response.status).toBe(200);
  const page = await response.json(); expect(page.resolved).toBe(chapters[999]!.occurrence);
  expect(page.complete).toBe(false); expect(page.nextCursor).toBeString(); expect(page.next).toBe(page.nextCursor);
  const continuation = { q: '旅程', limit: '2', position: chapters[999]!.occurrence, cursor: page.nextCursor };
  const tail = await f.call(continuation); expect(tail.status).toBe(200);
  expect((await tail.json()).items.map((item: ReadingOccurrence) => item.occurrence)).toEqual(chapters.slice(2, 4).map(item => item.occurrence));
  expect((await f.call({ ...continuation, q: ' 旅程 ', limit: '3', language: 'ja' })).status).toBe(200);
  for (const query of [{ ...continuation, q: 'chapter' }, { ...continuation, position: 'all' },
    { ...continuation, actingSubject: reader }]) {
    expect((await f.call(query, 'actingSubject' in query ? 'reader' : undefined)).status).toBe(400);
  }
  const g = fixture();
  const retained = await (await g.call({ q: 'chapter', limit: '1' })).json();
  g.reveal(); expect((await g.call({ q: 'chapter', cursor: retained.nextCursor })).status).toBe(400);
  f.move(); expect((await f.call(continuation)).status).toBe(409);
});

test('G954: store reading order is independent of graph row order, and duplicate placements fail closed', async () => {
  const f = fixture([...chapters].reverse());
  const response = await f.call({ q: 'chapter 9', limit: '2' }); expect(response.status).toBe(200);
  expect((await response.json()).items.map((item: ReadingOccurrence) => item.ordinal)).toEqual([9, 90]);
  const corrupt = fixture(chapters.slice(0, 1));
  corrupt.rows[1]!.placement.value = id();
  expect((await corrupt.call({ q: 'Chapter' })).status).toBe(503);
});

test('G954: hidden Works, inactive and anonymous acting identities, invalid queries and fractions never return chooser data', async () => {
  const f = fixture(); f.hide(); expect((await f.call({ q: '重逢' })).status).toBe(404);
  expect((await f.call({ actingSubject: reader })).status).toBe(401);
  f.revoke(); expect((await f.call({ actingSubject: reader }, 'reader')).status).toBe(401);
  expect((await f.call({ q: 'x'.repeat(201) })).status).toBe(422);
  expect((await f.call({ limit: '1.5' })).status).toBe(422);
  expect(f.historyReads()).toBe(0);
});

test('G954: unreadable native chapter targets withhold labels before search without changing anonymous position semantics', async () => {
  const f = fixture([{ ...chapters[0]!, target: id(), labels: [{ value: 'Secret chapter title', language: 'en' }] }]);
  const search = await f.call({ q: 'Secret' }); expect(search.status).toBe(200);
  expect(await search.json()).toMatchObject({ items: [], complete: true, nextCursor: null, resolved: 'start' });
  const numeric = await f.call({ q: '1' }); expect(numeric.status).toBe(200);
  const page = await numeric.json();
  expect(page.items[0]).toMatchObject({ target: null, labels: [], ordinal: 1 });
  expect(JSON.stringify(page)).not.toContain('Secret');
});
