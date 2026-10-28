import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createCoverageStore } from '../../src/search/coverage-store.ts';
import {
  activateSubjectIncarnation,
  createSubjectProjectionCoordinator,
  initializeSubjectIncarnation,
  readSubjectCoverage,
  retireSubjectIncarnation,
  type IndexIncarnation,
} from '../../src/search/coverage.ts';
import { documentActions, bulkLines } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { searchSubjects } from '../../src/search/query.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { createCoverageFixture } from './coverage-fixture.ts';
import { createDriverClient } from './support/driver-client.ts';

// Final production lifecycle proof remains independent of the three focused implementation acceptances.
let f: Awaited<ReturnType<typeof createCoverageFixture>>;
beforeAll(async () => {
  f = await createCoverageFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 180_000);

async function unavailable(prefix: string) {
  expect((await readSubjectCoverage(f.options(prefix), { deadline: Date.now() + 30_000 })).state).toBe('not_ready');
}
async function observed(prefix: string, generation: number): Promise<IndexIncarnation> {
  const index = subjectIndexName(prefix, generation);
  const result = await f.search.request<Record<string, { settings: { index: { uuid: string } } }>>(
    'GET',
    `/${index}/_settings`,
  );
  return {
    prefix,
    generation,
    index,
    uuid: result.body[index]!.settings.index.uuid,
    protocol: 'subject-coverage-v1',
    consumer: subjectConsumer(prefix, generation),
  };
}

async function complete(prefix: string, generation: number) {
  const config = f.options(prefix);
  const target = await initializeSubjectIncarnation(config, generation);
  const coordinator = createSubjectProjectionCoordinator(config);
  const deadline = Date.now() + 120_000;
  while ((await coordinator.populate(target)).state === 'more') {
    if (Date.now() >= deadline) throw new Error('Lifecycle population did not reach a durable terminal frontier');
  }
  expect((await coordinator.certify(target, { deadline: Date.now() + 30_000 })).state).toBe('ready');
  return { config, target, coordinator };
}

test('bounded bootstrap and conditional lifecycle native acceptance is staged', async () => {
  const prefix = f.fresh();
  const config = f.options(prefix);
  const target = await initializeSubjectIncarnation(config, 1);
  const store = createCoverageStore(f.pool);
  expect(await store.readLineage(target)).toMatchObject({
    origin: 'created-empty',
    state: 'populating',
    complete: false,
  });
  expect((await f.search.request<{ count: number }>('GET', `/${target.index}/_count`)).body.count).toBe(0);
  await expect(activateSubjectIncarnation(config, target)).rejects.toMatchObject({ code: 'index_not_ready' });
  await unavailable(prefix);
  const coordinator = createSubjectProjectionCoordinator(config);
  const deadline = Date.now() + 120_000;
  while ((await coordinator.populate(target)).state === 'more') {
    if (Date.now() >= deadline) throw new Error('Incomplete actual bootstrap');
  }
  expect((await coordinator.certify(target, { deadline: Date.now() + 30_000 })).state).toBe('ready');
  await activateSubjectIncarnation(config, target);
  expect((await subjectGenerations(f.search, prefix)).active).toBe(1);
  expect((await store.readLineage(target))!.complete).toBe(true);
  expect((await f.read(prefix)).state).toBe('ready');
}, 180_000);

test('unknown existing empty and equal-count wrong-ID indexes never acquire coverage from cardinality', async () => {
  const empty = f.fresh();
  await createSubjectIndex(f.search, empty, 1);
  const emptyTarget = await observed(empty, 1);
  await f.search.request('POST', '/_aliases', {
    actions: [{ add: { index: emptyTarget.index, alias: subjectAlias(empty) } }],
  });
  expect((await f.search.request<{ count: number }>('GET', `/${emptyTarget.index}/_count`)).body.count).toBe(0);
  await unavailable(empty);
  await expect(initializeSubjectIncarnation(f.options(empty), 1)).rejects.toMatchObject({ code: 'index_not_ready' });
  const p = await f.population();
  const ids = (await f.raw(p.prefix)).map((hit) => hit.id);
  expect(ids.length).toBeGreaterThan(0);
  const wrong = f.fresh();
  await createSubjectIndex(f.search, wrong, 1);
  const target = await observed(wrong, 1);
  const wrongIds: string[] = [];
  for (const partition of new Set(ids.map(subjectPartition))) {
    const requested = ids.filter((id) => subjectPartition(id) === partition);
    const snapshot = await f.source.read(partition, requested);
    const actions = documentActions(snapshot, requested).map((action) => {
      expect(action.op).toBe('index');
      if (action.op !== 'index') throw new Error('Wrong-key control requires real visible source anchors');
      const id = crypto.randomUUID();
      wrongIds.push(id);
      return { ...action, id, document: { ...action.document, id } };
    });
    const response = await f.search.bulk<{ errors: boolean }>(bulkLines(target.index, actions), {
      query: { refresh: 'wait_for' },
    });
    expect(response.errors).toBe(false);
  }
  const count = async (index: string) =>
    (await f.search.request<{ count: number }>('GET', `/${index}/_count`)).body.count;
  expect(await count(target.index)).toBe(await count(p.incarnation.index));
  expect(wrongIds.some((id) => ids.includes(id))).toBe(false);
  const stored = await f.search.request<{
    timed_out: boolean;
    _shards: { failed: number };
    hits: { hits: { _id: string; _source: { id: string } }[] };
  }>('POST', `/${target.index}/_search`, { size: 1000, sort: [{ id: 'asc' }], query: { match_all: {} } });
  expect(stored.body.timed_out).toBe(false);
  expect(stored.body._shards.failed).toBe(0);
  expect(stored.body.hits.hits.map((hit) => hit._id)).toEqual([...wrongIds].sort());
  for (const hit of stored.body.hits.hits) expect(hit._source.id).toBe(hit._id);
  await f.search.request('POST', '/_aliases', {
    actions: [{ add: { index: target.index, alias: subjectAlias(wrong) } }],
  });
  expect(await createCoverageStore(f.pool).readLineage(target)).toBeNull();
  expect(
    (await createSubjectProjectionCoordinator(f.options(wrong)).certify(target, { deadline: Date.now() + 30_000 }))
      .state,
  ).toBe('not_ready');
  await unavailable(wrong);
  await expect(activateSubjectIncarnation(f.options(wrong), target)).rejects.toMatchObject({ code: 'index_not_ready' });
}, 180_000);

test('same-name actual UUID replacement invalidates activated coverage even when the engine has zero hits', async () => {
  const p = await f.population();
  await f.search.request('DELETE', `/${p.incarnation.index}`);
  await createSubjectIndex(f.search, p.prefix, p.incarnation.generation);
  const replacement = await observed(p.prefix, p.incarnation.generation);
  expect(replacement.uuid).not.toBe(p.incarnation.uuid);
  await f.search.request('POST', '/_aliases', {
    actions: [{ add: { index: replacement.index, alias: subjectAlias(p.prefix) } }],
  });
  expect((await f.search.request<{ count: number }>('GET', `/${replacement.index}/_count`)).body.count).toBe(0);
  await unavailable(p.prefix);
  await expect(activateSubjectIncarnation(p.config, p.incarnation)).rejects.toMatchObject({ code: 'index_not_ready' });
  await expect(initializeSubjectIncarnation(p.config, p.incarnation.generation)).rejects.toMatchObject({
    code: 'index_not_ready',
  });
}, 180_000);

test('at most three retained incarnations and a permanent monotonic allocation fence survive retirement and restart', async () => {
  const prefix = f.fresh();
  const config = f.options(prefix);
  const store = createCoverageStore(f.pool);
  const first = await initializeSubjectIncarnation(config, 1);
  const second = await initializeSubjectIncarnation(config, 2);
  const third = await initializeSubjectIncarnation(config, 3);
  await expect(initializeSubjectIncarnation(config, 4)).rejects.toMatchObject({ code: 'index_not_ready' });
  expect((await subjectGenerations(f.search, prefix)).generations.length).toBeLessThanOrEqual(3);
  for (const target of [first, second, third]) expect(await store.readLineage(target)).not.toBeNull();
  await retireSubjectIncarnation(config, first);
  expect(await store.readLineage(first)).toBeNull();
  await expect(f.search.request('HEAD', `/${first.index}`)).rejects.toMatchObject({ status: 404 });
  await expect(initializeSubjectIncarnation(config, 1)).rejects.toMatchObject({ code: 'index_not_ready' });
  const fence = (await createCoverageStore(f.pool).readPrefix(prefix))!;
  expect(fence.issuedGeneration).toBeGreaterThanOrEqual(3);
  const next = await initializeSubjectIncarnation(config, fence.issuedGeneration + 1);
  expect([first.index, second.index, third.index]).not.toContain(next.index);
  expect(next.uuid).not.toBe(first.uuid);
  expect((await subjectGenerations(f.search, prefix)).generations).toHaveLength(3);
}, 180_000);

test('retirement wins over an activation whose real atomic alias request arrives late', async () => {
  const p = await complete(f.fresh(), 1);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const transport: OpenSearch = {
    ...f.search,
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      if (args[0] === 'POST' && args[1] === '/_aliases') {
        entered.resolve();
        await release.promise;
      }
      return f.search.request<T>(...args);
    },
  };
  const activating = activateSubjectIncarnation({ ...p.config, search: transport }, p.target).then(
    () => ({ activated: true }),
    (error: unknown) => ({ error }),
  );
  try {
    await entered.promise;
    await retireSubjectIncarnation(p.config, p.target);
  } finally {
    release.resolve();
    const result = await activating;
    expect('error' in result).toBe(true);
  }
  expect(await createCoverageStore(f.pool).readLineage(p.target)).toBeNull();
  expect((await subjectGenerations(f.search, p.config.prefix)).active).toBeNull();
  await unavailable(p.config.prefix);
}, 180_000);

