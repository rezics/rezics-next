import { expect, test } from 'bun:test';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { ProblemError } from '../../src/http/problem.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import type { SubjectDocument } from '../../src/search/document.ts';
import { subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { createSearchService } from '../../src/search/service.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { createOutcomeRpc } from './support/outcome-rpc.ts';
import type { WorkerStats } from './support/outcome-worker.ts';

const databaseUrl = process.env.DATABASE_URL;
const endpoint = process.env.OPENSEARCH_URL;
if (!databaseUrl || !endpoint) throw new Error('The adapter needs migrated DATABASE_URL and real OPENSEARCH_URL');
const routeKey = Buffer.alloc(32, 81);

async function eventually(observe: () => Promise<boolean>) {
  const deadline = Date.now() + 60_000;
  while (!(await observe())) {
    if (Date.now() >= deadline) throw new Error('Real worker did not converge within 60 seconds');
    await Bun.sleep(100);
  }
}

async function checkpointed(pool: pg.Pool, prefix: string, generation: number, subjectId: string) {
  const row = await pool.query<{ position: string }>(
    'SELECT position::text AS position FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2',
    [subjectConsumer(prefix, generation), partitionOf(routeOf(subjectId)!)],
  );
  return row.rows[0] !== undefined && BigInt(row.rows[0].position) > 0n;
}

function childFixture() {
  const identity = `outcome-${randomUUID()}`;
  const url = new URL(databaseUrl!);
  url.searchParams.set('application_name', identity);
  const prefix = `adapter-${randomUUID().slice(0, 8)}-`;
  const env = workerTestEnv({
    DATABASE_URL: url.href,
    OPENSEARCH_URL: endpoint,
    KERNEL_SEARCH_PREFIX: prefix,
    KERNEL_ROUTE_KEY: routeKey.toString('base64url'),
  });
  const child = fork(`${import.meta.dir}/support/outcome-worker.ts`, [], {
    execPath: process.execPath,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', (data) => (output += String(data)));
  child.stderr!.on('data', (data) => (output += String(data)));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    // close follows exit and the closure of both captured output streams.
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const rpc = createOutcomeRpc(
    {
      send(packet) {
        return new Promise<void>((resolve, reject) => {
          child.send(packet as object, (error) => (error ? reject(error) : resolve()));
        });
      },
      subscribe(message, failure) {
        const disconnect = () => failure(new Error('Worker IPC disconnected'));
        const exit = () => failure(new Error(`Worker exited: ${output}`));
        child.on('message', message);
        child.on('error', failure);
        child.on('disconnect', disconnect);
        child.on('exit', exit);
        return () => {
          child.off('message', message);
          child.off('error', failure);
          child.off('disconnect', disconnect);
          child.off('exit', exit);
        };
      },
    },
    {
      onRequest: () => {
        throw new Error('Child cannot control its parent');
      },
      timeoutMs: 90_000,
    },
  );
  let closed = false;
  async function finish() {
    // A watchdog makes failure finite; forced termination can never pass this assertion.
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      child.kill('SIGKILL');
    }, 90_000);
    try {
      const result = await exited;
      expect({ ...result, forced }, output).toEqual({ code: 0, signal: null, forced: false });
      expect(output).not.toMatch(/Cannot use a pool after calling end|pool.*closed|shutdown failed/i);
    } finally {
      clearTimeout(timer);
      rpc.close();
    }
  }
  return {
    env,
    prefix,
    identity,
    rpc,
    init: (overrides = {}) => rpc.request<WorkerStats>('init', { env: { ...env, ...overrides } }),
    async close() {
      if (closed) return;
      closed = true;
      try {
        const stats = await rpc.request<WorkerStats>('close');
        expect(stats.stopped).toBe(true);
        await expect(rpc.request('stats')).rejects.toThrow('closing');
      } finally {
        if (child.connected) child.disconnect();
        await finish();
      }
    },
    async disconnect() {
      closed = true;
      child.disconnect();
      await finish();
    },
  };
}

function assertDefaults(stats: WorkerStats) {
  expect(stats.registeredModules).toEqual(stats.defaultModules);
  expect(stats.registeredModules).toContain('search');
  expect(stats.registeredModules).toContain('semantic');
  expect(stats.registrationCounts).toEqual(Object.fromEntries(stats.defaultModules.map((name) => [name, 1])));
  expect(stats.startedServices.search).toBeGreaterThan(stats.searchStarterInvocations);
  expect(stats.startedServices.semantic).toBeGreaterThan(0);
  expect(stats.searchStarterInvocations).toBe(1);
  expect(stats.stopped).toBe(false);
  expect(JSON.stringify(stats)).not.toContain(routeKey.toString('base64url'));
}

async function isolated<T>(operation: (fixture: ReturnType<typeof childFixture>, pool: pg.Pool) => Promise<T>) {
  const fixture = childFixture();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const search = createOpenSearch(endpoint!);
  try {
    return await operation(fixture, pool);
  } finally {
    try {
      await fixture.close();
      const sessions = await pool.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [
        fixture.identity,
      ]);
      expect(sessions.rows).toHaveLength(0);
    } finally {
      try {
        const state = await subjectGenerations(search, fixture.prefix);
        for (const generation of state.generations)
          await search.request('DELETE', `/${subjectIndexName(fixture.prefix, generation)}`);
      } finally {
        await pool.end();
      }
    }
  }
}

