import { expect, test } from 'bun:test';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { subjectAlias } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createOutcomeRpc } from './support/outcome-rpc.ts';
import type {
  SupervisorObservation,
  SupervisorReady,
  WireResponse,
  OwnedResource,
} from './support/outcome-supervisor.ts';

const endpoint = process.env.OPENSEARCH_URL;
const database = process.env.DATABASE_URL;
if (!endpoint || !database) throw new Error('Real migrated DATABASE_URL and OPENSEARCH_URL are required');

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 60_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Owned resources did not converge within 60 seconds');
    await Bun.sleep(100);
  }
}

async function fixture() {
  const url = new URL(database!);
  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.href, max: 1 });
  const owned: OwnedResource[] = [];
  const child = fork(`${import.meta.dir}/support/outcome-supervisor.ts`, [], {
    execPath: process.execPath,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', (chunk) => (output = (output + String(chunk)).slice(-65_536)));
  child.stderr!.on('data', (chunk) => (output = (output + String(chunk)).slice(-65_536)));
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const rpc = createOutcomeRpc(
    {
      send: (packet) =>
        new Promise<void>((resolve, reject) => {
          child.send(packet as object, (error) => (error ? reject(error) : resolve()));
        }),
      subscribe(message, failure) {
        const disconnect = () => failure(new Error(`Supervisor disconnected: ${output}`));
        child.on('message', message);
        child.on('error', failure);
        child.on('disconnect', disconnect);
        return () => {
          child.off('message', message);
          child.off('error', failure);
          child.off('disconnect', disconnect);
        };
      },
    },
    {
      timeoutMs: 120_000,
      async onRequest(method, params) {
        expect(method).toBe('owned-resource');
        const resource = params as OwnedResource;
        if (resource.kind === 'kernel_database' || resource.kind === 'auth_database') {
          const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [resource.name]);
          expect(existing.rows).toEqual([]); // The ACK completes before CREATE DATABASE.
        }
        if (resource.kind === 'index_prefix') {
          const indices = await createOpenSearch(endpoint!).request<{ indices: unknown[] }>(
            'GET',
            `/_resolve/index/${resource.name}*`,
          );
          expect(indices.body.indices).toEqual([]);
        }
        owned.push(resource);
        return { acknowledged: true };
      },
    },
  );
  let completed: Promise<void> | undefined;
  let observation: SupervisorObservation | undefined;
  async function gone() {
    expect(() => process.kill(child.pid!, 0)).toThrow();
    for (const resource of owned) {
      if (resource.kind === 'kernel_database' || resource.kind === 'auth_database') {
        expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [resource.name])).rows).toEqual([]);
      } else if (resource.kind === 'worker_process') {
        expect(() => process.kill(resource.pid, 0)).toThrow();
      } else {
        const result = await createOpenSearch(endpoint!).request<{ indices: unknown[] }>(
          'GET',
          `/_resolve/index/${resource.name}*`,
        );
        expect(result.body.indices).toEqual([]);
      }
    }
    if (observation?.proxyUrl) await expect(fetch(observation.proxyUrl)).rejects.toThrow();
    if (observation?.authIssuer) await expect(fetch(observation.authIssuer)).rejects.toThrow();
  }
  function finish(disconnect = false, failedWorker = false) {
    return (completed ??= (async () => {
      let forced = false;
      const timer = setTimeout(() => {
        forced = true;
        child.kill('SIGKILL');
      }, 120_000);
      try {
        if (!disconnect) {
          const closing = rpc.request<SupervisorObservation>('close');
          if (failedWorker) await expect(closing).rejects.toThrow();
          else {
            observation = await closing;
            expect(await rpc.request('close')).toEqual(observation);
            await expect(rpc.request('indexing', { state: 'running' })).rejects.toThrow('closing');
          }
        }
        if (child.connected) child.disconnect();
        const result = await exit;
        expect(forced, output).toBe(false);
        expect(result.signal, output).toBeNull();
        if (!failedWorker) expect(result.code, output).toBe(0);
        await gone();
      } finally {
        clearTimeout(timer);
        rpc.close();
        await admin.end();
      }
    })());
  }
  return {
    child,
    rpc,
    owned,
    finish,
    init: async () => {
      const ready = await rpc.request<SupervisorReady>('init', { endpoint });
      observation = await rpc.request<SupervisorObservation>('inspect');
      return ready;
    },
  };
}

async function isolated(run: (f: Awaited<ReturnType<typeof fixture>>, ready: SupervisorReady) => Promise<void>) {
  const f = await fixture();
  try {
    await run(f, await f.init());
  } finally {
    await f.finish();
  }
}

function defaults(ready: SupervisorReady) {
  const stats = ready.workerStats;
  expect(stats.registeredModules).toEqual(stats.defaultModules);
  expect(stats.defaultModules).toContain('semantic');
  expect(stats.registrationCounts).toEqual(Object.fromEntries(stats.defaultModules.map((name) => [name, 1])));
  expect(stats.startedServices.semantic).toBeGreaterThan(0);
  expect(stats.searchStarterInvocations).toBe(1);
}

