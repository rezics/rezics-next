import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createCoverageStore } from '../../src/search/coverage-store.ts';
import { readSubjectCoverage, type IndexIncarnation } from '../../src/search/coverage.ts';
import { readFreshness } from '../../src/search/freshness.ts';
import { subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { searchSubjects } from '../../src/search/query.ts';
import { createCoverageFixture } from './coverage-fixture.ts';
import { createDriverClient, type DriverClient } from './support/driver-client.ts';

// Run the existing real command/source/engine baseline before requiring missing coverage composition.
// This file never calls population/coordinator helpers or starts a second producer.
let f: Awaited<ReturnType<typeof createCoverageFixture>>;
beforeAll(async () => {
  f = await createCoverageFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 180_000);

async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    if (Date.now() >= deadline) throw new Error('Actual default-worker observation did not converge');
    await Bun.sleep(50); // Scheduling only; the observation proves completion.
  }
}

async function checkpoints(pool: pg.Pool, consumer: string) {
  return (
    await pool.query<{ partition_no: number; epoch: number | null; position: string }>(
      `SELECT partition_no, epoch, position::text FROM core.consumer_checkpoint
       WHERE consumer=$1 ORDER BY partition_no`,
      [consumer],
    )
  ).rows;
}

async function certified(pool: pg.Pool, search: OpenSearch, incarnation: IndexIncarnation) {
  const store = createCoverageStore(pool);
  const { prefix, generation, index, uuid, consumer } = incarnation;
  expect(index).toBe(subjectIndexName(prefix, generation));
  expect(consumer).toBe(subjectConsumer(prefix, generation));
  expect(incarnation.protocol).toBe('subject-coverage-v1');
  const settings = await search.request<Record<string, { settings: { index: { uuid: string } } }>>(
    'GET',
    `/${index}/_settings`,
  );
  expect(settings.body[index]!.settings.index.uuid).toBe(uuid);
  expect((await subjectGenerations(search, prefix)).active).toBe(generation);
  expect((await store.readPrefix(prefix))!.issuedGeneration).toBeGreaterThanOrEqual(generation);
  const lineage = (await store.readLineage(incarnation))!;
  expect(lineage).toMatchObject({ incarnation, state: 'live', complete: true, after: null });
  expect(['created-empty', 'replay']).toContain(lineage.origin); // No imported/direct-bulk adoption or audit origin.
  expect(lineage.partition).toBe(4096);
  const progress = await checkpoints(pool, consumer);
  // Observe every fixed home, including empty homes; cardinality is never the certificate.
  for (let partition = 0; partition < 4096; partition++) {
    const home = (await store.readHome(incarnation, partition))!;
    expect(home).not.toBeNull();
    expect(home.incarnation).toEqual(incarnation);
    expect(home.current).not.toBeNull();
    expect(home.verified).toEqual(home.current);
    expect(home.fence).not.toBeNull();
    expect(home.current!.partition).toBe(partition);
    expect(home.current!.generation).toBe(home.fence!.generation);
    expect(home.coveredThrough).not.toBeNull();
    expect(home.coveredThrough!.epoch).toBe(home.fence!.epoch);
    expect(home.coveredThrough!.position).toBeGreaterThanOrEqual(home.fence!.position);
    if (home.attempt !== null) {
      expect(home.attempt.outcome).toBe('completed');
      expect(['advanced', 'lost', 'stopped']).toContain(home.attempt.checkpoint);
    }
    const checkpoint = progress.find((row) => row.partition_no === partition);
    if (home.attempt !== null && home.attempt.checkpoint === 'advanced' && home.attempt.through.position > 0n) {
      expect(checkpoint).toBeDefined();
      expect(checkpoint!.epoch).toBe(home.attempt.through.epoch);
      expect(BigInt(checkpoint!.position)).toBeGreaterThanOrEqual(home.attempt.through.position);
    }
  }
}

