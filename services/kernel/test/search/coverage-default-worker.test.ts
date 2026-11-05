import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { admitFilter, parseFilter } from '@rezics/filter';
import { compileFilter } from '../../src/search/filter.ts';
import pg from 'pg';
import { readFreshness } from '../../src/search/freshness.ts';
import { subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { searchSubjects } from '../../src/search/query.ts';
import { createDriverClient, type DriverClient } from './support/driver-client.ts';

const search = createOpenSearch(process.env.OPENSEARCH_URL!);
const compiled = compileFilter(admitFilter(parseFilter({ type: { in: ['schema:Book'] } }), bundledRelease), {
  prefix: 'f',
  relationOverflow: true,
});

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

type IndexIncarnation = { prefix: string; generation: number; index: string; uuid: string; consumer: string };
async function physical(search: OpenSearch, prefix: string): Promise<IndexIncarnation | null> {
  const generation = (await subjectGenerations(search, prefix)).active;
  if (generation === null) return null;
  const index = subjectIndexName(prefix, generation);
  const settings = await search.request<Record<string, { settings: { index: { uuid: string } } }>>(
    'GET',
    `/${index}/_settings`,
  );
  return {
    prefix,
    generation,
    index,
    uuid: settings.body[index]!.settings.index.uuid,
    consumer: subjectConsumer(prefix, generation),
  };
}
async function certified(pool: pg.Pool, search: OpenSearch, incarnation: IndexIncarnation, settled = true) {
  const { index, uuid } = incarnation;
  expect(await physical(search, incarnation.prefix)).toEqual(incarnation);
  const native = (
    await pool.query<{
      job: string;
      pass: string;
      phase: string;
      fenced_pass: boolean;
      consumer: { incarnation: string };
      native_incarnation: string;
    }>(
      `SELECT job,pass::text,phase,fenced_pass,consumer,native_incarnation
      FROM search.generation_publication WHERE partition_no=0 AND physical_target=$1`,
      [index],
    )
  ).rows;
  expect(native).toHaveLength(1);
  expect(settled ? ['active'] : ['intent', 'active']).toContain(native[0]!.phase);
  expect(native[0]!.fenced_pass).toBe(true);
  expect(native[0]!.consumer.incarnation).toBe(uuid);
  const homes = await pool.query<{ partition_no: number }>(
    `SELECT partition_no FROM search.generation_publication_home WHERE job=$1 AND pass=$2 ORDER BY partition_no`,
    [native[0]!.job, native[0]!.pass],
  );
  expect(homes.rows.map((row) => row.partition_no)).toEqual(Array.from({ length: 4096 }, (_, home) => home));
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
        const result = await search.request<{ indices: { name: string }[] }>(
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

test('real default worker reconciles a native replacement across interruption and lost activation response', async () => {
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
    const initial = await eventually(
      () => physical(search, target.name),
      (value) => value !== null,
    );
    const ready = { incarnation: initial! };
    await certified(pool, search, ready.incarnation);
    const stats = observation.workerStats!;
    for (const name of ['semantic', 'search']) {
      expect(stats.defaultModules.filter((entry) => entry === name)).toHaveLength(1);
      expect(stats.registrationCounts[name]).toBe(1);
      expect(stats.startedServices[name]).toBeGreaterThan(0);
    }
    expect(stats.startedServices.search).toBeGreaterThan(1);
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
      (await searchSubjects(search, target.name, { filter: compiled.query, sort: 'id', size: 100 })).hits.filter(
        (hit) => ids.includes(hit.id),
      );
    await eventually(raw, (hits) => hits.length === 3);
    await eventually(
      () => readFreshness(pool!, ready.incarnation.consumer),
      (value) => value.behind === 0,
    );
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
    const post = (persona: 'editor' | 'acceptor', path: string, body: unknown) =>
      driver.request(persona, 'POST', path, body, { 'Idempotency-Key': `"${crypto.randomUUID()}"` });
    const author = await post('editor', '/v1/subjects', { type: 'schema:Person', labels: { en: 'Recovery author' } });
    expect(author.status).toBe(201);
    const authorId = (author.body.subject as { id: string }).id;
    const candidate = await post('editor', `/v1/subjects/${ids[0]}/candidates`, {
      statement: {
        property: { id: 'schema:author' },
        value: { type: 'value', content: authorId },
        qualifiers: [],
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/recovery' } },
            ],
          },
        ],
      },
    });
    expect(candidate.status).toBe(201);
    expect(
      (
        await post('acceptor', `/v1/subjects/${ids[0]}/candidates/${candidate.body.candidate}:accept`, {
          context: driver.globalContext,
          expected_head: null,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post('acceptor', `/v1/subjects/${ids[0]}:adopt`, {
          context: driver.globalContext,
          property: 'schema:author',
          target: authorId,
          mode: 'replace',
          selection: [{ candidate: candidate.body.candidate, rank: 'normal' }],
          expected_head: null,
        })
      ).status,
    ).toBe(200);
    const updated = compileFilter(
      admitFilter(
        parseFilter({
          and: [{ type: { in: ['schema:Book'] } }, { statement: { property: 'schema:author', in: [authorId] } }],
        }),
        bundledRelease,
      ),
      { prefix: 'f', relationOverflow: true },
    );
    // Observe the native update in the engine without opening an advanced HTTP scope.
    await eventually(
      async () =>
        (await searchSubjects(search, target.name, { filter: updated.query, sort: 'id', size: 100 })).hits.map(
          (hit) => hit.id,
        ),
      (value) => value.length === 1 && value[0] === ids[0],
    );
    await eventually(
      () => readFreshness(pool!, ready.incarnation.consumer),
      (value) => value.behind === 0,
    );
    const before = await raw();
    expect(before.map((hit) => hit.id)).toEqual(ids);
    expect(before.map((hit) => hit.matched)).toEqual([['f0'], ['f0'], ['f0']]);
    expect(before.map((hit) => hit.sort)).toEqual(ids.map((id) => [id]));
    expect(await physical(search, target.name)).toEqual(initial);
    const token = (await api({ limit: 1 })).body.next;
    expect(token).toBeString();
    await driver.indexing('paused');
    await certified(pool, search, ready.incarnation);
    const pausedCheckpoints = await checkpoints(pool, ready.incarnation.consumer);
    const paused = await client.inspect();
    expect(paused.workerStats!.startedServices.semantic).toBe(stats.startedServices.semantic);
    expect(paused.workerStats!.searchStarterInvocations).toBe(1);
    await driver.remove(ids[1]!, 'hidden');
    expect(await physical(search, target.name)).toEqual(initial);
    expect(await raw()).toEqual(before);
    expect(await checkpoints(pool, ready.incarnation.consumer)).toEqual(pausedCheckpoints);
    expect((await readFreshness(pool, ready.incarnation.consumer)).behind).toBeGreaterThan(0);
    const withheld = await api();
    expect(withheld.body).not.toHaveProperty('total');
    expect(disclosed(withheld)).toEqual([ids[0]!, ids[2]!]);
    expect(disclosed(await api({ limit: 1, cursor: token }))).not.toContain(ids[1]!);
    expect(await raw()).toEqual(before);
    expect(await physical(search, target.name)).toEqual(initial);
    await driver.indexing('running');
    await driver.indexing('running');
    expect((await client.inspect()).workerStats!.searchStarterInvocations).toBe(2);
    await eventually(raw, (hits) => hits.length === 2 && hits.every((hit) => hit.id !== ids[1]));
    await eventually(
      () => readFreshness(pool!, ready.incarnation.consumer),
      (value) => value.behind === 0,
    );
    const converged = await api();
    expect(converged.body).not.toHaveProperty('total');
    expect(disclosed(converged)).toEqual([ids[0]!, ids[2]!]);
    expect(await physical(search, target.name)).toEqual(initial);

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
    // Every sampled alias must carry the completed native job and complete final pass.
    const requested = await client.requestRebuild();
    const replacementIndex = subjectIndexName(target.name, requested.generation);
    const retainedJob = async () =>
      (
        await pool!.query<{ job: string; consumer: { incarnation: string }; phase: string }>(
          `SELECT job,consumer,phase FROM search.generation_publication WHERE partition_no=0 AND physical_target=$1`,
          [replacementIndex],
        )
      ).rows[0];
    await client.loseActivationResponse();
    await driver.indexing('running');
    const originalJob = await eventually(retainedJob, (value) => value !== undefined);
    expect((await subjectGenerations(search, target.name)).active).toBe(ready.incarnation.generation);
    expect(disclosed(await api())).toEqual([ids[0]!, ids[2]!]);
    const restarted = await client.restartWorker();
    expect(restarted.workerStats!.registeredModules).toEqual(stats.defaultModules);
    expect(restarted.workerStats!.searchStarterInvocations).toBe(1);
    expect((await retainedJob())!.job).toBe(originalJob!.job);
    expect((await retainedJob())!.consumer.incarnation).toBe(originalJob!.consumer.incarnation);
    expect(client.ledger().resources.filter((resource) => resource.kind === 'worker_process')).toHaveLength(2);
    let rebuilding = true;
    const pending = eventually(
      () => physical(search, target.name),
      (value) => value?.generation === requested.generation,
    )
      .then((value) => ({ generation: value!.generation }))
      .finally(() => {
        rebuilding = false;
      });
    const observing = (async () => {
      do {
        const active = (await subjectGenerations(search, target.name)).active;
        expect(active).not.toBeNull();
        const incarnation = (await physical(search, target.name))!;
        await certified(pool!, search, incarnation, false);
        expect(disclosed(await api())).toEqual([ids[0]!, ids[2]!]);
        await Bun.sleep(50);
      } while (rebuilding);
    })();
    // Both owned operations settle even if an observation fails.
    const [rebuildResult, observationResult] = await Promise.allSettled([pending, observing]);
    if (rebuildResult.status === 'rejected') throw rebuildResult.reason;
    if (observationResult.status === 'rejected') throw observationResult.reason;
    const rebuilt = rebuildResult.value; // The actual public result is {generation}.
    expect(rebuilt.generation).toBe(requested.generation);
    expect(rebuilt.generation).toBeGreaterThan(ready.incarnation.generation);
    expect((await client.inspect()).lostAliasResponses).toBe(1);
    expect((await retainedJob())!.job).toBe(originalJob!.job);
    const replacement = { incarnation: (await physical(search, target.name))! };
    expect(replacement.incarnation.generation).toBe(rebuilt.generation);
    expect(replacement.incarnation.uuid).not.toBe(ready.incarnation.uuid);
    expect(replacement.incarnation.index).not.toBe(ready.incarnation.index);
    expect(replacement.incarnation.consumer).not.toBe(ready.incarnation.consumer);
    const alias = await search.request<Record<string, unknown>>('GET', `/_alias/${subjectAlias(target.name)}`);
    expect(Object.keys(alias.body)).toEqual([replacement.incarnation.index]);
    await driver.indexing('paused'); // Drain the new runner before inspecting durable terminal evidence.
    await certified(pool, search, replacement.incarnation);
    await reconciled(pool, search, replacement.incarnation);
    const nativeCoverage = await client.nativeCoverage();
    expect(nativeCoverage.homes).toBe(4096);
    expect(nativeCoverage.engineKeys).toBe(nativeCoverage.nativeKeys);
    expect(nativeCoverage.nativeKeys).toBeGreaterThanOrEqual(2);
    expect(await facts()).toEqual(sourceBefore);
    const drained = await checkpoints(pool, ready.incarnation.consumer);
    for (const previous of oldCheckpoint) {
      const current = drained.find((row) => row.partition_no === previous.partition_no)!;
      expect(current.epoch).toBe(previous.epoch);
      expect(BigInt(current.position)).toBeGreaterThanOrEqual(BigInt(previous.position));
    }
    const stale = await api({ limit: 1, cursor: token });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('search_restart_required');
    expect(disclosed(await api())).toEqual([ids[0]!, ids[2]!]);
    const visible = await search.request<{ hits: { hits: { _id: string }[] } }>(
      'POST',
      `/${replacement.incarnation.index}/_search`,
      {
        size: 100,
        query: { ids: { values: ids } },
        sort: [{ id: 'asc' }],
      },
    );
    expect(visible.body.hits.hits.map((hit) => hit._id)).toEqual([ids[0]!, ids[2]!]);
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
