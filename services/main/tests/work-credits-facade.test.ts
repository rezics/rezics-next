import { expect, test } from 'bun:test';
import { createMainApp } from '../src/app.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import {
  FusekiClient, FusekiReadBudgetExceeded, fusekiReadBudget,
  type SparqlResult, type TemplateQueryEnvelope,
} from '../src/infrastructure/fuseki.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { template } from '../src/modules/query/templates/work-credits.schema.ts';
import { creditSeekKey, type SeekCandidate } from '../src/modules/query/seek-index.ts';
import { WORK_READ_COST } from '../src/modules/work/read-contract.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const work = id(1), actor = id(2), main = id(3), head = id(4);
const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });
interface Credit {
  id: string; key: string; ordinal: number; displayName: string | null;
  confirmation?: string; nameSource?: { digest: string };
}
interface Page {
  profile: string; query: string; revision: number; items: Credit[]; complete: boolean;
  nextCursor: string | null; sourcePosition: { dataEpoch: string; sequence: string; dependencyToken: string };
  count: { value: number; kind: string; total: number | null };
}
interface Options {
  limit?: number; cursor?: string; language?: string; actor?: string;
  authenticated?: boolean; etag?: string; extra?: Record<string, string | undefined>;
}

function fixture() {
  const state = {
    public: true, granted: true, active: true, visible: true, sequence: '12',
    title: 'Work title', name: 'Source author', digest: 'a'.repeat(64), membership: 1,
    refs: [{ id: id(80), key: '/authors/OL1A', ordinal: 0 },
      { id: id(13), key: '/authors/OL3A', ordinal: 1 }],
    oversize: false, emptyGraph: false, nativeCount: 2, seekWindow: undefined as number | undefined,
    queries: [] as string[], envelopes: [] as TemplateQueryEnvelope[],
    afterTemplate: undefined as (() => void) | undefined,
    afterNames: undefined as (() => void) | undefined,
  };
  const credits = [
    { id: id(11), key: '/authors/OL1A', ordinal: 0 },
    { id: id(12), key: '/authors/OL2A', ordinal: 2 },
  ];
  const candidates: SeekCandidate[] = credits.map(credit => ({
    id: credit.id, key: creditSeekKey('author', credit.ordinal, credit.id)!, root: work,
    terms: { creditRevision: [id(credit.ordinal + 30)] },
  }));
  const meter = () => {
    const budget = fusekiReadBudget.getStore();
    if (budget) {
      budget.signal.throwIfAborted();
      if (budget.callsLeft <= 0) throw new FusekiReadBudgetExceeded('fixture call budget exhausted');
      budget.callsLeft--;
    }
  };
  class Graph extends FusekiClient {
    override async query(query: string): Promise<SparqlResult> {
      meter(); state.queries.push(query);
      if (query.includes('SELECT ?epoch ?sequence WHERE'))
        return { results: { bindings: [{ epoch: literal('epoch'), sequence: literal(state.sequence) }] } };
      if (query.includes('SELECT ?root ?main ?head ?mainHead ?public')) {
        expect(query).toContain(`VALUES ?root { <${work}> }`);
        expect(query).toContain('LIMIT 2');
        return { results: { bindings: [{ root: uri(work), main: uri(main), head: uri(head),
          mainHead: uri(id(5)), public: literal(String(state.public)) }] } };
      }
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r ?type ?work ?head ?public'))
        return { results: { bindings: [{ epoch: literal('epoch'), sequence: literal(state.sequence),
          r: uri(work), type: literal('work'), work: uri(work), head: uri(head),
          public: literal(String(state.public)), label: { ...literal(state.title), 'xml:lang': 'en' } }] } };
      if (query.includes('SELECT ?work ?head ?owningWork ?owningHead'))
        return { results: { bindings: [{ work: uri(work), head: uri(head),
          owningWork: uri(work), owningHead: uri(head) }] } };
      throw new Error(`Unrecognized credits fixture query: ${query}`);
    }
    override async templateQuery(envelope: TemplateQueryEnvelope): Promise<SparqlResult> {
      meter(); state.envelopes.push(envelope);
      expect(envelope.query).toContain('SELECT ?id ?key ?ordinal ?confirmation');
      expect(envelope.bindings).toEqual({});
      expect(envelope.tables[0]).toEqual({ columns: ['_work_iri', '_main_iri'], rows: [[uri(work), uri(main)]] });
      const bindings = envelope.candidates!.map(candidate => {
        const credit = [...credits, ...state.refs].find(item => item.id === candidate.id!.value)!;
        return { id: uri(credit.id), key: literal(credit.key), ordinal: literal(String(credit.ordinal)),
          role: literal('author'), participantKind: literal('external-reference'), provider: literal('open-library'),
          ...(!credits.some(item => item.id === credit.id) ? { confirmation: literal('source-reported') } : {}) };
      });
      const change = state.afterTemplate;
      state.afterTemplate = undefined;
      change?.();
      return { results: { bindings } };
    }
  }
  const graph = new Graph('http://credits-fixture.invalid');
  const deps = {
    environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
      objectDirectory: '.temp/work-credits-unused' },
    account: { verify: async () => ({ issuer: 'https://account.test', subject: 'reader' }) },
    access: {
      assertRecoveryOpen: async () => undefined,
      activePrincipalId: async () => state.active ? actor : null,
      canReadWork: async (_principal: unknown, acting: string, root: string) =>
        state.granted && acting === actor && root === work,
    },
    templateSeek: {
      keys: async () => [{ revision: state.membership }],
      candidates: async (_epoch: string, keys: unknown[], after: { key: string; id: string } | null, limit: number) => {
        expect(keys).toHaveLength(2);
        expect(limit).toBeLessThanOrEqual(21);
        const remaining = state.emptyGraph ? [] : candidates.slice(0, state.nativeCount)
          .filter(row => !after || row.key > after.key);
        const rows = remaining.slice(0, Math.min(limit, state.seekWindow ?? limit));
        return { rows: state.oversize ? Array.from({ length: 257 }, () => candidates[0]!) : rows,
          more: remaining.length > rows.length };
      },
      confirmed: async () => new Set([`${work}\0/authors/OL1A`]),
    },
    sourceAdoptions: { authorReferences: async (roots: string[]) => {
      expect(roots).toEqual([work]);
      return new Map([[work, state.refs]]);
    } },
    sourceAuthorNames: { batch: async (keys: string[]) => {
      expect(keys.length).toBeLessThanOrEqual(20);
      const names = new Map(keys.map(key => [key, { displayName: `${state.name} ${key}`, nameSource: {
        record: id(41), observation: id(42), revision: id(43), sourceRevision: null,
        digest: state.digest, url: 'https://openlibrary.org/authors/OL1A.json',
        fetchedAt: '2026-10-07T00:00:00Z', basis: 'facts', field: '/name',
      } }]));
      const change = state.afterNames;
      state.afterNames = undefined;
      change?.();
      return names;
    } },
  } as unknown as MainWorkDependencies;
  const app = createMainApp(graph, deps);
  configureDisclosure(deps.environment, { read: async targets => targets.map(() => state.visible ? 'visible' : 'hidden') });
  const call = (method: 'GET' | 'POST', options: Options = {}) => {
    const headers = { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(options.authenticated ? { authorization: 'Bearer reader' } : {}),
      ...(options.etag ? { 'if-none-match': options.etag } : {}) };
    if (method === 'POST') return app.handle(new Request('http://main.test/v1/query', {
      method, headers, body: JSON.stringify({ profile: 'template-query-v1', query: template.query, revision: 1,
        parameters: { roots: [work] }, limit: options.limit ?? 20, cursor: options.cursor,
        presentation: { language: options.language, actingSubject: options.actor } }),
    }));
    const url = new URL(`http://main.test/v1/works/${work.slice(-36)}/credits`);
    for (const [key, value] of Object.entries({ limit: options.limit, cursor: options.cursor,
      language: options.language, actingSubject: options.actor, ...options.extra }))
      if (value !== undefined) url.searchParams.set(key, String(value));
    return app.handle(new Request(url, { headers }));
  };
  return { state, deps, call };
}

