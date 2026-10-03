import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { readingPositionsRoutes } from '../src/routes/reading-positions.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { type ReadingOccurrence, READING_POSITION_COST } from '../src/modules/reading-position/boundary.ts';
import { normalizePositionQuery } from '../src/modules/reading-position/store.ts';
import { WorkReadInvalid } from '../src/modules/work/read-session.ts';
import { RV } from '../src/modules/work/activate.ts';
import { READING_CHOOSER_COST } from '../src/modules/reading-position/traversal.ts';
import type { ReadRow } from '../src/modules/work/read-session.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const work = id(), structure = id(), revision = id(), reader = id();
const chapters: ReadingOccurrence[] = Array.from({ length: 1000 }, (_, index) => ({ occurrence: id(),
  work, structure, revision, parent: structure, segmentKey: 'a', orderKey: (index + 1).toString(36).padStart(4, '0'),
  role: 'chapter', target: 'https://schema.org/DigitalDocument', ordinal: index + 1,
  labels: [{ value: `Chapter ${index + 1}`, language: 'en' },
    { value: `第${index + 1}章${index === 999 ? '重逢' : '旅程'}`, language: 'zh-Hans' }] }));

test('G954: 1000 chapters remain searchable across all labels, CJK, numbers and width variants before paging', async () => {
  const f = fixture();
  for (const q of ['1000', '１０００', '重逢', ' CHAPTER 1000 ']) {
    const response = await f.call({ q, limit: '1' }); expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.items.map((item: ReadingOccurrence) => item.occurrence)).toEqual([chapters[999]!.occurrence]);
    expect(page.nextCursor).toBeNull(); expect(page.complete).toBe(true);
  }
  const untitled = chapters.map(({ labels: _labels, ...item }) => item);
  const unnamed = await fixture(untitled).call({ q: '999', limit: '1' }); expect(unnamed.status).toBe(200);
  expect((await unnamed.json()).items[0]!.occurrence).toBe(chapters[998]!.occurrence);
  expect(await (await f.call({ q: 'missing', limit: '100' })).json()).toMatchObject({ items: [], nextCursor: null, complete: true });
});

test('G954: filtered pages retain reading order and traverse exactly once without turning page size into a product limit', async () => {
  const f = fixture();
  for (const q of [undefined, '旅程', 'chapter 9']) {
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await f.call({ limit: '13', ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) });
      expect(response.status).toBe(200);
      const page = await response.json(); expect(page.complete).toBe(page.nextCursor === null);
      found.push(...page.items.map((item: ReadingOccurrence) => item.occurrence));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const expected = q === undefined ? chapters : chapters.filter(item => item.labels!.some(label => label.value.toLowerCase().includes(q)));
    expect(found).toEqual(expected.map(item => item.occurrence));
    expect(new Set(found).size).toBe(found.length);
  }
});

test('G954: invalid page sizes, foreign continuations and oversized queries fail explicitly', async () => {
  const f = fixture();
  for (const limit of [0, -1, 1.5, 101, NaN]) expect((await f.call({ limit: String(limit) })).status).toBe(422);
  for (const cursor of [id(), chapters[0]!.occurrence]) {
    expect((await f.call({ q: '重逢', limit: '20', cursor })).status).toBe(400);
  }
  expect(() => normalizePositionQuery('x'.repeat(READING_POSITION_COST.chooserQueryChars + 1))).toThrow(WorkReadInvalid);
  expect(await (await fixture([]).call({ limit: '20', q: '' })).json()).toMatchObject({ items: [], nextCursor: null, complete: true });
});

