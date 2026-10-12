import { expect, test } from 'bun:test';
import { FusekiClient, FusekiPrefixWalkRestart, FusekiPrefixWalkUnavailable, FusekiReadBudgetExceeded,
  createFusekiReadDiagnostics, fusekiReadBudget, snapshotFusekiReadDiagnostics,
  type SparqlResult, type FusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { queryTypeaheadCandidates, readPublicTypeahead } from '../src/modules/search/typeahead.ts';
import { prefixWalkCursor, prefixWalkDirectoryKey, prefixWalkExaminedLimit,
  type PrefixWalkEntry, type PrefixWalkRequest, type PrefixWalkResponse } from '../src/modules/search/prefix-walk.ts';
import { SEARCH_FIELD_COST } from '../src/modules/search/fields.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { SourceAuthorNameStore } from '../src/modules/source/author-name.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { PublicQueryUnavailable } from '../src/modules/work/search-budget.ts';
import { SearchSnapshotMoved } from '../src/modules/work/search-readiness.ts';
import { searchRoutes } from '../src/routes/search.ts';

const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const value = (text: string) => ({ type: 'literal' as const, value: text });
const generation = 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000001';
type Row = NonNullable<SparqlResult['results']>['bindings'][number];

function nativeEntry(number: number, matchedField: 'title' | 'credit' = 'title', rejected = false): PrefixWalkEntry {
  const entry = { mainVersion: id(number), matchUnit: id(number + 1_000), matchedField, rejected };
  return { ...entry, key: prefixWalkDirectoryKey(entry) };
}
function candidate(entry: PrefixWalkEntry, text = 'Bounded title'): Row {
  return { unit: value(entry.matchUnit), main: value(entry.mainVersion), work: value(id(Number.parseInt(entry.mainVersion.slice(-12), 16) + 2_000)),
    contribution: value(id(3_001)), revision: value(id(3_002)), selection: value(id(3_003)),
    language: value('en'), field: value(entry.matchedField), kind: value('label'),
    text: { ...value(text), 'xml:lang': 'en' } };
}

function fixture(entries: PrefixWalkEntry[], rows = entries.filter(entry => !entry.rejected).map(entry => candidate(entry))) {
  const queries: string[] = [], walks: PrefixWalkRequest[] = [];
  const state = { available: true, failure: null as Error | null, sequence: '7', summaryReads: 0,
    hidden: new Set<string>(), changeNameOnSecondRead: false };
  const control = () => ({ epoch: value('epoch'), sequence: value(state.sequence), generation: value(generation), population: value('256') });
  const fuseki = {
    commandHealth: async () => ({ moduleVersion: 'test', instanceId: '00000000-0000-4000-8000-000000000001',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false, publicSearchDeltaAvailable: false,
      prefixWalkAvailable: state.available, profiles: {} }),
    prefixWalk: async (request: PrefixWalkRequest): Promise<PrefixWalkResponse> => {
      walks.push(request);
      if (state.failure) throw state.failure;
      const after = request.cursor === null ? '' : (JSON.parse(Buffer.from(request.cursor, 'base64url').toString()) as { after: string }).after;
      const remaining = entries.filter(entry => entry.key.localeCompare(after) > 0);
      const page = remaining.slice(0, request.pageSize);
      const more = remaining.length > page.length;
      return { entries: page, generation: '1', examined: page.length,
        rejected: page.filter(entry => entry.rejected).length, more,
        cursor: more ? prefixWalkCursor(request, '1', page.at(-1)!.key) : null };
    },
    query: async (sparql: string) => {
      queries.push(sparql);
      let bindings: Row[];
      if (sparql.includes('SELECT ?unit ?work ?main')) {
        bindings = rows.filter(row => sparql.includes(`<${row.unit!.value}>`)).reverse();
      } else if (sparql.includes('SELECT DISTINCT ?work ?field')) {
        bindings = rows.filter(row => sparql.includes(`<${row.work!.value}>`)).reverse();
      } else if (sparql.includes('SELECT ?epoch ?sequence ?work ?type')) {
        bindings = rows.filter(row => sparql.includes(`<${row.work!.value}>`))
          .map(row => ({ ...control(), work: row.work! }));
      } else if (sparql.includes('SELECT ?epoch ?sequence ?hold ?r ?type')) {
        state.summaryReads++;
        bindings = rows.filter(row => sparql.includes(`<${row.work!.value}>`)).map(row => ({
          ...control(), r: row.work!, work: row.work!, type: value('work'), head: value(id(4_001)),
          public: value(state.hidden.has(row.work!.value) ? 'false' : 'true'), erased: value('false'),
          label: { ...value(state.changeNameOnSecondRead && state.summaryReads > 1 ? 'Changed name' : 'Bounded title'), 'xml:lang': 'en' },
        }));
        if (!bindings.length) bindings = [control()];
      } else if (/SELECT \?epoch \?sequence(?: \?generation)?(?: \?population)? WHERE/u.test(sparql)) {
        bindings = [control()];
      } else bindings = [];
      return { results: { bindings } };
    },
  };
  const env = { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as unknown as WorkActivationEnvironment;
  const work = { environment: env, access: { assertRecoveryOpen: async () => undefined,
    canReadWorks: async () => new Set<string>() } } as unknown as MainWorkDependencies;
  return { env, work, state, queries, walks, fuseki };
}
const request = () => new Request('http://main.test/v1/search/typeahead?prefix=bounded');
const present: Parameters<typeof readPublicTypeahead>[3] = async relation => relation;

test('native prefix transport sends the command envelope and accounts visits, failures and byte limits', async () => {
  const capability = 'b'.repeat(64);
  const input: PrefixWalkRequest = { prefix: 'bounded', language: null, pageSize: 2, cursor: null };
  const entries = [nativeEntry(1, 'title', true), nativeEntry(2)];
  const native: PrefixWalkResponse = { entries, generation: '1', examined: 2, rejected: 1, more: false, cursor: null };
  const payload = JSON.stringify(native);
  let status = 200;
  const received: { method: string; path: string; authorization: string | null; envelope: unknown }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    received.push({ method: request.method, path: new URL(request.url).pathname,
      authorization: request.headers.get('authorization'), envelope: await request.json() });
    return new Response(status === 200 ? payload : '{}', { status,
      headers: { 'content-type': 'application/json' } });
  } });
  const controller = new AbortController();
  const budget: FusekiReadBudget = { signal: controller.signal, callsLeft: 4,
    bytesLeft: 65_536, diagnostics: createFusekiReadDiagnostics() };
  try {
    const client = new FusekiClient(`http://127.0.0.1:${server.port}/rezics/`, undefined, capability);
    const read = () => fusekiReadBudget.run(budget, () => client.prefixWalk(input));
    expect(await read()).toEqual(native);
    expect(received).toEqual([{ method: 'POST', path: '/rezics/command',
      authorization: `Bearer ${capability}`, envelope: { prefixWalk: input } }]);
    expect(budget.callsLeft).toBe(3);
    expect(budget.bytesLeft).toBe(65_536 - Buffer.byteLength(payload));
    expect(snapshotFusekiReadDiagnostics(budget)).toMatchObject({ active: [], omitted: 0,
      history: [{ family: 'query', examined: 2, status: 'complete' }] });
    status = 409;
    await expect(read()).rejects.toBeInstanceOf(FusekiPrefixWalkRestart);
    status = 503;
    await expect(read()).rejects.toBeInstanceOf(FusekiPrefixWalkUnavailable);
    expect(budget.callsLeft).toBe(1);
    expect(snapshotFusekiReadDiagnostics(budget)?.history.map(call => call.status))
      .toEqual(['complete', 'failed', 'failed']);
    status = 200;
    budget.bytesLeft = Buffer.byteLength(payload) - 1;
    await expect(read()).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    expect(budget.callsLeft).toBe(0);
    expect(received).toHaveLength(4);
    controller.abort(new Error('search deadline expired'));
    await expect(read()).rejects.toBe(controller.signal.reason);
    expect(received).toHaveLength(4);
  } finally { await server.stop(true); }
});