async function page(response: Response, method: 'GET' | 'POST' = 'GET'): Promise<Page> {
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('etag')).toMatch(/^W\/"[a-f0-9]{64}"$/);
  return method === 'GET' ? body as Page : (body as { result: Page }).result;
}
async function problem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect((await response.json() as { code: string }).code).toBe(code);
}

test('Work credits exhausted nonempty graph windows retain trailing source tuples and bounded continuation', async () => {
  const { call, state } = fixture(); state.nativeCount = 1;
  const getResponse = await call('GET'), postResponse = await call('POST');
  const get = await page(getResponse), post = await page(postResponse, 'POST');
  expect(get).toEqual(post);
  expect(getResponse.headers.get('etag')).toBe(postResponse.headers.get('etag'));
  expect(get.items.map(item => item.id)).toEqual([id(11), id(13)]);
  expect(get.items[1]).toMatchObject({ key: '/authors/OL3A', ordinal: 1, confirmation: 'source-reported' });
  expect(get.count).toEqual({ value: 2, kind: 'exact-page', total: null });
  expect(get.complete).toBe(true); expect(get.nextCursor).toBeNull();
  for (const method of ['GET', 'POST'] as const) {
    const first = await page(await call(method, { limit: 1 }), method);
    expect(first.items.map(item => item.id)).toEqual([id(11)]);
    expect(first.complete).toBe(false); expect(first.nextCursor).toBeString();
    const tail = await page(await call(method === 'GET' ? 'POST' : 'GET',
      { limit: 1, cursor: first.nextCursor! }), method === 'GET' ? 'POST' : 'GET');
    expect(tail.items.map(item => item.id)).toEqual([id(13)]);
    expect(tail.count).toEqual({ value: 1, kind: 'exact-page', total: null });
    expect(tail.complete).toBe(true); expect(tail.nextCursor).toBeNull();
  }
});

