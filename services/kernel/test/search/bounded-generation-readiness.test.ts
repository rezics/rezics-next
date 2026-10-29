import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { decodeSearchCursor } from '../../src/search/cursor.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { rebuildSubjects } from '../../src/search/generations.ts';
import * as indices from '../../src/search/indices.ts';
import { createOpenSearch, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { startSearchIndexing, subjectConsumer } from '../../src/search/runner.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { setupSemantic } from '../../src/semantic/setup.ts';
import { createImportIdentityDriver } from '../imports/identity-driver.ts';

const endpoint = process.env.OPENSEARCH_URL;
if (!endpoint || !process.env.DATABASE_URL) throw new Error('A real check database and OpenSearch node are required');
const engine = createOpenSearch(endpoint);
const identities = createImportIdentityDriver();
let identity: Awaited<ReturnType<typeof identities.open>>;
let source: ReturnType<typeof subjectSource>;
const subjects: { id: string; label: string }[] = [];
const expanded = '\uFDFA'.repeat(250);
const labels = [
  'Boundedbaseline Alpha',
  'Boundedbaseline Zeta',
  '漢'.repeat(250),
  expanded,
  '\uFDFA'.repeat(249) + 'a',
];
const filter = { type: { in: ['schema:Book'] } };
const oldRequest = { text: 'Boundedbaseline', sort: 'name' as const, limit: 1 };
const deployments: { prefix: string; runner: Awaited<ReturnType<typeof startSearchIndexing>> }[] = [];

type Page = { subjects: { id: string; labels: Record<string, string> }[]; next: string | null; total: unknown };
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Native Search did not converge at ${endpoint}`);
    await Bun.sleep(50);
  }
}
function app(prefix: string, client = engine) {
  return createKernel({
    pool: identity.database.pool,
    access: identity.access,
    routeKey: identity.routeKey,
    tokens: identity.tokenKeys,
    writeRate: createWriteRateLimiter({ secret: crypto.randomUUID() }),
    search: createSearchService({ pool: identity.database.pool, client, prefix, source, cursors: identity.tokenKeys }),
  });
}
async function request(application: ReturnType<typeof app>, body: unknown) {
  return application.handle(
    new Request('https://kernel.test/v1/subjects:search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
async function readyFailure(application: ReturnType<typeof app>, body: unknown) {
  const response = await request(application, body);
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('1');
  const problem = await response.json();
  expect(problem).toMatchObject({ code: 'index_not_ready', retryable: true });
  expect(problem.subjects).toBeUndefined();
  expect(problem.next).toBeUndefined();
}
async function page(application: ReturnType<typeof app>, body: unknown): Promise<Page> {
  const response = await request(application, body);
  expect(response.status).toBe(200);
  return response.json();
}
async function mapping(index: string) {
  return (
    await engine.request<Record<string, { mappings: { _meta?: Record<string, unknown> } }>>('GET', `/${index}/_mapping`)
  ).body[index]!.mappings;
}
async function native(index: string) {
  return (
    await engine.request<{
      hits: {
        hits: {
          _id: string;
          _index: string;
          _version: number;
          sort: (string | number | null)[];
          _source: Record<string, unknown>;
        }[];
      };
    }>('POST', `/${index}/_search`, {
      size: 100,
      version: true,
      sort: [{ name_sort: { order: 'asc', missing: '_last' } }, { id: 'asc' }],
    })
  ).body.hits.hits;
}

beforeAll(async () => {
  identity = await identities.open({ clock: () => new Date() });
  await setupSemantic(identity.database.pool, bundledRelease);
  source = subjectSource(identity.database.pool, identity.routeKey);
  const application = app(`test-${crypto.randomUUID().slice(0, 8)}-`);
  for (const label of labels) {
    // Legal names enter through actual Semantic commands and native Access, not source/index identities invented here.
    const response = await application.handle(
      new Request('https://kernel.test/v1/subjects', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${identity.ordinary.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify({ type: 'schema:Book', labels: { en: label }, statements: {} }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    subjects.push({ id: body.subject.id, label });
  }
}, 180_000);

afterAll(async () => {
  try {
    for (const { runner } of deployments) await runner.stop();
    for (const { prefix } of deployments) {
      for (const generation of (await indices.subjectGenerations(engine, prefix)).generations)
        await engine.request('DELETE', `/${indices.subjectIndexName(prefix, generation)}`);
      for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
        await engine.request('DELETE', `/_scripts/${prefix}${template}`).catch(() => undefined);
    }
  } finally {
    await identities.close();
  }
}, 180_000);

// This controlled overlay represents previously shipped unbounded documents and checkpoints only.
// It does not prove the current writer, source identity, Access, or any native rating vote projection.
async function legacyDocuments(prefix: string, generation: number) {
  const index = indices.subjectIndexName(prefix, generation);
  for (const partition of new Set(subjects.map(({ id }) => subjectPartition(id)))) {
    const ids = subjects.filter(({ id }) => subjectPartition(id) === partition).map(({ id }) => id);
    const snapshot = await source.read(partition, ids);
    expect(snapshot.subjects).toHaveLength(ids.length);
    const actions = documentActions(snapshot, ids);
    for (const action of actions) {
      expect(action.op).toBe('index');
      if (action.op === 'index') action.document.name_sort = subjects.find(({ id }) => id === action.id)!.label;
    }
    const lines = bulkLines(index, actions);
    // Preserve the real anchor version while replacing an already projected fixture document.
    for (let n = 0; n < lines.length; n += 2)
      (lines[n] as { index: { version_type: string } }).index.version_type = 'external_gte';
    expect((await engine.bulk<{ errors: boolean }>(lines, { query: { refresh: 'wait_for' } })).errors).toBe(false);
  }
  const huge = (await native(index)).find(({ _id }) => _id === subjects[3]!.id)!;
  expect(huge._source.names).toContain(expanded);
  expect(typeof huge.sort[0]).toBe('string');
  expect((huge.sort[0] as string).length).toBe(4500);
  expect(Buffer.byteLength(huge.sort[0] as string)).toBe(8250);
}
async function createLegacy(prefix: string, generation: number) {
  const definition = structuredClone(indices.subjectIndexDefinition()) as {
    mappings: { _meta?: unknown; properties: Record<string, unknown> };
  };
  delete definition.mappings._meta;
  definition.mappings.properties.name_sort = { type: 'keyword', normalizer: 'name_key' };
  await engine.request('PUT', `/${indices.subjectIndexName(prefix, generation)}`, definition);
}
async function deployment() {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  const runner = await startSearchIndexing({
    pool: identity.database.pool,
    search: engine,
    prefix,
    source,
    listing: subjectListingSource(identity.database.pool),
    intervalMs: 20,
    discoverMs: 60_000,
  });
  deployments.push({ prefix, runner });
  const index = indices.subjectIndexName(prefix, 1);
  await eventually(async () => (await native(index)).length === subjects.length);
  // Establish the legal public baseline before resolving any new format capability.
  const baseline = await page(app(prefix), { filter, sort: 'id', limit: 100 });
  expect(baseline.subjects.map(({ id }) => id).sort()).toEqual(subjects.map(({ id }) => id).sort());
  for (const subject of baseline.subjects)
    expect(subject.labels.en).toBe(subjects.find(({ id }) => id === subject.id)!.label);
  const oldCursor = (await page(app(prefix), oldRequest)).next;
  expect(oldCursor).toBeString();
  await runner.pause();
  await engine.request('PUT', `/${index}/_mapping`, {
    _meta: {},
    properties: { name_sort: { type: 'keyword', normalizer: 'name_key', ignore_above: 2147483647 } },
  });
  await legacyDocuments(prefix, 1);
  return { prefix, runner, index, oldCursor: oldCursor! };
}
async function rebuild(env: Awaited<ReturnType<typeof deployment>>, search = engine) {
  env.runner.resume();
  return rebuildSubjects({
    pool: identity.database.pool,
    search,
    source,
    prefix: env.prefix,
    runner: env.runner,
    pollMs: 20,
    timeoutMs: 30_000,
  });
}
async function boundedTraversal(prefix: string, generation: number) {
  const index = indices.subjectIndexName(prefix, generation);
  const hits = await native(index);
  expect(hits).toHaveLength(subjects.length);
  const expected = hits.map(({ _id }) => _id);
  for (const hit of hits) {
    expect(hit._index).toBe(index);
    const subject = subjects.find(({ id }) => id === hit._id)!;
    const snapshot = await source.read(subjectPartition(hit._id), [hit._id]);
    expect(hit._version).toBe(Number(snapshot.position));
    expect(hit._source.names).toContain(subject.label);
    if (subject.label.includes('\uFDFA')) expect(hit.sort[0]).toBeNull();
    else if (subject.label === labels[2]) expect(hit.sort[0]).toBe(labels[2]);
  }
  // Resolve the new capability after the actual legal baseline and production replay, never an import-time red.
  const capability = (indices as unknown as Record<string, unknown>).readSubjectSortFormat;
  expect(capability).toBeFunction();
  expect(
    await (capability as (s: OpenSearch, p: string, g: number) => Promise<number | null>)(engine, prefix, generation),
  ).toBe(1);
  expect((await mapping(index))._meta?.name_sort_format).toBe(1);
  for (const sort of ['name', 'collections'] as const) {
    const application = app(prefix);
    const seen: string[] = [];
    let cursor: string | undefined;
    let rounds = 0;
    do {
      const result = await page(application, { filter, sort, limit: 1, ...(cursor ? { cursor } : {}) });
      expect(result.total).toEqual({ value: subjects.length, relation: 'exact' });
      seen.push(...result.subjects.map(({ id }) => id));
      cursor = result.next ?? undefined;
      if (cursor) {
        expect(cursor.length).toBeLessThanOrEqual(4864);
        const decoded = await decodeSearchCursor(
          identity.tokenKeys,
          { operation: 'subjects.search', principal: 'anonymous', request: { filter, sort, limit: 1 } },
          cursor,
        );
        expect(decoded.ok).toBe(true);
        if (decoded.ok) {
          expect(decoded.generation).toBe(generation);
          expect(decoded.after).toEqual(
            sort === 'name' ? hits[seen.length - 1]!.sort : [0, ...hits[seen.length - 1]!.sort],
          );
        }
      }
      expect(++rounds).toBeLessThanOrEqual(subjects.length + 1);
    } while (cursor);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(subjects.length);
  }
}

test('an old unbounded generation cannot produce cursors until a genuinely rebuilt bounded generation is active', async () => {
  const env = await deployment();
  for (const sort of ['name', 'collections'] as const) await readyFailure(app(env.prefix), { filter, sort, limit: 1 });
  // Additive mapping changes cannot remove the old 4500-unit term or certify its format.
  await engine.request('PUT', `/${env.index}/_mapping`, {
    properties: { name_sort: { type: 'keyword', ignore_above: 512 } },
    _meta: { activated_at: new Date().toISOString() },
  });
  expect(((await native(env.index)).find(({ _id }) => _id === subjects[3]!.id)!.sort[0] as string).length).toBe(4500);
  await readyFailure(app(env.prefix), { filter, sort: 'name', limit: 1 });
}, 180_000);

test('an empty legacy generation still requires explicit bounded writer readiness', async () => {
  const env = await deployment();
  await createLegacy(env.prefix, 2);
  await engine.request('POST', '/_aliases', {
    actions: [
      { remove: { index: env.index, alias: indices.subjectAlias(env.prefix) } },
      { add: { index: indices.subjectIndexName(env.prefix, 2), alias: indices.subjectAlias(env.prefix) } },
    ],
  });
  expect(await native(indices.subjectIndexName(env.prefix, 2))).toEqual([]);
  for (const sort of ['name', 'collections'] as const) await readyFailure(app(env.prefix), { filter, sort, limit: 1 });
}, 180_000);

test('native replay normalizes every document and reconciles visible partition counts before atomic activation', async () => {
  const env = await deployment();
  let reconciled = false;
  const observed: OpenSearch = {
    bulk: (...args) => engine.bulk(...args),
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      if (args[0] === 'POST' && args[1] === '/_aliases') {
        const state = await indices.subjectGenerations(engine, env.prefix);
        expect(state.active).toBe(1);
        const index = indices.subjectIndexName(env.prefix, 2);
        const hits = await native(index);
        expect(hits).toHaveLength(subjects.length);
        const counts = new Map<number, number>();
        for (const hit of hits)
          counts.set(Number(hit._source.partition), (counts.get(Number(hit._source.partition)) ?? 0) + 1);
        const heads = await identity.database.pool.query<{
          partition_no: number;
          position: string;
          checkpoint: string;
        }>(
          `SELECT p.partition_no, p.position::text, c.position::text AS checkpoint FROM core.partition p
           LEFT JOIN core.consumer_checkpoint c ON c.partition_no=p.partition_no AND c.consumer=$1 WHERE p.position>0`,
          [subjectConsumer(env.prefix, 2)],
        );
        expect(heads.rows.length).toBeGreaterThan(0);
        for (const row of heads.rows) {
          expect(row.checkpoint).toBe(row.position);
          expect(counts.get(row.partition_no) ?? 0).toBe((await source.count(row.partition_no)).count);
          counts.delete(row.partition_no);
        }
        expect(counts.size).toBe(0);
        reconciled = true;
      }
      return engine.request<T>(...args);
    },
  };
  expect(await rebuild(env, observed)).toEqual({ generation: 2, previous: 1 });
  expect(reconciled).toBe(true);
  expect((await indices.subjectGenerations(engine, env.prefix)).active).toBe(2);
  const stale = await request(app(env.prefix), { ...oldRequest, cursor: env.oldCursor });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'search_restart_required' });
  await boundedTraversal(env.prefix, 2);
  // The old physical generation is retained intact for the existing retirement window.
  expect(((await native(env.index)).find(({ _id }) => _id === subjects[3]!.id)!.sort[0] as string).length).toBe(4500);
}, 180_000);

test('an unfinished legacy generation with advanced checkpoints cannot be certified by resume and a metadata stamp', async () => {
  const env = await deployment();
  await createLegacy(env.prefix, 2);
  await legacyDocuments(env.prefix, 2);
  const copied = await identity.database.pool.query(
    `INSERT INTO core.consumer_checkpoint(partition_no, consumer, epoch, position)
     SELECT partition_no, $1, epoch, position FROM core.consumer_checkpoint WHERE consumer=$2 RETURNING position`,
    [subjectConsumer(env.prefix, 2), subjectConsumer(env.prefix, 1)],
  );
  expect(copied.rows.some((row) => BigInt(row.position) > 0n)).toBe(true);
  const result = await rebuild(env).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  if (result.error) {
    expect(result.error).toMatchObject({ name: 'RebuildError' });
    expect((await indices.subjectGenerations(engine, env.prefix)).active).toBe(1);
    expect((await mapping(indices.subjectIndexName(env.prefix, 2)))._meta?.name_sort_format).toBeUndefined();
    await readyFailure(app(env.prefix), { filter, sort: 'name', limit: 1 });
  } else {
    expect(result.value!.generation).toBe(3);
    await boundedTraversal(env.prefix, 3);
  }
  expect(((await native(env.index)).find(({ _id }) => _id === subjects[3]!.id)!.sort[0] as string).length).toBe(4500);
}, 180_000);

test('partial and unavailable physical mapping reads fail typed readiness even for zero hits', async () => {
  const env = await deployment();
  await rebuild(env);
  for (const failure of ['partial', 'unavailable'] as const) {
    let reads = 0;
    const fault: OpenSearch = {
      bulk: (...args) => engine.bulk(...args),
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        if (args[0] === 'GET' && args[1].endsWith('/_mapping')) {
          reads++;
          if (failure === 'unavailable') throw new SearchUnavailableError('Controlled mapping-read outage');
          return { status: 200, body: {} as T };
        }
        return engine.request<T>(...args);
      },
    };
    await readyFailure(app(env.prefix, fault), { filter: { type: { in: ['schema:Recipe'] } }, sort: 'name', limit: 1 });
    expect(reads).toBeGreaterThan(0);
  }
}, 180_000);

test('an alias switch after readiness pins the verified physical generation including zero-hit queries', async () => {
  const env = await deployment();
  await rebuild(env);
  await createLegacy(env.prefix, 3);
  for (const queryFilter of [filter, { type: { in: ['schema:Recipe'] } }]) {
    const active = (await indices.subjectGenerations(engine, env.prefix)).active!;
    await engine.request('POST', '/_aliases', {
      actions: [
        { remove: { index: indices.subjectIndexName(env.prefix, active), alias: indices.subjectAlias(env.prefix) } },
        { add: { index: indices.subjectIndexName(env.prefix, 2), alias: indices.subjectAlias(env.prefix) } },
      ],
    });
    let switched = false;
    const targets: string[] = [];
    const racing: OpenSearch = {
      bulk: (...args) => engine.bulk(...args),
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        const response = await engine.request<T>(...args);
        if (args[1].endsWith('/_mapping') && !switched) {
          switched = true;
          await engine.request('POST', '/_aliases', {
            actions: [
              { remove: { index: indices.subjectIndexName(env.prefix, 2), alias: indices.subjectAlias(env.prefix) } },
              { add: { index: indices.subjectIndexName(env.prefix, 3), alias: indices.subjectAlias(env.prefix) } },
            ],
          });
        }
        if (args[1].endsWith('/_search/template')) targets.push(args[1]);
        return response;
      },
    };
    const result = await page(app(env.prefix, racing), { filter: queryFilter, sort: 'name', limit: 100 });
    expect(switched).toBe(true);
    expect(targets).toEqual([`/${indices.subjectIndexName(env.prefix, 2)}/_search/template`]);
    expect(result.subjects).toHaveLength(queryFilter === filter ? subjects.length : 0);
    await readyFailure(app(env.prefix), { filter: queryFilter, sort: 'name', limit: 1 });
  }
}, 180_000);