function fixture(inventory = chapters, leaves: string[] = []) {
  let sequence = '1', generation = '1', available = true, active = true, historyReads = 0, queryCalls = 0, maxRows = 0;
  let own = false;
  const hidden = new Set<string>(), completed = new Set<string>(), finished = new Set<string>();
  const attempts: Array<{ state: 'finished'; selections: Array<{ target: {
    base: 'occurrence' | 'work' | 'realization'; resource: string; revision?: string; work?: string } }> }> = [];
  const queries: string[] = [];
  const binding = (value: string) => ({ type: 'literal' as const, value });
  const metas = new Map<string, ReadRow>([[work, { work: binding(work), structure: binding(structure),
    revision: binding(revision), generation: binding(structure) }]]);
  for (const item of inventory) metas.set(item.work, { work: binding(item.work), structure: binding(item.structure),
    revision: binding(item.revision), generation: binding(item.structure) });
  for (const leaf of leaves) metas.set(leaf, { work: binding(leaf) });
  const baseRow = (item: ReadingOccurrence): ReadRow => ({
    work: binding(item.work), structure: binding(item.structure), revision: binding(item.revision),
    placement: binding(item.occurrence), occurrence: binding(item.occurrence), parent: binding(item.parent),
    segmentKey: binding(item.segmentKey), orderKey: binding(item.orderKey),
    role: binding(`${RV}${item.role === 'chapter' ? 'ChapterRole' : item.role === 'part' ? 'PartRole' : 'GroupRole'}`),
    ...(item.target ? { target: binding(item.target) } : {}),
    ...(item.displayLabel ? { displayLabel: binding(item.displayLabel) } : {}),
  });
  const rows: ReadRow[] = inventory.flatMap(item => (item.labels?.length ? item.labels : [undefined]).map(label => ({
    ...baseRow(item), ...(label ? { label: { ...binding(label.value), 'xml:lang': label.language } } : {}),
  })));
  const rowsByOccurrence = new Map<string, ReadRow[]>();
  for (const row of rows) rowsByOccurrence.set(row.occurrence!.value, [...rowsByOccurrence.get(row.occurrence!.value) ?? [], row]);
  const order = new Map<string, ReadingOccurrence[]>(), ordinals = new Map<string, number>();
  for (const item of inventory) {
    const bucket = order.get(item.parent) ?? []; bucket.push(item); order.set(item.parent, bucket);
  }
  for (const bucket of order.values()) {
    bucket.sort((a, b) => a.segmentKey.localeCompare(b.segmentKey) || a.orderKey.localeCompare(b.orderKey));
    bucket.forEach((item, index) => ordinals.set(item.occurrence, index + 1));
  }
  const siblings = (sparql: string) => {
    const owner = sparql.match(/rv:generation <([^>]+)>/)?.[1];
    const parent = sparql.match(/\?segment rv:parent <([^>]+)>/)?.[1];
    return (order.get(parent!) ?? []).filter(item => item.structure === owner);
  };
  const execute = (sparql: string): ReadRow[] => {
    if (sparql.includes('# reading-position:work\n')) {
      const resource = sparql.match(/BIND\(<([^>]+)> AS \?work\)/)![1]!;
      return metas.has(resource) ? [metas.get(resource)!] : [];
    }
    if (sparql.includes('# reading-position:works')) {
      const after = sparql.match(/STR\(\?work\) > ("[^"]*")/)?.[1];
      const reachable = new Set([work]);
      for (let pass = 0; pass < 16; pass++) for (const item of inventory) {
        if (item.role === 'part' && item.target && reachable.has(item.work)) reachable.add(item.target);
      }
      return [...metas.values()].filter(meta => reachable.has(meta.work!.value)
        && (!after || meta.work!.value > JSON.parse(after))).sort((a, b) => a.work!.value.localeCompare(b.work!.value)).slice(0, 50);
    }
    if (sparql.includes('# reading-position:number')) {
      const item = siblings(sparql)[Number(sparql.match(/OFFSET (\d+)/)![1])];
      return item ? [{ occurrence: binding(item.occurrence) }] : [];
    }
    if (sparql.includes('# reading-position:range')) {
      expect(sparql).toContain('ORDER BY'); expect(sparql).toMatch(/LIMIT (?:101|1) /);
      const q = JSON.parse(sparql.match(/"NFKC"\)\), ("(?:\\.|[^"\\])*")/)?.[1] ?? '""') as string;
      const all = siblings(sparql);
      const numbered = sparql.match(/\?occurrence = <([^>]+)>/)?.[1];
      const segment = sparql.match(/FILTER\(\?segmentKey [<>] ("[^"]*")/)?.[1];
      const order = sparql.match(/\?orderKey [<>] ("[^"]*")/)?.[1];
      const reverse = sparql.includes('DESC(?segmentKey)');
      const matched = all.filter(item => (!segment || (reverse
        ? item.segmentKey < JSON.parse(segment) || item.segmentKey === JSON.parse(segment) && item.orderKey < JSON.parse(order!)
        : item.segmentKey > JSON.parse(segment) || item.segmentKey === JSON.parse(segment) && item.orderKey > JSON.parse(order!)))
        && (!q || item.role === 'group' || item.role === 'part' || item.occurrence === numbered
          || item.labels?.some(label => label.value.normalize('NFKC').toLowerCase().includes(q))));
      const candidate = (reverse ? matched.reverse() : matched).slice(0, reverse ? 1 : 101);
      return candidate.flatMap(item => rowsByOccurrence.get(item.occurrence)!.map(row => ({ ...row,
        matches: binding(String(!q || item.occurrence === numbered
          || (item.displayLabel ?? '').normalize('NFKC').toLowerCase().includes(q)
          || !!item.labels?.some(label => label.value.normalize('NFKC').toLowerCase().includes(q)))) })));
    }
    if (sparql.includes('# reading-position:ordinals')) {
      const wanted = new Set([...sparql.matchAll(/\(<([^>]+)> <[^>]+> "/g)].map(match => match[1]));
      return inventory.filter(item => wanted.has(item.occurrence)).map(item => ({ occurrence: binding(item.occurrence),
        ordinal: binding(String(ordinals.get(item.occurrence))) }));
    }
    if (sparql.includes('# reading-position:records')) {
      const values = sparql.match(/VALUES \?occurrence \{([^}]+)}/)![1]!;
      return inventory.filter(item => values.includes(item.occurrence)).map(baseRow);
    }
    if (sparql.includes('# reading-position:parent-work')) {
      const target = sparql.match(/schema:item <([^>]+)>/)![1]!;
      return inventory.filter(item => item.role === 'part' && item.target === target).map(item => ({ occurrence: binding(item.occurrence) }));
    }
    if (sparql.includes('SELECT ?work ?structure')) throw new Error('Full composition materialization is forbidden in the chooser');
    const control = { epoch: binding('epoch'), sequence: binding(sequence) };
    if (sparql.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const resources = sparql.match(/VALUES \?r \{([^}]+)}/)![1]!;
      return [control, ...[...metas.keys()].filter(resource => available && !hidden.has(resource) && resources.includes(resource))
        .map(resource => ({ ...control, r: binding(resource), work: binding(resource), type: binding('work'),
          public: binding('true'), label: { ...binding('Story'), 'xml:lang': 'en' } }))];
    }
    return [control];
  };
  const deps = { environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: { query: async (sparql: string) => {
      queryCalls++; queries.push(sparql);
      const bindings = execute(sparql); maxRows = Math.max(maxRows, bindings.length);
      return { results: { bindings } };
    } } },
    access: { activePrincipalId: async () => active ? 'reader' : null, canReadAsBaselineMember: async () => own },
    account: { verify: async (request: Request) => {
      if (request.headers.get('authorization') !== 'Bearer reader') throw new AccountAssertionDenied('Unknown bearer');
      return { issuer: 'https://qa.test', subject: 'reader', emailVerified: true };
    } },
    readingPositions: { generation: async () => generation, privateSnapshot: async () => {
      historyReads++; return JSON.stringify([[...completed].sort(), [...finished].sort(), attempts]);
    },
      completedPage: async (_principal: unknown, structures: string[], after?: string) => {
        historyReads++;
        const matches = inventory.filter(item => structures.includes(item.structure) && completed.has(item.occurrence)
          && (!after || item.occurrence > after)).map(item => item.occurrence).sort();
        return { items: matches.slice(0, 50), next: matches.length > 50 ? matches[49]! : null };
      }, finishedWorks: async (_agent: string, works: string[]) => new Set(works.filter(resource => finished.has(resource))) },
    seriesSessions: { batch: async () => { historyReads++; return { items: attempts, next: null }; } },
  } as unknown as MainWorkDependencies;
  const app = new Elysia().use(readingPositionsRoutes(deps));
  const call = (query: Record<string, string> = {}, token?: string) => app.handle(new Request(
    `http://main.local/v1/reading-positions/${work.slice(-36)}?${new URLSearchParams(query)}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  return { call, rows, queries, completed, finished, attempts, historyReads: () => historyReads, queryCalls: () => queryCalls,
    maxRows: () => maxRows, own: () => { own = true; }, hideResource: (resource: string) => hidden.add(resource),
    denyReader: () => { own = false; },
    reveal: () => { generation = '2'; },
    hide: () => { available = false; }, revoke: () => { active = false; }, move: () => { sequence = '2'; } };
}

test('G954: real chooser route searches all carried languages at bounded graph cost, and anonymous mine resolves to start', async () => {
  const f = fixture();
  for (const q of ['重逢', '１０００', 'chapter 1000']) {
    const before = f.queryCalls();
    const response = await f.call({ q, limit: '1' }); expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.items.map((item: ReadingOccurrence) => item.occurrence)).toEqual([chapters[999]!.occurrence]);
    expect(page.items[0].labels).toEqual(chapters[999]!.labels);
    expect(page.resolved).toBe('start'); expect(page.nextCursor).toBeNull(); expect(page.complete).toBe(true);
    const calls = f.queryCalls() - before;
    expect(calls).toBeLessThan(10);
  }
  expect(f.historyReads()).toBe(0);
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
  corrupt.rows[1]!.placement!.value = id();
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

test('G954: 20005 chapters list, search and resolve positions beyond the old ceiling with bounded store responses', async () => {
  const inventory: ReadingOccurrence[] = Array.from({ length: 20_005 }, (_, index) => ({ ...chapters[0]!,
    occurrence: id(), orderKey: (index + 1).toString(36).padStart(5, '0'), ordinal: index + 1,
    labels: [{ value: index === 20_004 ? '重逢' : `Chapter ${index + 1}`, language: index === 20_004 ? 'yue' : 'en' }] }));
  const f = fixture(inventory);
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const response = await f.call({ limit: '100', ...(cursor ? { cursor } : {}) }); expect(response.status).toBe(200);
    const page = await response.json();
    found.push(...page.items.map((item: ReadingOccurrence) => item.occurrence));
    expect(page.complete).toBe(page.nextCursor === null); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(found).toEqual(inventory.map(item => item.occurrence));
  expect(new Set(found).size).toBe(inventory.length);
  for (const q of ['重逢', '２０００５', '20005']) {
    const before = f.queryCalls();
    const response = await f.call({ q, limit: '1', language: 'en', position: inventory.at(-1)!.occurrence });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ occurrence: inventory.at(-1)!.occurrence, ordinal: 20_005 }],
      resolved: inventory.at(-1)!.occurrence, complete: true, nextCursor: null });
    expect(f.queryCalls() - before).toBeLessThan(12);
  }
  f.own(); f.completed.add(inventory[10_000]!.occurrence);
  const progress = await f.call({ q: '重逢' }, 'reader');
  // Authenticated reads still require an explicit acting subject.
  expect(progress.status).toBe(400);
  const signed = await f.call({ q: '重逢', actingSubject: reader }, 'reader'); expect(signed.status).toBe(200);
  expect((await signed.json()).resolved).toBe(inventory[10_000]!.occurrence);
  f.finished.add(work);
  const finished = await f.call({ q: '重逢', actingSubject: reader }, 'reader'); expect(finished.status).toBe(200);
  expect((await finished.json()).resolved).toBe(inventory.at(-1)!.occurrence);
  expect(f.maxRows()).toBeLessThanOrEqual(READING_CHOOSER_COST.probe * READING_POSITION_COST.labels);
  expect(f.queries.some(query => query.includes('Read composition exceeds') || query.includes('LIMIT 160001'))).toBe(false);
}, 30_000);

test('G954: keyset continuation crosses groups, empty Works and volume boundaries in composed reading order', async () => {
  const volume = id(), volumeStructure = id(), group = id(), empty = id();
  const part: ReadingOccurrence = { ...chapters[0]!, occurrence: id(), orderKey: 'a', role: 'part', target: volume,
    labels: [], displayLabel: 'Volume one' };
  const division: ReadingOccurrence = { ...chapters[0]!, occurrence: group, orderKey: 'a', role: 'group', target: null,
    work: volume, structure: volumeStructure, parent: volumeStructure, labels: [{ value: 'Division', language: 'en' }] };
  const inside = chapters.slice(0, 3).map(item => ({ ...item, occurrence: id(), work: volume, structure: volumeStructure, parent: group }));
  const emptyPart = { ...part, occurrence: id(), orderKey: 'b', target: empty, displayLabel: 'Empty volume' };
  const tail = { ...chapters[0]!, occurrence: id(), orderKey: 'c' };
  const inventory = [part, division, ...inside, emptyPart, tail];
  const f = fixture(inventory, [empty]);
  const actual: string[] = [];
  let cursor: string | undefined;
  do {
    const response = await f.call({ limit: '1', ...(cursor ? { cursor } : {}) }); expect(response.status).toBe(200);
    const page = await response.json(); actual.push(...page.items.map((item: ReadingOccurrence) => item.occurrence));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(actual).toEqual([part, ...inside, emptyPart, tail].map(item => item.occurrence));
  f.hideResource(volume);
  const hidden = await f.call({ q: 'Chapter 3' }); expect(hidden.status).toBe(200);
  expect((await hidden.json()).items).toEqual([]);
  const selected = await f.call({ position: inside[1]!.occurrence }); expect(selected.status).toBe(404);
});

test('G954: saved chooser positions retain exact session pins, Work and realization finishes, and reader snapshot fences', async () => {
  const f = fixture(); f.own();
  f.attempts.push({ state: 'finished', selections: [
    { target: { base: 'occurrence', resource: chapters.at(-1)!.occurrence, revision: id() } },
    { target: { base: 'occurrence', resource: chapters[9]!.occurrence, revision } },
  ] });
  const signed = (query: Record<string, string> = {}) => f.call({ actingSubject: reader, ...query }, 'reader');
  const pinned = await signed({ q: '旅程', limit: '2' }); expect(pinned.status).toBe(200);
  const first = await pinned.json(); expect(first.resolved).toBe(chapters[9]!.occurrence);
  f.completed.add(chapters[99]!.occurrence);
  expect((await signed({ q: '旅程', cursor: first.nextCursor })).status).toBe(400);
  f.attempts.push({ state: 'finished', selections: [{ target: { base: 'realization', resource: id(), work } }] });
  const realization = await signed({ q: '旅程' }); expect(realization.status).toBe(200);
  expect((await realization.json()).resolved).toBe(chapters.at(-1)!.occurrence);
  f.attempts.splice(1, 1, { state: 'finished', selections: [{ target: { base: 'work', resource: work } }] });
  const entire = await signed({ q: '旅程', limit: '1' }); expect(entire.status).toBe(200);
  const retained = await entire.json(); expect(retained.resolved).toBe(chapters.at(-1)!.occurrence);
  f.denyReader(); const reads = f.historyReads();
  expect((await signed({ q: '旅程', cursor: retained.nextCursor })).status).toBe(400);
  expect(f.historyReads()).toBe(reads);
  const ineligible = await signed({ q: '旅程' }); expect(ineligible.status).toBe(200);
  expect((await ineligible.json()).resolved).toBe('start'); expect(f.historyReads()).toBe(reads);
});