test('Work credits empty and source-only windows preserve exact page counts on both routes', async () => {
  const { call, state } = fixture(); state.emptyGraph = true; state.refs = [];
  const emptyGet = await page(await call('GET')), emptyPost = await page(await call('POST'), 'POST');
  expect(emptyGet).toEqual(emptyPost);
  expect(emptyGet.items).toEqual([]);
  expect(emptyGet.count).toEqual({ value: 0, kind: 'exact-page', total: null });
  expect(emptyGet.complete).toBe(true); expect(emptyGet.nextCursor).toBeNull();
  state.refs = [{ id: id(13), key: '/authors/OL3A', ordinal: 1 }];
  const sourceGet = await page(await call('GET')), sourcePost = await page(await call('POST'), 'POST');
  expect(sourceGet).toEqual(sourcePost);
  expect(sourceGet.items).toHaveLength(1);
  expect(sourceGet.items[0]).toMatchObject({ id: id(13), ordinal: 1, confirmation: 'source-reported' });
  expect(sourceGet.count).toEqual({ value: 1, kind: 'exact-page', total: null });
  expect(sourceGet.complete).toBe(true); expect(sourceGet.nextCursor).toBeNull();
});

test('Work credits unfinished graph windows defer later source tuples until their ordering horizon', async () => {
  const { call, state } = fixture(); state.seekWindow = 1;
  state.refs = [{ id: id(13), key: '/authors/OL3A', ordinal: 3 }];
  const first = await page(await call('GET'));
  expect(first.items.map(item => item.id)).toEqual([id(11)]);
  expect(first.complete).toBe(false); expect(first.nextCursor).toBeString();
  const tail = await page(await call('POST', { cursor: first.nextCursor! }), 'POST');
  expect(tail.items.map(item => item.id)).toEqual([id(12), id(13)]);
  expect(tail.count).toEqual({ value: 2, kind: 'exact-page', total: null });
  expect(tail.complete).toBe(true); expect(tail.nextCursor).toBeNull();
  expect([...first.items, ...tail.items].map(item => item.id)).toEqual([id(11), id(12), id(13)]);
});