test('real default registrations and starters run once; invalid and duplicate controls are rejected', async () => {
  await isolated(async (fixture) => {
    await expect(fixture.rpc.request('stats')).rejects.toThrow('initialized');
    await expect(fixture.rpc.request('unknown')).rejects.toThrow('Unknown');
    await expect(fixture.rpc.request('init', { env: { DATABASE_URL: 3 } })).rejects.toThrow('env');
    assertDefaults(await fixture.init());
    await expect(fixture.init()).rejects.toThrow('already');
    await expect(fixture.rpc.request('indexing', { state: 'fast' })).rejects.toThrow('state');
    await expect(fixture.rpc.request('stats', { extra: true })).rejects.toThrow('parameters');
    await fixture.rpc.request('indexing', { state: 'running' });
    assertDefaults(await fixture.rpc.request<WorkerStats>('stats'));
  });
}, 180_000);

test('only search pauses: real semantic witnesses and source events converge, then one replacement catches up and rebuild switches the alias', async () => {
  await isolated(async (fixture, pool) => {
    assertDefaults(await fixture.init());
    const actions = ['subject:create', 'subject:read', 'statement:propose', 'context:accept', 'context:adopt'];
    const access = await createRealAccess(pool, { editor: newId(30000) }, actions);
    for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
    const release = structuredClone(bundledRelease);
    release.catalogue = { id: 'https://example.test/outcome-adapter', version: '1' };
    release.types['schema:Book']!.facets = ['schema:author'];
    release.filters = {};
    await bootstrapRelease(pool, release);
    const kernel = createKernel({ pool, routeKey, access: access.access, writeRate: access.writeRate });
    async function post(path: string, body: unknown) {
      const response = await kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${access.bearer('editor')}`,
            'content-type': 'application/json',
            'idempotency-key': `"${randomUUID()}"`,
          },
          body: JSON.stringify(body),
        }),
      );
      const value = (await response.json()) as any;
      expect(response.status, JSON.stringify(value)).toBe(
        path.endsWith('/subjects') || path.endsWith('/candidates') ? 201 : 200,
      );
      return value;
    }
    const target = (await post('/v1/subjects', { type: 'schema:Person', labels: { en: 'Live author' } })).subject
      .id as string;
    const book = (await post('/v1/subjects', { type: 'schema:Book', labels: { en: 'Paused search book' } })).subject
      .id as string;
    const other = (await post('/v1/subjects', { type: 'schema:Book', labels: { en: 'Paused search other' } })).subject
      .id as string;
    const search = createOpenSearch(endpoint!);
    async function indexed(id: string) {
      const { body } = await search.request<{
        hits: { hits: { _id: string; _source: SubjectDocument }[] };
      }>('POST', `/${subjectAlias(fixture.prefix)}/_search`, { query: { ids: { values: [id] } } });
      return body.hits.hits;
    }
    await eventually(async () => {
      const books = await Promise.all([indexed(book), indexed(other)]);
      return books[0]!.some((hit) => hit._id === book) && books[1]!.some((hit) => hit._id === other);
    });
    const generation = (await subjectGenerations(search, fixture.prefix)).active;
    if (generation === null) throw new Error('Active generation is missing after real indexing');
    await eventually(async () => checkpointed(pool, fixture.prefix, generation, book));
    await fixture.rpc.request('indexing', { state: 'paused' });
    await fixture.rpc.request('indexing', { state: 'paused' });
    await expect(fixture.rpc.request('rebuild')).rejects.toThrow('paused');
    const candidate = (
      await post(`/v1/subjects/${book}/candidates`, {
        statement: {
          property: { id: 'schema:author' },
          value: { type: 'value', content: target },
          qualifiers: [],
          references: [
            {
              parts: [
                { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/evidence' } },
              ],
            },
          ],
        },
      })
    ).candidate as string;
    await post(`/v1/subjects/${book}/candidates/${candidate}:accept`, { context: GLOBAL_CONTEXT, expected_head: null });
    const before = await pool.query('SELECT count(*)::int AS n FROM core.outbox WHERE type=$1 AND subject=$2', [
      'com.rezics.subject.relation_facet_changed.v1',
      book,
    ]);
    await post(`/v1/subjects/${book}:adopt`, {
      context: GLOBAL_CONTEXT,
      property: 'schema:author',
      target,
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: null,
    });
    const source = subjectSource(pool, routeKey);
    await eventually(async () => {
      const hint = await pool.query(
        'SELECT witness_id FROM semantic.relation_facet_value WHERE route=$1 AND subject_id=$2 AND property=$3 AND value=$4',
        [routeOf(book), book, 'schema:author', target],
      );
      const events = await pool.query('SELECT count(*)::int AS n FROM core.outbox WHERE type=$1 AND subject=$2', [
        'com.rezics.subject.relation_facet_changed.v1',
        book,
      ]);
      const snapshot = await source.read(partitionOf(routeOf(book)!), [book]);
      return (
        hint.rows[0]?.witness_id === candidate &&
        events.rows[0].n > before.rows[0].n &&
        snapshot.subjects[0]?.statements.some((row) => row.property === 'schema:author' && row.value === target) ===
          true
      );
    });
    expect((await indexed(book))[0]!._source.statements).not.toContain(`schema:author=${target}`);
    const paused = await fixture.rpc.request<WorkerStats>('stats');
    expect(paused.searchStarterInvocations).toBe(1);
    await fixture.rpc.request('indexing', { state: 'running' });
    await fixture.rpc.request('indexing', { state: 'running' });
    await eventually(async () => {
      const hits = await indexed(book);
      return hits.some((hit) => hit._id === book && hit._source.statements.includes(`schema:author=${target}`));
    });
    const resumed = await fixture.rpc.request<WorkerStats>('stats');
    expect(resumed.searchStarterInvocations).toBe(2);
    expect(resumed.registeredModules).toEqual(paused.registeredModules);
    expect(resumed.registrationCounts).toEqual(paused.registrationCounts);
    expect(resumed.startedServices).toEqual({ ...paused.startedServices, search: 2 });
    const reader = createSearchService({
      pool,
      client: search,
      prefix: fixture.prefix,
      source,
      cursors: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) },
    });
    const page = await reader.search('anonymous', { sort: 'id', limit: 1 });
    expect(page.subjects).toHaveLength(1);
    expect(page.next).toBeString();
    const cursor = page.next!;
    const old = await subjectGenerations(search, fixture.prefix);
    const rebuilt = await fixture.rpc.request<{ generation: number }>('rebuild');
    expect(rebuilt.generation).not.toBe(old.active);
    expect((await subjectGenerations(search, fixture.prefix)).active).toBe(rebuilt.generation);
    const alias = await search.request<Record<string, unknown>>('GET', `/_alias/${subjectAlias(fixture.prefix)}`);
    expect(Object.keys(alias.body)).toEqual([subjectIndexName(fixture.prefix, rebuilt.generation)]);
    await eventually(async () => checkpointed(pool, fixture.prefix, rebuilt.generation, book));
    const stale = await reader.search('anonymous', { sort: 'id', limit: 1, cursor }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(stale).toBeInstanceOf(ProblemError);
    expect((stale as ProblemError).code).toBe('search_restart_required');
    const restarted = await reader.search('anonymous', { sort: 'id', limit: 1 });
    expect(restarted.subjects).toHaveLength(1);
    expect(restarted.next).toBeString();
  });
}, 240_000);

test('genuine rebuild lock failure keeps native reason, generation and partitions across IPC', async () => {
  await isolated(async (fixture, pool) => {
    assertDefaults(await fixture.init());
    const search = createOpenSearch(endpoint!);
    const state = await subjectGenerations(search, fixture.prefix);
    const lock = await pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended('search-rebuild:' || $1,0))", [
        subjectAlias(fixture.prefix),
      ]);
      let failure: unknown;
      try {
        await fixture.rpc.request('rebuild');
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        name: 'RebuildError',
        reason: 'running',
        generation: state.generations.at(-1),
        partitions: [],
      });
      expect((failure as Error).stack).toContain('generations.ts');
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended('search-rebuild:' || $1,0))", [
        subjectAlias(fixture.prefix),
      ]);
      lock.release();
    }
  });
}, 180_000);

for (const state of ['running', 'paused'] as const) {
  test(`real worker shutdown drains while search is ${state} and leaves no child or database sessions`, async () => {
    await isolated(async (fixture) => {
      assertDefaults(await fixture.init());
      await fixture.rpc.request('indexing', { state });
      await fixture.close();
    });
  }, 180_000);
}

test('parent disconnect drains the real owned worker before child exit', async () => {
  await isolated(async (fixture) => {
    assertDefaults(await fixture.init());
    await fixture.disconnect();
  });
}, 180_000);

test('invalid startup configuration rejects init, never reports ready, and still closes', async () => {
  await isolated(async (fixture) => {
    await expect(fixture.init({ KERNEL_WORKER_POOL_SIZE: '0' })).rejects.toThrow('KERNEL_WORKER_POOL_SIZE');
    await expect(fixture.rpc.request('stats')).rejects.toThrow('initialized');
    await expect(fixture.init()).rejects.toThrow('already');
  });
}, 180_000);

test('one real worker fixture drains without stopping another owned worker', async () => {
  const first = childFixture();
  const second = childFixture();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const search = createOpenSearch(endpoint!);
  try {
    assertDefaults(await first.init());
    assertDefaults(await second.init());
    await first.close();
    expect(
      (await pool.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [first.identity])).rows,
    ).toHaveLength(0);
    assertDefaults(await second.rpc.request<WorkerStats>('stats'));
    await second.close();
    expect(
      (await pool.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [second.identity])).rows,
    ).toHaveLength(0);
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
    try {
      for (const fixture of [first, second]) {
        const state = await subjectGenerations(search, fixture.prefix);
        for (const generation of state.generations)
          await search.request('DELETE', `/${subjectIndexName(fixture.prefix, generation)}`);
      }
    } finally {
      await pool.end();
    }
  }
}, 240_000);