async function reconciled(pool: pg.Pool, search: OpenSearch, incarnation: IndexIncarnation) {
  const counts = await search.request<{
    timed_out: boolean;
    _shards: { failed: number };
    aggregations: { partitions: { buckets: { key: number; doc_count: number }[] } };
  }>('POST', `/${incarnation.index}/_search`, {
    size: 0,
    aggs: { partitions: { terms: { field: 'partition', size: 4096 } } },
  });
  expect(counts.body.timed_out).toBe(false);
  expect(counts.body._shards.failed).toBe(0);
  const indexed = new Map(counts.body.aggregations.partitions.buckets.map((row) => [row.key, row.doc_count]));
  const source = await pool.query<{ partition_no: number; visible: string }>(
    'SELECT partition_no, visible::text FROM semantic.partition_subjects ORDER BY partition_no',
  );
  for (const row of source.rows) {
    expect(indexed.get(row.partition_no) ?? 0).toBe(Number(row.visible));
    indexed.delete(row.partition_no);
  }
  expect(indexed.size).toBe(0);
  expect((await readFreshness(pool, incarnation.consumer)).behind).toBe(0);
}

async function gone(client: DriverClient) {
  const ledger = client.ledger();
  expect(ledger.exited).toBe(true); // Includes stream EOF, after worker drain and pool shutdown.
  expect(ledger.exit).toEqual({ code: 0, signal: null });
  expect(ledger.cleanup!.workerStats!.stopped).toBe(true);
  expect(ledger.cleanup!.phases).toEqual(['worker', 'auth', 'semantic', 'indices', 'proxy']);
  expect(ledger.stderr).not.toMatch(/pool.*(?:closed|end)|(?:closed|end).*pool|shutdown failed/i);
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    for (const resource of ledger.resources) {
      if (resource.kind === 'kernel_database' || resource.kind === 'auth_database') {
        expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [resource.name])).rows).toEqual(
          [],
        );
      } else if (resource.kind === 'index_prefix') {
        const result = await f.search.request<{ indices: { name: string }[] }>(
          'GET',
          `/_resolve/index/${resource.name}*`,
          undefined,
          { query: { expand_wildcards: 'all' } },
        );
        expect(result.body.indices).toEqual([]);
      } else if (resource.kind === 'worker_process') {
        expect(() => process.kill(resource.pid, 0)).toThrow();
      }
    }
  } finally {
    await admin.end();
  }
}