test('Work credits GET and reviewed POST share exact fields, count, local basis and interchangeable continuations', async () => {
  const { call, state } = fixture();
  const getResponse = await call('GET', { limit: 1 }), postResponse = await call('POST', { limit: 1 });
  expect(getResponse.headers.get('etag')).toBe(postResponse.headers.get('etag'));
  const get = await page(getResponse), post = await page(postResponse, 'POST');
  expect({ ...get, nextCursor: !!get.nextCursor }).toEqual({ ...post, nextCursor: !!post.nextCursor });
  expect(get).toMatchObject({ profile: 'template-result-v1', query: template.query, revision: 1,
    complete: false, count: { value: 1, kind: 'exact-page', total: null },
    sourcePosition: { dataEpoch: 'epoch', sequence: '12' } });
  expect(get.items[0]).toMatchObject({ id: id(11), role: 'author', provider: 'open-library', key: '/authors/OL1A' });
  const second = await page(await call('GET', { limit: 1, cursor: post.nextCursor! }));
  const secondPost = await page(await call('POST', { limit: 1, cursor: post.nextCursor! }), 'POST');
  expect({ ...second, nextCursor: !!second.nextCursor }).toEqual({ ...secondPost, nextCursor: !!secondPost.nextCursor });
  expect(second.items[0]).toMatchObject({ id: id(13), confirmation: 'source-reported', ordinal: 1 });
  const tail = await page(await call('POST', { limit: 1, cursor: second.nextCursor! }), 'POST');
  expect(tail.items[0]).toMatchObject({ id: id(12), ordinal: 2 });
  expect(tail.complete).toBe(true); expect(tail.nextCursor).toBeNull();
  expect([get.items[0]!.id, second.items[0]!.id, tail.items[0]!.id]).toEqual([id(11), id(13), id(12)]);
  expect(state.envelopes.every(envelope => envelope.limit <= 21)).toBe(true);
});

test('Work credits retain public reads, private admission and anonymous disclosure denials on both routes', async () => {
  for (const method of ['GET', 'POST'] as const) {
    const { call, state } = fixture();
    expect((await page(await call(method), method)).items).toHaveLength(3);
    state.public = false;
    await problem(await call(method), 404, 'work_unavailable');
    expect((await call(method, { authenticated: true, actor })).status).toBe(200);
    state.granted = false;
    await problem(await call(method, { authenticated: true, actor }), 404, 'work_unavailable');
    state.public = true; state.visible = false;
    await problem(await call(method), 404, 'work_unavailable');
  }
});

test('Work credits cursors bind actor, language and page bound; malformed cursors carry no authority', async () => {
  const { call } = fixture();
  const first = await page(await call('GET', { authenticated: true, actor, language: 'en', limit: 1 }));
  for (const method of ['GET', 'POST'] as const) {
    for (const changed of [{ actor: id(99) }, { language: 'ja' }, { limit: 2 }, { cursor: 'malformed' }])
      await problem(await call(method, { authenticated: true, actor, language: 'en', limit: 1,
        cursor: first.nextCursor!, ...changed }), 400, 'invalid_work_read');
    await problem(await call(method, { actor }), 401, 'account_assertion_denied');
    await problem(await call(method, { authenticated: true }), 400, 'invalid_work_read');
  }
});

test('Work credits GET admits only its path root and bounded page inputs', async () => {
  const { call, state } = fixture();
  for (const limit of [0, 21, 1.5]) expect((await call('GET', { limit })).status).toBe(400);
  expect((await call('GET', { language: 'invalid_language' })).status).toBe(400);
  expect((await call('GET', { cursor: '' })).status).toBe(400);
  for (const extra of [{ query: template.query }, { revision: '2' }, { roots: id(99) },
    { sparql: 'SELECT * WHERE {?s ?p ?o}' }, { scope: 'mine' }])
    expect((await call('GET', { extra })).status).toBe(400);
  expect(state.envelopes).toHaveLength(0);
});