async function post(f: Awaited<ReturnType<typeof fixture>>, path: string, body: unknown, persona = 'editor') {
  const response = await f.rpc.request<WireResponse>('request', {
    persona,
    method: 'POST',
    path,
    body,
    headers: { 'Idempotency-Key': `"${randomUUID()}"` },
  });
  expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(200);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return response.body;
}

test('supervisor validates controls and shares close before allocation', async () => {
  const f = await fixture();
  try {
    await expect(f.rpc.request('init', { endpoint: 42 })).rejects.toThrow();
    await expect(f.rpc.request('request', {})).rejects.toThrow();
    await expect(f.rpc.request('unknown')).rejects.toThrow();
    expect(f.owned).toEqual([]);
  } finally {
    await f.finish();
  }
}, 180_000);

test('actual HTTP retains status, JSON, header pairs and persona sessions; suspended writes are denied', async () => {
  await isolated(async (f, ready) => {
    defaults(ready);
    expect(f.owned.filter((r) => r.kind.endsWith('database'))).toHaveLength(2);
    expect(f.owned.filter((r) => r.kind === 'worker_process')).toHaveLength(1);
    await expect(f.init()).rejects.toThrow('already');
    const request = { persona: 'editor', method: 'GET', path: '/v1/definitions/active' };
    const first = await f.rpc.request<WireResponse>('request', request);
    expect(first.status).toBe(200);
    expect(first.body).toBeObject();
    expect(first.headers.every((pair) => pair.length === 2)).toBe(true);
    expect(new Headers(first.headers).get('content-type')).toContain('application/json');
    const written = await f.rpc.request<WireResponse>('request', {
      persona: 'editor',
      method: 'POST',
      path: '/v1/subjects',
      body: { type: 'schema:Person', labels: { en: 'Session writer' } },
      headers: { 'Idempotency-Key': `"${randomUUID()}"` },
    });
    expect(written.status).toBe(201);
    expect(new Headers(written.headers).get('rezics-session-token')).toBeTruthy();
    expect((await f.rpc.request<WireResponse>('request', request)).status).toBe(200);
    const denied = await f.rpc.request<WireResponse>('request', {
      persona: 'suspended',
      method: 'POST',
      path: '/v1/subjects',
      body: { type: 'schema:Person', labels: { en: 'Denied' } },
      headers: { 'Idempotency-Key': `"${randomUUID()}"` },
    });
    expect(denied.status).toBe(403);
    await expect(f.rpc.request('indexing', { state: 'invalid' })).rejects.toThrow();
    await expect(f.rpc.request('searchNode', { state: 'invalid' })).rejects.toThrow();
    await expect(f.rpc.request('remove', { subjectId: 'x', mode: 'invalid' })).rejects.toThrow();
    await expect(f.rpc.request('rebuild', {})).rejects.toThrow();
  });
}, 240_000);