test('real default lifecycle certifies its own worker population before pause and ordinary lag', async () => {
  const client = createDriverClient();
  let pool: pg.Pool | undefined;
  try {
    const driver = await client.init();
    const observation = await client.inspect();
    expect(observation.workerStats!.registeredModules).toEqual(observation.workerStats!.defaultModules);
    expect(observation.workerStats!.registrationCounts.search).toBe(1);
    const database = client.ledger().resources.find((resource) => resource.kind === 'kernel_database');
    const target = client.ledger().resources.find((resource) => resource.kind === 'index_prefix');
    if (!database || database.kind !== 'kernel_database' || !target || target.kind !== 'index_prefix')
      throw new Error('Missing actual default lifecycle ownership');
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${database.name}`;
    pool = new pg.Pool({ connectionString: url.href });
    const search = createOpenSearch(process.env.OPENSEARCH_URL!);
    const config = { pool, search, prefix: target.name };
    // init is a readiness boundary: the worker must already own a certified fresh physical target.
    const initial = await readSubjectCoverage(config, { deadline: Date.now() + 30_000 });
    expect(initial.state).toBe('ready');
    if (initial.state !== 'ready') throw new Error('Default registration acknowledged before real certification');
    const stats = observation.workerStats!;
    for (const name of ['semantic', 'search']) {
      expect(stats.defaultModules.filter((entry) => entry === name)).toHaveLength(1);
      expect(stats.registrationCounts[name]).toBe(1);
      expect(stats.startedServices[name]).toBeGreaterThan(0);
    }
    expect(stats.startedServices.search).toBe(1);
    expect(stats.searchStarterInvocations).toBe(1);
    expect(stats.stopped).toBe(false);
    expect(client.ledger().resources.filter((resource) => resource.kind === 'worker_process')).toHaveLength(1);
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) {
      const response = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        { type: 'schema:Book', labels: { en: `Lifecycle worker ${n}` } },
        { 'Idempotency-Key': `"${crypto.randomUUID()}"` },
      );
      expect(response.status).toBe(201);
      ids.push((response.body.subject as { id: string }).id);
    }
    ids.sort();
    const raw = async () =>
      (await searchSubjects(search, target.name, { filter: f.compiled.query, sort: 'id', size: 100 })).hits.filter(
        (hit) => ids.includes(hit.id),
      );
    const deadline = Date.now() + 120_000;
    let ready;
    for (;;) {
      ready = await readSubjectCoverage(config, { deadline });
      if (ready.state === 'ready' && (await raw()).length === 3) break;
      if (Date.now() >= deadline) throw new Error('Default worker did not establish physical coverage');
      await Bun.sleep(50); // Poll actual completion; elapsed time never proves it.
    }
    expect(ready.state).toBe('ready');
    const before = await raw();
    expect(before.map((hit) => hit.id)).toEqual(ids);
    expect(before.map((hit) => hit.matched)).toEqual([['f0'], ['f0'], ['f0']]);
    expect(before.map((hit) => hit.sort)).toEqual(ids.map((id) => [id]));
    if (ready.state !== 'ready') throw new Error('Missing actual A/B/C certificate');
    expect(ready.incarnation).toEqual(initial.incarnation);
    const api = (extra: Record<string, unknown> = {}) =>
      driver.request('anonymous', 'POST', '/v1/subjects:search', {
        filter: { type: { in: ['schema:Book'] } },
        sort: 'name',
        limit: 100,
        ...extra,
      });
    const disclosed = (response: Awaited<ReturnType<typeof api>>) => {
      expect(response.status).toBe(200);
      return (response.body.subjects as { id: string }[]).map((subject) => subject.id).sort();
    };
    expect(disclosed(await api())).toEqual(ids);
    const token = (await api({ limit: 1 })).body.next;
    expect(token).toBeString();
    await driver.indexing('paused');
    await certified(pool, search, ready.incarnation);
    const pausedCheckpoints = await checkpoints(pool, ready.incarnation.consumer);
    const paused = await client.inspect();
    expect(paused.workerStats!.startedServices.semantic).toBe(stats.startedServices.semantic);
    expect(paused.workerStats!.searchStarterInvocations).toBe(1);
    await driver.remove(ids[1]!, 'hidden');
    expect(await readSubjectCoverage(config, { deadline: Date.now() + 30_000 })).toEqual(ready);
    expect(await raw()).toEqual(before);
    expect(await checkpoints(pool, ready.incarnation.consumer)).toEqual(pausedCheckpoints);
    expect((await readFreshness(pool, ready.incarnation.consumer)).behind).toBeGreaterThan(0);
    const withheld = await api();
    expect(disclosed(withheld)).toEqual([ids[0]!, ids[2]!]);
    // Totals describe engine candidates; they are neither disclosure nor structural certification.
    expect(withheld.body.total).toEqual({ value: 3, relation: 'exact' });
    expect(disclosed(await api({ limit: 1, cursor: token }))).not.toContain(ids[1]!);
    expect(await raw()).toEqual(before);
    expect(await readSubjectCoverage(config, { deadline: Date.now() + 30_000 })).toEqual(ready);
    await driver.indexing('running');
    await driver.indexing('running');
    expect((await client.inspect()).workerStats!.searchStarterInvocations).toBe(2);
    await eventually(raw, (hits) => hits.length === 2 && hits.every((hit) => hit.id !== ids[1]));
    await eventually(
      () => readFreshness(pool!, ready.incarnation.consumer),
      (value) => value.behind === 0,
    );
    expect(disclosed(await api())).toEqual([ids[0]!, ids[2]!]);
    expect((await api()).body.total).toEqual({ value: 2, relation: 'exact' });
    expect(await readSubjectCoverage(config, { deadline: Date.now() + 30_000 })).toEqual(ready);

    // Snapshot native source facts, never rewrite them to make replay/certification succeed.
    const facts = async () => ({
      subjects: (
        await pool!.query('SELECT * FROM semantic.subject WHERE subject_id=ANY($1::uuid[]) ORDER BY subject_id', [ids])
      ).rows,
      events: (
        await pool!.query(
          'SELECT * FROM core.outbox WHERE subject=ANY($1::uuid[]) ORDER BY partition_no, position, event_seq',
          [ids],
        )
      ).rows,
      counts: (await pool!.query('SELECT * FROM semantic.partition_subjects ORDER BY partition_no')).rows,
    });
    const sourceBefore = await facts();
    const oldCheckpoint = await checkpoints(pool, ready.incarnation.consumer);
    // Observe actual alias publication while the production call owns replay/reconciliation.
    // Every sampled alias must already name a complete live lineage; never adopt a raw target here.
    let rebuilding = true;
    const pending = driver.rebuild().finally(() => {
      rebuilding = false;
    });
    const observing = (async () => {
      do {
        const active = (await subjectGenerations(search, target.name)).active;
        expect(active).not.toBeNull();
        const index = subjectIndexName(target.name, active!);
        const settings = await search.request<Record<string, { settings: { index: { uuid: string } } }>>(
          'GET',
          `/${index}/_settings`,
        );
        const incarnation: IndexIncarnation = {
          prefix: target.name,
          generation: active!,
          index,
          uuid: settings.body[index]!.settings.index.uuid,
          protocol: 'subject-coverage-v1',
          consumer: subjectConsumer(target.name, active!),
        };
        expect(await createCoverageStore(pool!).readLineage(incarnation)).toMatchObject({
          incarnation,
          state: 'live',
          complete: true,
          partition: 4096,
          after: null,
        });
        await Bun.sleep(50);
      } while (rebuilding);
    })();
    // Both owned operations settle even if an observation fails.
    const [rebuildResult, observationResult] = await Promise.allSettled([pending, observing]);
    if (rebuildResult.status === 'rejected') throw rebuildResult.reason;
    if (observationResult.status === 'rejected') throw observationResult.reason;
    const rebuilt = rebuildResult.value; // The actual public result is {generation}.
    expect(rebuilt.generation).toBeGreaterThan(ready.incarnation.generation);
    const replacement = await readSubjectCoverage(config, { deadline: Date.now() + 30_000 });
    expect(replacement.state).toBe('ready');
    if (replacement.state !== 'ready') throw new Error('Production rebuild switched before certification');
    expect(replacement.incarnation.generation).toBe(rebuilt.generation);
    expect(replacement.incarnation.uuid).not.toBe(ready.incarnation.uuid);
    expect(replacement.incarnation.index).not.toBe(ready.incarnation.index);
    expect(replacement.incarnation.consumer).not.toBe(ready.incarnation.consumer);
    const alias = await search.request<Record<string, unknown>>('GET', `/_alias/${subjectAlias(target.name)}`);
    expect(Object.keys(alias.body)).toEqual([replacement.incarnation.index]);
    await driver.indexing('paused'); // Drain the new runner before inspecting durable terminal evidence.
    await certified(pool, search, replacement.incarnation);
    await reconciled(pool, search, replacement.incarnation);
    expect(await facts()).toEqual(sourceBefore);
    expect(await checkpoints(pool, ready.incarnation.consumer)).toEqual(oldCheckpoint);
    expect(await createCoverageStore(pool).readLineage(ready.incarnation)).toMatchObject({
      incarnation: ready.incarnation,
      complete: true,
    });
    const stale = await api({ limit: 1, cursor: token });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('search_restart_required');
    expect(disclosed(await api())).toEqual([ids[0]!, ids[2]!]);
    const physical = await search.request<{ hits: { hits: { _id: string }[] } }>(
      'POST',
      `/${replacement.incarnation.index}/_search`,
      {
        size: 100,
        query: { ids: { values: ids } },
        sort: [{ id: 'asc' }],
      },
    );
    expect(physical.body.hits.hits.map((hit) => hit._id)).toEqual([ids[0]!, ids[2]!]);
    // Close while paused with an admitted native read: admission seals, accepted work drains, then pools disappear.
    const admitted = api();
    await pool.end();
    pool = undefined;
    const closing = client.close();
    expect(client.close()).toBe(closing);
    await expect(driver.indexing('running')).rejects.toThrow('closing');
    expect(disclosed(await admitted)).toEqual([ids[0]!, ids[2]!]);
    await closing;
    await gone(client);
  } finally {
    await pool?.end();
    await client.close();
  }
}, 600_000);
