import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { SearchDriver, HttpResponse } from '../../../../specs/search-driver.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createDriverClient, type DriverClient } from './support/driver-client.ts';

const clients = new Set<DriverClient>();
function fixture(endpoint = process.env.OPENSEARCH_URL!) {
  const client = createDriverClient(endpoint);
  clients.add(client);
  return client;
}
afterEach(async () => {
  const results = await Promise.allSettled([...clients].map((client) => client.close()));
  clients.clear();
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length) throw new AggregateError(failures, 'Composition fixtures did not drain');
}, 600_000);
const marker = () => `composition${randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
async function write(driver: SearchDriver, path: string, body: unknown, persona: 'editor' | 'acceptor' = 'editor') {
  return driver.request(persona, 'POST', path, body, { 'Idempotency-Key': `"${randomUUID()}"` });
}
async function create(driver: SearchDriver, label: string, type = 'schema:Book', author?: string) {
  const response = await write(driver, '/v1/subjects', {
    type,
    labels: { en: label },
    statements: author
      ? {
          'schema:author': [
            { property: { id: 'schema:author' }, value: { type: 'value', content: author }, rank: 'normal' },
          ],
        }
      : {},
  });
  expect(response.status).toBe(201);
  expect(response.headers).toBeInstanceOf(Headers);
  expect(response.headers.get('rezics-session-token')).toBeTruthy();
  return { id: (response.body.subject as { id: string }).id, session: response.headers.get('rezics-session-token')! };
}
const search = (driver: SearchDriver, text: string, extra: Record<string, unknown> = {}) =>
  driver.request('anonymous', 'POST', '/v1/subjects:search', { text, limit: 20, ...extra });
function ids(response: HttpResponse) {
  expect(response.status).toBe(200);
  return (response.body.subjects as { id: string }[]).map(({ id }) => id).sort();
}
async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  let last: T | undefined;
  do {
    last = await read();
    if (accepts(last)) return last;
    await Bun.sleep(50);
  } while (performance.now() < deadline);
  throw new Error(`Real fixture condition did not converge: ${JSON.stringify(last)}`);
}
async function composition(client: DriverClient) {
  const observation = await client.inspect();
  const stats = observation.workerStats!;
  expect(stats.registeredModules).toEqual(stats.defaultModules);
  for (const name of ['semantic', 'search']) {
    expect(stats.defaultModules.filter((entry) => entry === name)).toHaveLength(1);
    expect(stats.registrationCounts[name]).toBe(1);
    expect(stats.startedServices[name]).toBeGreaterThan(0);
  }
  expect(stats.searchStarterInvocations).toBe(1);
  expect(stats.stopped).toBe(false);
  expect(observation.supervisorPid).not.toBe(process.pid);
  expect(client.ledger().resources.filter(({ kind }) => kind === 'worker_process')).toHaveLength(1);
  return observation;
}
async function gone(client: DriverClient) {
  const ledger = client.ledger();
  expect(ledger.exited).toBe(true);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    for (const resource of ledger.resources) {
      if (resource.kind === 'kernel_database' || resource.kind === 'auth_database') {
        const result = await pool.query('SELECT datname FROM pg_database WHERE datname = $1', [resource.name]);
        expect(result.rows).toEqual([]);
      } else if (resource.kind === 'index_prefix') {
        const response = await fetch(
          `${process.env.OPENSEARCH_URL}/_resolve/index/${resource.name}*?expand_wildcards=all`,
          { signal: AbortSignal.timeout(10_000) },
        );
        expect(response.status).toBe(200);
        expect((await response.json()).indices).toEqual([]);
      } else if (resource.kind === 'worker_process') {
        expect(() => process.kill(resource.pid, 0)).toThrow();
      }
    }
  } finally {
    await pool.end();
  }
}
async function drained(client: DriverClient) {
  const first = client.close();
  expect(client.close()).toBe(first);
  await first;
  clients.delete(client);
  const observation = client.ledger().cleanup!;
  expect(observation.workerStats!.stopped).toBe(true);
  expect(observation.phases).toEqual(['worker', 'auth', 'semantic', 'indices', 'proxy']);
  await gone(client);
}

async function withKernelDatabase<T>(client: DriverClient, read: (pool: Pool) => Promise<T>): Promise<T> {
  const database = client.ledger().resources.find((resource) => resource.kind === 'kernel_database');
  if (!database || database.kind !== 'kernel_database') throw new Error('Missing acknowledged database');
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database.name}`;
  const pool = new Pool({
    connectionString: url.href,
    max: 1,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });
  try {
    return await read(pool);
  } finally {
    await pool.end();
  }
}