test('Search pause leaves real semantic relation work alive; resume replaces only Search and rebuild uses the child', async () => {
  await isolated(async (f, ready) => {
    defaults(ready);
    const target = (
      (await post(f, '/v1/subjects', { type: 'schema:Person', labels: { en: 'Writer' } })).subject as { id: string }
    ).id;
    const book = (
      (await post(f, '/v1/subjects', { type: 'schema:Book', labels: { en: 'Book' } })).subject as { id: string }
    ).id;
    const search = createOpenSearch(endpoint!);
    const indexed = async () => {
      const { body } = await search.request<{ hits: { hits: { _id: string; _source: { statements: string[] } }[] } }>(
        'POST',
        `/${subjectAlias(ready.indexPrefix)}/_search`,
        { query: { ids: { values: [book] } } },
      );
      return body.hits.hits;
    };
    await eventually(async () => (await indexed()).some((hit) => hit._id === book));
    await f.rpc.request('indexing', { state: 'paused' });
    await expect(f.rpc.request('rebuild')).rejects.toThrow('paused');
    const candidate = (
      await post(f, `/v1/subjects/${book}/candidates`, {
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
    await post(
      f,
      `/v1/subjects/${book}/candidates/${candidate}:accept`,
      { context: ready.globalContext, expected_head: null },
      'acceptor',
    );
    await post(
      f,
      `/v1/subjects/${book}:adopt`,
      {
        context: ready.globalContext,
        property: 'schema:author',
        target,
        mode: 'replace',
        selection: [{ candidate, rank: 'normal' }],
        expected_head: null,
      },
      'acceptor',
    );
    const name = f.owned.find((r) => r.kind === 'kernel_database')!;
    const url = new URL(database!);
    url.pathname = `/${'name' in name ? name.name : ''}`;
    const pool = new Pool({ connectionString: url.href, max: 1 });
    try {
      await eventually(
        async () =>
          (
            await pool.query('SELECT 1 FROM semantic.relation_facet_value WHERE subject_id=$1 AND witness_id=$2', [
              book,
              candidate,
            ])
          ).rowCount === 1,
      );
    } finally {
      await pool.end();
    }
    expect((await indexed())[0]!._source.statements).not.toContain(`schema:author=${target}`);
    await f.rpc.request('indexing', { state: 'running' });
    await f.rpc.request('indexing', { state: 'running' });
    await eventually(async () =>
      (await indexed()).some((hit) => hit._source.statements.includes(`schema:author=${target}`)),
    );
    const stats = (await f.rpc.request<SupervisorObservation>('inspect')).workerStats!;
    expect(stats.searchStarterInvocations).toBe(2);
    expect(stats.registrationCounts).toEqual(ready.workerStats.registrationCounts);
    expect(stats.startedServices).toEqual({ ...ready.workerStats.startedServices, search: 2 });
    const rebuilt = await f.rpc.request<{ generation: number }>('rebuild');
    expect(rebuilt.generation).toBeGreaterThan(0);
    await f.rpc.request('remove', { subjectId: book, mode: 'hidden' });
  });
}, 240_000);

test('real proxy outage returns the native retryable problem while semantic HTTP remains live and recovers', async () => {
  await isolated(async (f) => {
    const query = { persona: 'anonymous', method: 'POST', path: '/v1/subjects:search', body: { text: 'writer' } };
    await eventually(async () => (await f.rpc.request<WireResponse>('request', query)).status === 200);
    await f.rpc.request('searchNode', { state: 'down' });
    const unavailable = await f.rpc.request<WireResponse>('request', query);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ code: 'index_not_ready', retryable: true });
    expect(new Headers(unavailable.headers).get('retry-after')).toBeTruthy();
    expect(
      (
        await f.rpc.request<WireResponse>('request', {
          persona: 'anonymous',
          method: 'GET',
          path: '/v1/definitions/active',
        })
      ).status,
    ).toBe(200);
    await f.rpc.request('searchNode', { state: 'up' });
    await eventually(async () => (await f.rpc.request<WireResponse>('request', query)).status === 200);
  });
}, 240_000);

for (const state of ['running', 'paused'] as const) {
  test(`close drains actual worker while ${state}, including a replacement runner and proxy outage`, async () => {
    await isolated(async (f) => {
      await f.rpc.request('indexing', { state: 'paused' });
      await f.rpc.request('indexing', { state: 'running' });
      await f.rpc.request('indexing', { state });
      await f.rpc.request('searchNode', { state: 'down' });
      const pending = f.rpc.request('request', { persona: 'anonymous', method: 'GET', path: '/v1/definitions/active' });
      const closing = f.rpc.request<SupervisorObservation>('close');
      const repeated = f.rpc.request<SupervisorObservation>('close');
      expect(((await pending) as WireResponse).status).toBe(200);
      const closed = await closing;
      expect(await repeated).toEqual(closed);
      expect(closed.phases).toEqual(['worker', 'auth', 'semantic', 'indices', 'proxy']);
      expect(closed.workerStats?.stopped).toBe(true);
    });
  }, 240_000);
}

test('worker startup failure releases every acknowledged resource and reports the original failure', async () => {
  const f = await fixture();
  try {
    await expect(f.rpc.request('init', { endpoint: 'http://127.0.0.1:1' })).rejects.toThrow();
    expect(f.owned.some((r) => r.kind === 'kernel_database')).toBe(true);
  } finally {
    await f.finish(false, true);
  }
}, 240_000);

test('parent disconnect drains its owned child and removes exact resources', async () => {
  const f = await fixture();
  try {
    defaults(await f.init());
  } finally {
    await f.finish(true);
  }
}, 240_000);

test('abrupt worker exit is a cleanup failure and state is removed only after confirmed exit', async () => {
  const f = await fixture();
  let killed = false;
  try {
    await f.init();
    const worker = f.owned.find((r) => r.kind === 'worker_process');
    if (!worker || worker.kind !== 'worker_process') throw new Error('Missing worker identity');
    process.kill(worker.pid, 'SIGKILL');
    killed = true;
    await eventually(async () => {
      try {
        process.kill(worker.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    await f.finish(false, killed);
  }
}, 240_000);

test('concurrent factories own disjoint resources and one closing leaves the other alive; a later factory is independent', async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const results = await Promise.allSettled([first.init(), second.init()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const a = (results[0] as PromiseFulfilledResult<SupervisorReady>).value;
    const b = (results[1] as PromiseFulfilledResult<SupervisorReady>).value;
    defaults(a);
    defaults(b);
    expect(a.indexPrefix).not.toBe(b.indexPrefix);
    expect(first.owned).not.toEqual(second.owned);
    await first.finish();
    const response = await second.rpc.request<WireResponse>('request', {
      persona: 'editor',
      method: 'GET',
      path: '/v1/definitions/active',
    });
    expect(response.status).toBe(200);
    expect((await second.rpc.request<SupervisorObservation>('inspect')).workerStats?.stopped).toBe(false);
  } finally {
    await Promise.all([first.finish(), second.finish()]);
  }
  await isolated(async (_f, ready) => defaults(ready));
}, 360_000);