test('late actual certification cannot recreate evidence after conditional retirement', async () => {
  const p = await f.population();
  const store = createCoverageStore(f.pool);
  const before = (await store.readLineage(p.incarnation))!;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  const transport: OpenSearch = {
    ...f.search,
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const response = await f.search.request<T>(...args);
      if (!held && args[0] === 'GET') {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return response;
    },
  };
  const pending = createSubjectProjectionCoordinator({ ...p.config, search: transport })
    .certify(p.incarnation, { deadline: Date.now() + 30_000 })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  try {
    await entered.promise;
    await retireSubjectIncarnation(p.config, p.incarnation);
  } finally {
    release.resolve();
    const result = await pending;
    if ('value' in result) expect(result.value.state).toBe('not_ready');
    else expect(result.error).toMatchObject({ code: 'index_not_ready' });
  }
  expect(await store.transition({ incarnation: p.incarnation, lineageRevision: before.revision }, 'live')).toBeNull();
  expect(await store.readLineage(p.incarnation)).toBeNull();
  expect(await store.readHome(p.incarnation, 0)).toBeNull();
  expect(
    (await f.admin.query('SELECT 1 FROM core.consumer_checkpoint WHERE consumer=$1', [p.incarnation.consumer])).rows,
  ).toEqual([]);
  await expect(p.coordinator.run(p.incarnation, 0)).rejects.toMatchObject({ code: 'index_not_ready' });
  await unavailable(p.prefix);
}, 180_000);

