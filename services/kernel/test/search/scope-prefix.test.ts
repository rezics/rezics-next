import { afterAll, beforeAll, expect, test } from 'bun:test';
import { admitFilter, parseFilter, type FilterDocument } from '@rezics/filter';
import { bundledRelease } from '@rezics/definitions/bundled';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { checkHits } from '../../src/search/disclosure/check.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { compileFilter } from '../../src/search/filter.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import {
  installTemplates,
  searchSubjects,
  SEARCH_TEMPLATE,
  SUGGEST_TEMPLATE,
  FACET_TEMPLATE,
  type SearchHit,
} from '../../src/search/query.ts';
import { subjectPartition, type SubjectSource } from '../../src/search/source.ts';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createRealAccess } from '../semantic/real-access.ts';

// Runtime discovery is deliberately after successful native setup. A missing additive
// capability must be a red assertion, not a loader error, bad bearer or route 404.
// Until the owning module lands, this is the narrow expected prepare/prefix surface.
// No test supplies a ready identity stamp or treats an outbox position as one.
type Prepared = { readonly generation: number; readonly basis: unknown };
type Prefix = {
  hits: SearchHit[];
  coveredThrough: string | null;
  exhausted: boolean;
  generation: number;
  usage: { candidates: number };
};
type Scope = {
  prepare(filter: FilterDocument): Promise<Prepared>;
  prefix(prepared: Prepared, request: { afterSubject?: string; quota: number; budget: number }): Promise<Prefix>;
};
type Factory = (dependencies: {
  pool: ReturnType<typeof createPool>;
  client: OpenSearch;
  prefix: string;
  source: SubjectSource;
}) => Scope;

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const client = createOpenSearch(searchUrl);
const routeKey = new Uint8Array(32).fill(83);
const source = subjectSource(pool, routeKey);
const owned: string[] = [];
const filter = parseFilter({ type: { in: ['schema:Book'] } });
let ids: string[];
let native: SearchHit[];
let prefix: string;

function fresh() {
  const value = `scope-${crypto.randomUUID().slice(0, 8)}-`;
  owned.push(value);
  return value;
}