test('Work credits unavailable seek and candidate or shared read budget exhaustion use existing failures', async () => {
  for (const method of ['GET', 'POST'] as const) {
    const missing = fixture(); missing.deps.templateSeek = undefined;
    await problem(await missing.call(method), 503, 'work_read_unavailable');
    const oversized = fixture(); oversized.state.oversize = true;
    await problem(await oversized.call(method), 422, 'work_read_budget_exceeded');
    const metered = fixture();
    await fusekiReadBudget.run({ signal: new AbortController().signal, callsLeft: 0, bytesLeft: 1024 }, async () =>
      problem(await metered.call(method), 422, 'work_read_budget_exceeded'));
    expect(metered.state.envelopes).toHaveLength(0);
    expect(metered.state.queries.length).toBeLessThanOrEqual(WORK_READ_COST.graphCalls);
  }
});

test('Work credits 304 preserves private headers and revalidates names, source tuples and local basis', async () => {
  const { call, state } = fixture();
  const response = await call('GET'), tag = response.headers.get('etag')!;
  await page(response);
  for (const method of ['GET', 'POST'] as const) {
    const unchanged = await call(method, { etag: tag });
    expect(unchanged.status).toBe(304); expect(await unchanged.text()).toBe('');
    expect(unchanged.headers.get('etag')).toBe(tag);
    expect(unchanged.headers.get('cache-control')).toBe('private, no-store');
  }
  state.sequence = '13';
  expect((await call('GET', { etag: tag })).status).toBe(304);
  state.name = 'Refreshed name'; state.digest = 'b'.repeat(64);
  const renamed = await call('GET', { etag: tag });
  expect(renamed.headers.get('etag')).not.toBe(tag);
  expect((await page(renamed)).items[0]).toMatchObject({ displayName: 'Refreshed name /authors/OL1A',
    nameSource: { digest: 'b'.repeat(64) } });
  state.refs = state.refs.filter(ref => ref.id !== id(13));
  expect((await page(await call('GET', { etag: tag }))).items.map(item => item.id)).toEqual([id(11), id(12)]);
});

test('Work credits continuations recheck source and membership, and conditional requests never bypass revoked rights', async () => {
  for (const method of ['GET', 'POST'] as const) {
    for (const change of ['source', 'membership'] as const) {
      const { call, state } = fixture();
      const first = await page(await call(method, { limit: 1 }), method);
      if (change === 'source') state.refs = []; else state.membership++;
      await problem(await call(method, { limit: 1, cursor: first.nextCursor! }), 409, 'read_basis_changed');
    }
    for (const change of ['source', 'name'] as const) {
      const { call, state } = fixture();
      const first = await page(await call(method, { limit: 1 }), method);
      if (change === 'source') state.afterTemplate = () => { state.refs = []; };
      else state.afterNames = () => { state.name = 'Moved name'; };
      await problem(await call(method, { limit: 1, cursor: first.nextCursor! }), 409, 'read_basis_changed');
    }
    const { call, state } = fixture(); state.public = false;
    const response = await call(method, { authenticated: true, actor, limit: 1 });
    const tag = response.headers.get('etag')!, first = await page(response, method);
    state.granted = false;
    await problem(await call(method, { authenticated: true, actor, limit: 1, cursor: first.nextCursor!, etag: tag }),
      404, 'work_unavailable');
    state.granted = true; state.active = false;
    await problem(await call(method, { authenticated: true, actor, etag: tag }), 401, 'account_assertion_denied');
  }
});

test('Work credits conditional hydration rejects rights revoked during either execution', async () => {
  for (const method of ['GET', 'POST'] as const) {
    const { call, state } = fixture(); state.public = false;
    const options = { authenticated: true, actor };
    const initial = await call(method, options), etag = initial.headers.get('etag')!;
    await page(initial, method);
    state.afterTemplate = () => { state.granted = false; };
    await problem(await call(method, { ...options, etag }), 404, 'work_unavailable');
    state.granted = true;
    state.afterTemplate = () => { state.active = false; };
    await problem(await call(method, { ...options, etag }), 401, 'account_assertion_denied');
  }
});