test('candidate hydration follows native title/credit ordering and contains only the walked units', async () => {
  const entries = [nativeEntry(2), nativeEntry(3), nativeEntry(1, 'credit')];
  const rows = [candidate(entries[0]!), candidate(entries[1]!, 'Bounded second'),
    { ...candidate(entries[2]!, 'Bounded native author'), agent: value(id(5_001)) }];
  const f = fixture(entries, rows);
  const matches = await queryTypeaheadCandidates(f.env, 'bounded', entries);
  expect(matches.map(row => [row.mainVersion, row.matchedField, row.matchedText]))
    .toEqual([[id(2), 'title', 'Bounded title'], [id(3), 'title', 'Bounded second'],
      [id(1), 'credit', 'Bounded native author']]);
  expect(matches[2]?.nameOwner).toBe(id(5_001));
  expect(f.queries).toHaveLength(2);
  const sparql = f.queries[0]!;
  expect(sparql).toContain('VALUES');
  for (const entry of entries) expect(sparql).toContain(`<${entry.matchUnit}>`);
  expect(f.queries.every(query => !/CONTAINS\s*\(/iu.test(query))).toBe(true);
});

test('source-author matches use bounded exact key hydration and preserve source text', async () => {
  const entry = nativeEntry(1, 'credit');
  const row: Row = { ...candidate(entry), key: value('/authors/OL1A'), kind: value('source') };
  delete row.text;
  const f = fixture([entry], [row]);
  const batches: string[][] = [];
  let searches = 0;
  const names = { batch: async (keys: string[]) => {
    batches.push(keys);
    return new Map([['/authors/OL1A', { displayName: 'Jane Bounded', nameSource: { revision: id(6_001) } }]]);
  }, search: async () => { searches++; throw new Error('typeahead must not search SQL names'); },
  searchGeneration: async () => '1' } as unknown as SourceAuthorNameStore;
  const matches = await queryTypeaheadCandidates(f.env, 'bounded', [entry], names);
  expect(matches).toMatchObject([{ matchedField: 'credit', matchedText: 'Jane Bounded', matchedLanguage: null }]);
  expect(batches).toEqual([['/authors/OL1A']]);
  expect(searches).toBe(0);
  expect(f.queries.every(sparql => !/CONTAINS\s*\(/iu.test(sparql))).toBe(true);
});

test('typeahead advances past native tombstones, hidden and presentation-rejected Works to fill its page', async () => {
  const entries = Array.from({ length: 14 }, (_, index) => nativeEntry(index + 1, 'title', index === 0));
  const f = fixture(entries);
  f.state.hidden.add(id(2_002));
  const filtered: Parameters<typeof readPublicTypeahead>[3] = async relation => ({ ...relation,
    results: relation.results.filter(row => row.mainVersion !== id(3)) });
  const result = await readPublicTypeahead(f.work, request(), { prefix: 'bounded', language: 'fr' }, filtered);
  expect(result.items.map(item => item.mainVersion)).toEqual(Array.from({ length: 10 }, (_, index) => id(index + 4)));
  expect(result.hasMore).toBe(true);
  expect(result.sourcePosition).toEqual({ dataEpoch: 'epoch', sequence: '7' });
  expect(f.walks.length).toBeGreaterThan(1);
  expect(f.walks[1]?.cursor).not.toBeNull();
  expect(f.walks.every(walk => walk.language === null && walk.pageSize <= SEARCH_FIELD_COST.typeaheadItems)).toBe(true);
  expect(f.walks.reduce((sum, walk) => sum + walk.pageSize, 0)).toBeLessThanOrEqual(prefixWalkExaminedLimit(SEARCH_FIELD_COST.typeaheadItems));
  expect(f.queries.every(sparql => !/CONTAINS\s*\(/iu.test(sparql))).toBe(true);
});

test('terminal directory produces hasMore false and an exhausted rejection budget retains hasMore', async () => {
  const terminal = fixture([nativeEntry(1), nativeEntry(2)]);
  const result = await readPublicTypeahead(terminal.work, request(), { prefix: 'bounded' }, present);
  expect(result.items).toHaveLength(2);
  expect(result.hasMore).toBe(false);
  const limit = prefixWalkExaminedLimit(SEARCH_FIELD_COST.typeaheadItems);
  const rejected = fixture(Array.from({ length: limit + 1 }, (_, index) => nativeEntry(index + 1, 'title', true)));
  const empty = await readPublicTypeahead(rejected.work, request(), { prefix: 'bounded' }, present);
  expect(empty.items).toEqual([]);
  expect(empty.hasMore).toBe(true);
  expect(rejected.walks.reduce((sum, walk) => sum + walk.pageSize, 0)).toBe(limit);
});

test('unadvertised and unqualified native directories refuse the route with typed 503 without a scan', async () => {
  for (const mode of ['unadvertised', 'unqualified'] as const) {
    const f = fixture([nativeEntry(1)]);
    if (mode === 'unadvertised') f.state.available = false;
    else f.state.failure = new FusekiPrefixWalkUnavailable('native generation has no qualified coverage');
    await expect(readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, present))
      .rejects.toBeInstanceOf(PublicQueryUnavailable);
    const app = searchRoutes(f.env.fuseki, f.work);
    const response = await app.handle(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'query_unavailable' });
    if (mode === 'unadvertised') expect(f.walks).toEqual([]);
    expect(f.queries.every(sparql => !/CONTAINS\s*\(/iu.test(sparql))).toBe(true);
  }
});

test('native generation changes and changing hydrated disclosure refuse a partial page', async () => {
  const moved = fixture([nativeEntry(1)]);
  moved.state.failure = new FusekiPrefixWalkRestart('generation changed');
  await expect(readPublicTypeahead(moved.work, request(), { prefix: 'bounded' }, present))
    .rejects.toBeInstanceOf(SearchSnapshotMoved);
  const changed = fixture([nativeEntry(1)]);
  changed.state.changeNameOnSecondRead = true;
  await expect(readPublicTypeahead(changed.work, new Request('http://main.test/typeahead'), { prefix: 'bounded' }, present))
    .rejects.toBeInstanceOf(SearchSnapshotMoved);
});