beforeAll(async () => {
  const actions = ['subject:create', 'subject:read', 'moderation:hide'];
  const access = await createRealAccess(admin, { editor: newId(30001) }, actions);
  for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  await bootstrapRelease(pool, bundledRelease);
  const kernel = createKernel({ pool, routeKey, access: access.access, writeRate: access.writeRate });
  async function post(path: string, body: unknown) {
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access.bearer('editor')}`,
          'idempotency-key': `"${crypto.randomUUID()}"`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    );
    const result = (await response.json()) as { subject?: { id: string }; code?: string };
    expect([response.status, result.code], `${path}: ${JSON.stringify(result)}`).toEqual([
      path === '/v1/subjects' ? 201 : 200,
      undefined,
    ]);
    return result;
  }
  ids = [];
  for (let n = 0; n < 3; n++) {
    const result = await post('/v1/subjects', { type: 'schema:Book', labels: { en: `Scope prefix ${n}` } });
    ids.push(result.subject!.id);
  }
  ids.sort();
  prefix = fresh();
  await createSubjectIndex(client, prefix, 1);
  for (const id of ids) {
    const snapshot = await source.read(subjectPartition(id), [id]);
    expect(snapshot.subjects.map((entry) => entry.id)).toEqual([id]);
    const response = await client.bulk<{ errors: boolean }>(
      bulkLines(subjectIndexName(prefix, 1), documentActions(snapshot, [id])),
      { query: { refresh: 'wait_for' } },
    );
    expect(response.errors).toBe(false);
  }
  await client.request('POST', '/_aliases', {
    actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
  });
  await installTemplates(client, prefix);
  const release = await activeRelease(pool);
  expect(release).not.toBeNull();
  const compiled = compileFilter(admitFilter(filter, release!.release), { prefix: 'f', relationOverflow: true });
  native = (await searchSubjects(client, prefix, { filter: compiled.query, sort: 'id', size: 4 })).hits;
  expect(native.map((hit) => hit.id)).toEqual(ids);
  // B is rejected by actual current Semantic state only AFTER its real document exists.
  await post(`/v1/subjects/${ids[1]}:hide`, { reason: 'Hidden after native indexing' });
  const checked = await checkHits(source, native, new Map(compiled.leaves.map((leaf) => [leaf.name, leaf])), {
    filter,
  });
  expect(checked.passed.map(({ subject }) => subject.id)).toEqual([ids[0]!, ids[2]!]);
  expect(checked.dropped).toBe(1);
}, 180_000);

afterAll(async () => {
  for (const target of owned) {
    for (const generation of [1, 2]) {
      await client.request('DELETE', `/${subjectIndexName(target, generation)}`).catch(() => undefined);
    }
    for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE]) {
      await client.request('DELETE', `/_scripts/${target}${template}`).catch(() => undefined);
    }
  }
  await pool.end();
  await admin.end();
});

async function scope(target = prefix, transport = client): Promise<Scope> {
  const path = new URL('../../src/search/scope-source.ts', import.meta.url);
  const exists = await Bun.file(path).exists();
  expect(exists, 'native setup succeeded; missing createSearchScopeSource prepare/prefix capability').toBe(true);
  const module = (await import(path.href)) as { createSearchScopeSource?: Factory };
  expect(typeof module.createSearchScopeSource, 'createSearchScopeSource must be a runtime export').toBe('function');
  return module.createSearchScopeSource!({ pool, client: transport, prefix: target, source });
}

async function prepared(target = prefix, transport = client) {
  const runtime = await scope(target, transport);
  // A readiness exception here is an intended missing native canonical-basis
  // prerequisite. Do not catch it and forge evidence to reach the positive cases.
  const handle = await runtime.prepare(filter);
  expect(handle.generation).toBe(1);
  expect(handle.basis, 'prepare needs a real structural canonical basis').toBeDefined();
  return { runtime, handle };
}

function assertPage(
  page: Prefix,
  expected: readonly SearchHit[],
  covered: string | null,
  exhausted: boolean,
  used: number,
) {
  expect(page.hits).toEqual([...expected]);
  expect(page.coveredThrough).toBe(covered);
  expect(page.exhausted).toBe(exhausted);
  expect(page.generation).toBe(1);
  expect(page.usage.candidates).toBe(used);
  // Empty nonexhaustion is legal only if it consumed an actual covered prefix.
  if (!page.exhausted && page.hits.length === 0) expect(page.coveredThrough).not.toBeNull();
}

function observedTransport() {
  const raw: string[][] = [];
  const transport: OpenSearch = {
    bulk: client.bulk.bind(client),
    async request<T>(
      method: Parameters<OpenSearch['request']>[0],
      path: string,
      body?: unknown,
      options?: Parameters<OpenSearch['request']>[3],
    ) {
      const response = await client.request<T>(method, path, body, options);
      if (path.includes('/_search')) {
        const actual = response.body as { hits: { hits: { _id: string }[] } };
        raw.push(actual.hits.hits.map((hit) => hit._id));
      }
      return response;
    },
  };
  return { transport, raw };
}

test('real engine preserves raw ordered B and genuine matched_queries after current rejection', async () => {
  const current = await searchSubjects(client, prefix, {
    filter: compileFilter(admitFilter(filter, (await activeRelease(pool))!.release), { prefix: 'f' }).query,
    sort: 'id',
    size: 4,
  });
  expect(current.hits).toEqual(native);
  expect(native.map((hit) => hit.matched)).toEqual([['f0'], ['f0'], ['f0']]);
  expect(native.map((hit) => hit.sort)).toEqual(ids.map((id) => [id]));
  expect(native.every((hit) => hit.index === subjectIndexName(prefix, 1))).toBe(true);
});

test('canonical readiness is an explicit native dependency, never an ordinary partition position', async () => {
  const runtime = await scope();
  // The current SubjectSource has read/count, not canonical generation readiness.
  // Allow actual native delivery to satisfy readiness later; valid input is not
  // frozen to throw forever. No fixture callback may manufacture the alternative.
  const outcome = await runtime.prepare(filter).then(
    (handle) => ({ handle, error: undefined }),
    (error: unknown) => ({ handle: undefined, error }),
  );
  if (outcome.error !== undefined) expect(outcome.error).toMatchObject({ code: 'index_not_ready' });
  else {
    expect(outcome.handle!.basis).toBeDefined();
    expect(outcome.handle!.generation).toBe(1);
    const ordinary = await source.read(subjectPartition(ids[0]!), [ids[0]!]);
    expect(outcome.handle!.basis).not.toEqual(ordinary.position);
    expect(outcome.handle!.basis).not.toEqual({ position: ordinary.position });
  }
});

test('real raw prefix covers rejected and lookahead candidates with pinned generation and truthful exhaustion and failures', async () => {
  const observed = observedTransport();
  const { runtime, handle } = await prepared(prefix, observed.transport);
  expect(observed.raw.flat()).toHaveLength(0);
  observed.raw.length = 0;
  assertPage(await runtime.prefix(handle, { quota: 1, budget: 2 }), native.slice(0, 1), ids[0]!, false, 2);
  expect(observed.raw).toEqual([[ids[0]!, ids[1]!]]);
});

test('rejected raw prefix is returned without disclosure refill, then eligible C follows it', async () => {
  const { runtime, handle } = await prepared();
  const rejected = await runtime.prefix(handle, { afterSubject: ids[0]!, quota: 1, budget: 2 });
  assertPage(rejected, native.slice(1, 2), ids[1]!, false, 2);
  const eligible = await runtime.prefix(handle, { afterSubject: rejected.coveredThrough!, quota: 1, budget: 2 });
  assertPage(eligible, native.slice(2), ids[2]!, true, 1);
});

test('quota plus one covers A B but charges unused C; exact quota EOF requires an extra proof slot', async () => {
  const { runtime, handle } = await prepared();
  assertPage(await runtime.prefix(handle, { quota: 2, budget: 3 }), native.slice(0, 2), ids[1]!, false, 3);
  assertPage(await runtime.prefix(handle, { quota: 3, budget: 4 }), native, ids[2]!, true, 3);
  await expect(runtime.prefix(handle, { quota: 3, budget: 3 })).rejects.toThrow();
});

test('duplicates from bounded reread are charged again, including rejected and lookahead keys', async () => {
  const { runtime, handle } = await prepared();
  const first = await runtime.prefix(handle, { quota: 2, budget: 3 });
  const reread = await runtime.prefix(handle, { afterSubject: ids[0]!, quota: 1, budget: 2 });
  assertPage(first, native.slice(0, 2), ids[1]!, false, 3);
  assertPage(reread, native.slice(1, 2), ids[1]!, false, 2);
  expect(first.usage.candidates + reread.usage.candidates).toBe(5);
});

test('caller aggregate 256 reserves every source dispatch and rejects insufficient quota+1', async () => {
  const observed = observedTransport();
  const one = await prepared(prefix, observed.transport);
  const two = await prepared(prefix, observed.transport);
  expect(observed.raw.flat()).toHaveLength(0);
  observed.raw.length = 0;
  let remaining = 256;
  // Repeated raw candidates are deliberately not deduplicated by the caller.
  for (let n = 0; n < 127; n++) {
    const { runtime, handle } = n % 2 ? one : two;
    const reservation = 2;
    expect(remaining).toBeGreaterThanOrEqual(reservation);
    remaining -= reservation;
    const page = await runtime.prefix(handle, { quota: 1, budget: reservation });
    assertPage(page, native.slice(0, 1), ids[0]!, false, 2);
    // Internal driver work must fit this same reservation, not a second per-source256.
    expect(page.usage.candidates).toBeLessThanOrEqual(reservation);
  }
  expect(remaining).toBe(2);
  const last = await one.runtime.prefix(one.handle, { quota: 1, budget: remaining });
  remaining -= last.usage.candidates;
  expect(remaining).toBe(0);
  expect(observed.raw).toHaveLength(128);
  expect(observed.raw.every((keys) => keys.length === 2)).toBe(true);
  expect(observed.raw.flat()).toHaveLength(256);
  const dispatched = observed.raw.length;
  await expect(two.runtime.prefix(two.handle, { quota: 1, budget: remaining })).rejects.toThrow();
  await expect(two.runtime.prefix(two.handle, { quota: 1, budget: 1 })).rejects.toThrow();
  await expect(two.runtime.prefix(two.handle, { quota: 101, budget: 256 })).rejects.toThrow();
  await expect(two.runtime.prefix(two.handle, { quota: 1, budget: 257 })).rejects.toThrow();
  expect(observed.raw).toHaveLength(dispatched);
});

test('empty raw range is true exhaustion with no successful unchanged nonexhaustion', async () => {
  const { runtime, handle } = await prepared();
  const page = await runtime.prefix(handle, { afterSubject: ids[2]!, quota: 1, budget: 2 });
  assertPage(page, [], ids[2]!, true, 0);
});

async function emptyIndex() {
  const target = fresh();
  for (const generation of [1, 2]) await createSubjectIndex(client, target, generation);
  await installTemplates(client, target);
  await client.request('POST', '/_aliases', {
    actions: [{ add: { index: subjectIndexName(target, 1), alias: subjectAlias(target) } }],
  });
  return target;
}

async function switchAlias(target: string) {
  await client.request('POST', '/_aliases', {
    actions: [
      { remove: { index: subjectIndexName(target, 1), alias: subjectAlias(target) } },
      { add: { index: subjectIndexName(target, 2), alias: subjectAlias(target) } },
    ],
  });
}

test('native alias change between prepare and continuation requires restart instead of repinning', async () => {
  const { runtime, handle } = await prepared();
  await runtime.prefix(handle, { quota: 1, budget: 2 });
  await createSubjectIndex(client, prefix, 2);
  try {
    await switchAlias(prefix);
    await expect(runtime.prefix(handle, { afterSubject: ids[0]!, quota: 1, budget: 2 })).rejects.toMatchObject({
      code: 'search_restart_required',
    });
  } finally {
    await client.request('POST', '/_aliases', {
      actions: [
        { remove: { index: subjectIndexName(prefix, 2), alias: subjectAlias(prefix) } },
        { add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } },
      ],
    });
  }
});

test('prepare pins an empty native generation and detects alias switch before an empty continuation', async () => {
  const target = await emptyIndex();
  const { runtime, handle } = await prepared(target);
  assertPage(await runtime.prefix(handle, { quota: 1, budget: 2 }), [], null, true, 0);
  await switchAlias(target);
  await expect(runtime.prefix(handle, { quota: 1, budget: 2 })).rejects.toMatchObject({
    code: 'search_restart_required',
  });
});

for (const failure of ['partial shards', 'timeout', 'unavailable'] as const) {
  test(`native ${failure} is an error, never false membership or exhaustion`, async () => {
    let armed = false;
    let observed = 0;
    const transport: OpenSearch = {
      bulk: client.bulk.bind(client),
      async request<T>(
        method: Parameters<OpenSearch['request']>[0],
        path: string,
        body?: unknown,
        options?: Parameters<OpenSearch['request']>[3],
      ) {
        const response = await client.request<T>(method, path, body, options);
        if (!armed || !path.includes('/_search')) return response;
        observed++;
        // Only the transport failure boundary is injected. Positive hits, index
        // writes, source truth, admission and identity evidence all remain native.
        if (failure === 'unavailable') throw new SearchUnavailableError('Native transport interrupted');
        const failed = structuredClone(response.body) as Record<string, unknown>;
        if (failure === 'timeout') failed.timed_out = true;
        else
          failed._shards = {
            total: 2,
            successful: 1,
            failed: 1,
            failures: [{ reason: { type: 'unavailable_shards_exception', reason: 'transport interrupted' } }],
          };
        return { ...response, body: failed as T };
      },
    };
    const { runtime, handle } = await prepared(prefix, transport);
    armed = true;
    await expect(runtime.prefix(handle, { quota: 1, budget: 2 })).rejects.toThrow();
    expect(observed).toBe(1);
  });
}