test('two concurrent factories isolate real credentials, grants, sessions, cursors and owned resources', async () => {
  const left = fixture();
  const right = fixture();
  const [a, b] = await Promise.all([left.init(), right.init()]);
  const [ao, bo] = await Promise.all([composition(left), composition(right)]);
  expect(ao.authIssuer).not.toBe(bo.authIssuer);
  expect(ao.proxyUrl).not.toBe(bo.proxyUrl);
  expect(ao.resources).not.toEqual(bo.resources);
  const text = marker();
  const [one, two] = await Promise.all([create(a, text), create(b, text)]);
  expect(one.session).not.toBe(two.session);
  expect((await b.request('editor', 'GET', `/v1/subjects/${one.id}`)).status).toBe(404);
  expect((await a.request('suspended', 'GET', `/v1/subjects/${one.id}`)).status).toBe(401);
  expect(
    (
      await a.request(
        'anonymous',
        'POST',
        '/v1/subjects',
        {
          type: 'schema:Book',
          labels: { en: text },
          statements: {},
        },
        { 'Idempotency-Key': `"${randomUUID()}"` },
      )
    ).status,
  ).toBe(401);
  expect((await write(a, '/v1/subjects', { type: 'schema:Book', labels: { en: text }, statements: {} })).status).toBe(
    201,
  );
  await eventually(
    () => search(a, text),
    (response) => ids(response).length === 2,
  );
  await eventually(
    () => search(b, text),
    (response) => ids(response).includes(two.id),
  );
  const page = await search(a, text, { limit: 1 });
  expect(page.body.next).toBeString();
  const foreign = await search(b, text, { limit: 1, cursor: page.body.next });
  expect(foreign.status).toBe(400);
  await drained(left);
  expect(ids(await search(b, text))).toEqual([two.id]);
  const next = await create(b, `${text} still running`);
  await eventually(
    () => search(b, text),
    (response) => ids(response).includes(next.id),
  );
  await drained(right);
}, 600_000);

test('two sequential factories recreate real Auth and default-worker state in the same parent', async () => {
  const first = fixture();
  const a = await first.init();
  const previous = await composition(first);
  const subject = await create(a, marker());
  await drained(first);
  const second = fixture();
  const b = await second.init();
  const current = await composition(second);
  expect(current.resources.find(({ kind }) => kind === 'auth_database')).not.toEqual(
    previous.resources.find(({ kind }) => kind === 'auth_database'),
  );
  expect(current.resources).not.toEqual(previous.resources);
  expect((await b.request('editor', 'GET', `/v1/subjects/${subject.id}`)).status).toBe(404);
  expect((await create(b, marker())).session).not.toBe(subject.session);
  await b.indexing('paused');
  await drained(second);
}, 600_000);