test('an unresolved old HTTP bulk cannot implicitly recreate an eligible target after retirement deletion', async () => {
  const p = await f.population();
  const [id] = await f.books(1);
  const release = Promise.withResolvers<void>();
  let late:
    | Promise<{ errors: boolean; items: Record<string, { status: number; error?: { type: string } }>[] }>
    | undefined;
  const transport: OpenSearch = {
    ...f.search,
    async bulk<T>(...args: Parameters<OpenSearch['bulk']>): Promise<T> {
      // Preserve the actual enrolled producer request and its engine response; only schedule its delivery.
      late = release.promise.then(() => f.search.bulk(...args));
      throw new Error('Unresolved old HTTP bulk response');
    },
  };
  await expect(
    createSubjectProjectionCoordinator({ ...p.config, search: transport }).run(p.incarnation, subjectPartition(id)),
  ).rejects.toThrow('Unresolved old HTTP bulk response');
  expect(late).toBeDefined();
  const store = createCoverageStore(f.pool);
  expect((await store.readHome(p.incarnation, subjectPartition(id)))!.attempt!.outcome).toBe('ambiguous');
  try {
    await retireSubjectIncarnation(p.config, p.incarnation);
    await expect(f.search.request('HEAD', `/${p.incarnation.index}`)).rejects.toMatchObject({ status: 404 });
  } finally {
    release.resolve();
    const response = await late!;
    expect(response.errors).toBe(true);
    expect(response.items.length).toBeGreaterThan(0);
    for (const item of response.items)
      expect(item.index ?? item.delete).toMatchObject({ status: 404, error: { type: 'index_not_found_exception' } });
  }
  await expect(f.search.request('HEAD', `/${p.incarnation.index}`)).rejects.toMatchObject({ status: 404 });
  expect(await store.readLineage(p.incarnation)).toBeNull();
  await unavailable(p.prefix);
  await expect(initializeSubjectIncarnation(p.config, p.incarnation.generation)).rejects.toMatchObject({
    code: 'index_not_ready',
  });
}, 180_000);

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
    await driver.indexing('paused');
    await driver.remove(ids[1]!, 'hidden');
    expect(await readSubjectCoverage(config, { deadline: Date.now() + 30_000 })).toEqual(ready);
    expect(await raw()).toEqual(before);
  } finally {
    await pool?.end();
    await client.close();
  }
}, 600_000);