test('Search pause drains its runner while real semantic relation events converge, and resume owns one replacement', async () => {
  const client = fixture();
  const driver = await client.init();
  const before = await composition(client);
  const text = marker();
  const author = await create(driver, `${text} author`, 'schema:Person');
  const book = await create(driver, `${text} book`);
  await eventually(
    () => search(driver, text),
    (response) => ids(response).includes(book.id),
  );
  await driver.indexing('paused');
  const route = routeOf(book.id);
  if (route === null) throw new Error('Book must have a source anchor');
  const partition = partitionOf(route);
  const position = await withKernelDatabase(client, async (pool) => {
    const result = await pool.query<{ position: string }>(
      'SELECT position::text FROM core.partition WHERE partition_no = $1',
      [partition],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!.position;
  });
  const pending = await create(driver, `${text} pending`);
  expect(ids(await search(driver, text))).not.toContain(pending.id);
  const candidate = await write(driver, `/v1/subjects/${book.id}/candidates`, {
    statement: {
      property: { id: 'schema:author' },
      value: { type: 'value', content: author.id },
      rank: 'normal',
      references: [
        { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org' } }] },
      ],
    },
  });
  expect(candidate.status).toBe(201);
  expect(
    (
      await write(
        driver,
        `/v1/subjects/${book.id}/candidates/${candidate.body.candidate}:accept`,
        {
          context: driver.globalContext,
          expected_head: null,
        },
        'acceptor',
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await write(
        driver,
        `/v1/subjects/${book.id}:adopt`,
        {
          context: driver.globalContext,
          property: 'schema:author',
          target: author.id,
          mode: 'replace',
          selection: [{ candidate: candidate.body.candidate, rank: 'normal' }],
          expected_head: null,
        },
        'acceptor',
      )
    ).status,
  ).toBe(200);
  const related = () =>
    search(driver, text, {
      filter: {
        and: [{ type: { in: ['schema:Book'] } }, { statement: { property: 'schema:author', in: [author.id] } }],
      },
    });
  // A newly adopted value cannot enter the stale Search candidate while its runner is paused.
  // Observe Semantic's published witness and its committed SOURCE event instead of running its factory here.
  await withKernelDatabase(client, async (pool) => {
    await eventually(
      async () => {
        const result = await pool.query<{ witness_id: string; changed: boolean }>(
          `SELECT value.witness_id, EXISTS (
             SELECT 1 FROM core.outbox
             WHERE partition_no = $1 AND position > $2::bigint AND position <= $2::bigint + 4096
               AND subject = $3::uuid AND type = 'com.rezics.subject.relation_facet_changed.v1'
             LIMIT 1
           ) AS changed
           FROM semantic.relation_facet_value AS value
           WHERE route = $4 AND subject_id = $3::uuid AND property = $5 AND value.value = $6
           LIMIT 1`,
          [partition, position, book.id, route, 'schema:author', author.id],
        );
        return result.rows;
      },
      (rows) => rows.length === 1 && rows[0]!.witness_id === candidate.body.candidate && rows[0]!.changed,
    );
  });
  expect(ids(await related())).not.toContain(book.id);
  expect(ids(await search(driver, text))).not.toContain(pending.id);
  const paused = await client.inspect();
  expect(paused.workerStats!.startedServices.semantic).toBe(before.workerStats!.startedServices.semantic);
  expect(paused.workerStats!.searchStarterInvocations).toBe(1);
  await driver.indexing('running');
  await driver.indexing('running');
  expect((await client.inspect()).workerStats!.searchStarterInvocations).toBe(2);
  await eventually(related, (response) => ids(response).includes(book.id));
  await eventually(
    () => search(driver, text),
    (response) => ids(response).includes(pending.id),
  );
  await drained(client);
}, 600_000);

test('real node outage preserves semantic reads, native rebuild failures and reconciled generation cursor restart', async () => {
  const client = fixture();
  const driver = await client.init();
  const text = marker();
  const one = await create(driver, text);
  await create(driver, text);
  await eventually(
    () => search(driver, text),
    (response) => ids(response).length === 2,
  );
  const page = await search(driver, text, { limit: 1 });
  expect(page.body.next).toBeString();
  await driver.searchNode('down');
  expect((await driver.request('editor', 'GET', `/v1/subjects/${one.id}`)).status).toBe(200);
  expect((await search(driver, text)).status).toBe(503);
  let native: unknown;
  try {
    await driver.rebuild();
  } catch (error) {
    native = error;
  }
  expect(native).toBeInstanceOf(Error);
  expect((native as Error).name).toBe('SearchUnavailableError');
  expect((native as Error).cause).toBeInstanceOf(Error);
  expect((native as Error).stack).toContain('search');
  expect((native as Error).message).not.toBe('Outcome RPC timed out');
  await driver.searchNode('up');
  await eventually(
    () => search(driver, text),
    (response) => ids(response).length === 2,
  );
  const rebuilt = await driver.rebuild();
  expect(rebuilt.generation).toBeGreaterThan(0);
  const prefix = client.ledger().resources.find((resource) => resource.kind === 'index_prefix');
  if (!prefix || prefix.kind !== 'index_prefix') throw new Error('Missing acknowledged index prefix');
  const alias = await fetch(`${process.env.OPENSEARCH_URL}/_alias/${prefix.name}subjects`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(alias.status).toBe(200);
  expect(Object.keys(await alias.json())).toEqual([`${prefix.name}subjects-g${rebuilt.generation}`]);
  const counts = await fetch(`${process.env.OPENSEARCH_URL}/${prefix.name}subjects-g${rebuilt.generation}/_search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size: 0, aggs: { partitions: { terms: { field: 'partition', size: 4096 } } } }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(counts.status).toBe(200);
  const indexed = new Map<number, number>(
    (await counts.json()).aggregations.partitions.buckets.map((bucket: { key: number; doc_count: number }) => [
      bucket.key,
      bucket.doc_count,
    ]),
  );
  const database = client.ledger().resources.find((resource) => resource.kind === 'kernel_database');
  if (!database || database.kind !== 'kernel_database') throw new Error('Missing acknowledged database');
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${database.name}`;
  const pool = new Pool({ connectionString: url.href, max: 1 });
  try {
    const source = await pool.query<{ partition_no: number; visible: string }>(
      'SELECT partition_no, visible::text FROM semantic.partition_subjects',
    );
    expect(source.rows.length).toBeGreaterThan(0);
    for (const row of source.rows) {
      expect(indexed.get(row.partition_no) ?? 0).toBe(Number(row.visible));
      indexed.delete(row.partition_no);
    }
    expect(indexed.size).toBe(0);
  } finally {
    await pool.end();
  }
  const stale = await search(driver, text, { limit: 1, cursor: page.body.next });
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe('search_restart_required');
  expect(ids(await search(driver, text))).toHaveLength(2);
  await driver.rebuild();
  await expect(driver.rebuild()).rejects.toMatchObject({
    name: 'RebuildError',
    reason: 'limit',
    generation: rebuilt.generation + 2,
    partitions: [],
  });
  await drained(client);
}, 600_000);

test('close during actual initialization waits for setup and completed real drain', async () => {
  const client = fixture();
  const starting = client.init();
  const closing = client.close();
  expect(client.close()).toBe(closing);
  await starting;
  await closing;
  clients.delete(client);
  expect(client.ledger().cleanup!.workerStats!.stopped).toBe(true);
  await gone(client);
}, 600_000);

test('close seals admission and drains already admitted real requests', async () => {
  const client = fixture();
  const driver = await client.init();
  const subject = await create(driver, marker());
  const admitted = driver.request('editor', 'GET', `/v1/subjects/${subject.id}`);
  const closing = client.close();
  expect(client.close()).toBe(closing);
  await expect(driver.indexing('running')).rejects.toThrow('closing');
  expect((await admitted).status).toBe(200);
  await closing;
  clients.delete(client);
  await gone(client);
}, 600_000);

test('failed real startup retains exact ownership and completes cleanup before rejecting', async () => {
  const client = fixture('ftp://127.0.0.1');
  await expect(client.init()).rejects.toThrow('Invalid OpenSearch endpoint');
  clients.delete(client);
  expect(client.ledger().exited).toBe(true);
  expect(client.ledger().resources).toEqual([]);
  await gone(client);
}, 180_000);

test('unexpected owned worker exit rejects controls with diagnostics and never reports a drained close', async () => {
  const client = fixture();
  const driver = await client.init();
  await create(driver, marker());
  const worker = client.ledger().resources.find((resource) => resource.kind === 'worker_process');
  if (!worker || worker.kind !== 'worker_process') throw new Error('Missing acknowledged worker identity');
  process.kill(worker.pid, 'SIGKILL');
  await expect(client.inspect()).rejects.toThrow();
  await expect(client.close()).rejects.toThrow();
  clients.delete(client);
  await gone(client);
}, 600_000);

test('real startup failure after provisioning retains a precise ledger and removes acknowledged state', async () => {
  const client = fixture();
  const starting = client.init().then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  const worker = await eventually(
    async () => client.ledger().resources.find((resource) => resource.kind === 'worker_process'),
    (resource) => resource?.kind === 'worker_process',
    180_000,
  );
  if (!worker || worker.kind !== 'worker_process') throw new Error('Missing acknowledged startup worker');
  process.kill(worker.pid, 'SIGKILL');
  const { error: failure } = await starting;
  expect(failure).toBeInstanceOf(Error);
  clients.delete(client);
  const resources = client.ledger().resources;
  expect(resources.filter(({ kind }) => kind === 'kernel_database')).toHaveLength(1);
  expect(resources.filter(({ kind }) => kind === 'auth_database')).toHaveLength(1);
  expect(resources.filter(({ kind }) => kind === 'worker_process')).toHaveLength(1);
  await gone(client);
}, 600_000);

test('supervisor exit rejects pending IPC and cleans only its acknowledged resources after descendants exit', async () => {
  const client = fixture();
  await client.init();
  await composition(client);
  const pending = client.inspect();
  process.kill(client.ledger().supervisorPid, 'SIGKILL');
  // Either the real reply won the race or the actual transport failure completes this admitted call.
  await Promise.allSettled([pending]);
  await expect(client.inspect()).rejects.toThrow();
  await expect(client.close()).rejects.toThrow();
  clients.delete(client);
  await gone(client);
}, 600_000);
