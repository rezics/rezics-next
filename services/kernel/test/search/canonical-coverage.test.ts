import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { lookupEventType } from '../../src/events/catalogue.ts';
import { parseFilter } from '@rezics/filter';
import {
  activateSubjectIncarnation,
  createSubjectProjectionCoordinator,
  initializeSubjectIncarnation,
  readSubjectCoverage,
  retireSubjectIncarnation,
} from '../../src/search/coverage.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { installTemplates, searchSubjects } from '../../src/search/query.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent, verifyAccountAgent, unverifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { createCoverageFixture, holdBulk } from './coverage-fixture.ts';
import { createDriverClient } from './support/driver-client.ts';

let f: Awaited<ReturnType<typeof createCoverageFixture>>;
beforeAll(async () => {
  f = await createCoverageFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 180_000);

async function nativeBasis() {
  const path = new URL('../../src/semantic/identity-basis.ts', import.meta.url);
  expect(
    await Bun.file(path).exists(),
    'native baseline passed; native identity basis implementation is required',
  ).toBe(true);
  const native = await import(path.href);
  expect(typeof native.readIdentityBasis).toBe('function');
  return native.readIdentityBasis(f.pool, { deadline: Date.now() + 30_000 });
}

async function identityEvents(original: string) {
  return (
    await f.admin.query<{ epoch: number; position: string; subject: string; data: { generation: string } }>(
      `SELECT epoch, position::text, subject, data FROM core.outbox
     WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.subject.identity.changed.v1'
     ORDER BY position, event_seq`,
      [subjectPartition(original), original],
    )
  ).rows;
}

test('identity invalidation has the registered closed lossless generation schema and actual original route', async () => {
  const path = new URL('../../src/semantic/events.ts', import.meta.url);
  const native = await import(path.href);
  expect(native.SUBJECT_IDENTITY_CHANGED).toBe('com.rezics.subject.identity.changed.v1');
  const schema = lookupEventType(native.SUBJECT_IDENTITY_CHANGED);
  expect(schema).toBeDefined();
  expect(schema!.Check({ generation: '9007199254740993' })).toBe(true);
  for (const data of [
    { generation: 0 },
    { generation: '-1' },
    { generation: '01' },
    { generation: '1', original: 'extra' },
  ]) {
    expect(schema!.Check(data)).toBe(false);
  }
  const ids = await f.books(2);
  const mutation = await f.merge(ids[0]!, ids[1]!);
  const events = await identityEvents(ids[0]!);
  expect(events).toHaveLength(1);
  expect(events[0]!.subject).toBe(ids[0]!);
  expect(events[0]!.epoch).toBe(mutation.component.epoch);
  expect(BigInt(events[0]!.position)).toBe(mutation.component.position);
}, 180_000);

test('real helper population certifies before hiding B and preserves raw matched sort and lookahead under ordinary lag', async () => {
  const ids = await f.books();
  const p = await f.population();
  const before = await f.read(p.prefix);
  expect(before.state).toBe('ready');
  const raw = (await f.raw(p.prefix)).filter((hit) => ids.includes(hit.id));
  expect(raw.map((hit) => hit.id)).toEqual(ids);
  expect(raw.map((hit) => hit.matched)).toEqual([['f0'], ['f0'], ['f0']]);
  expect(raw.map((hit) => hit.sort)).toEqual(ids.map((id) => [id]));
  await f.post(`/v1/subjects/${ids[1]}:hide`, { reason: 'Hidden after genuine certification' });
  expect(await f.read(p.prefix)).toEqual(before);
  expect((await f.raw(p.prefix)).filter((hit) => ids.includes(hit.id))).toEqual(raw);
  const checked = await f.disclosed(p.prefix);
  expect(checked.passed.some(({ subject }) => subject.id === ids[1])).toBe(false);
  const scope = f.scope(p.prefix);
  const handle = await scope.prepare(f.filter);
  const page = await scope.prefix(handle, { afterSubject: ids[0]!, quota: 1, budget: 2 });
  expect(page.hits).toEqual([raw[1]!]);
  expect(page.coveredThrough).toBe(ids[1]!);
  expect(page.exhausted).toBe(false);
  expect(page.usage.candidates).toBe(2);
}, 180_000);

test('structural native readiness while consumer is behind cannot certify a larger survivor or inherited repoint', async () => {
  const ids = await f.books();
  const p = await f.population();
  const initial = await nativeBasis();
  expect(initial.state).toBe('ready');
  await f.merge(ids[0]!, ids[1]!);
  await f.merge(ids[1]!, ids[2]!);
  await f.settleIdentity();
  expect((await nativeBasis()).state).toBe('ready');
  const events = await identityEvents(ids[0]!);
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(event.subject).toBe(ids[0]);
    expect(Object.keys(event.data)).toEqual(['generation']);
    expect(event.data.generation).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(BigInt(event.data.generation)).toBeGreaterThan(0n);
    expect(BigInt(event.position)).toBeGreaterThan(0n);
  }
  expect((await f.read(p.prefix)).state).toBe('not_ready');
  expect((await f.raw(p.prefix)).some((hit) => hit.id === ids[0])).toBe(true);
  expect((await f.consume(p.incarnation, ids)).state).toBe('ready');
  const raw = await f.raw(p.prefix);
  expect(raw.some((hit) => hit.id === ids[0] || hit.id === ids[1])).toBe(false);
  expect(raw.some((hit) => hit.id === ids[2])).toBe(true);
}, 180_000);

test('actual verification reversal emits original-home generation events and replay adds no mutation', async () => {
  const catalogue = (await f.post('/v1/subjects', { type: 'schema:Person', labels: { en: 'Coverage catalogue' } }))
    .subject.id;
  const agent = await ensureAccountAgent(f.pool, { account: f.accountId, kind: 'person', name: 'Coverage agent' });
  const original = agent.subject.id;
  const p = await f.population();
  const receipt = crypto.randomUUID();
  await verifyAccountAgent(f.pool, { account: f.accountId, catalogue, receipt });
  const events = await identityEvents(original);
  expect(events.length).toBeGreaterThan(0);
  await verifyAccountAgent(f.pool, { account: f.accountId, catalogue, receipt });
  expect(await identityEvents(original)).toEqual(events);
  await f.settleIdentity();
  expect((await f.read(p.prefix)).state).toBe('not_ready');
  expect((await f.consume(p.incarnation, [original, catalogue])).state).toBe('ready');
  await unverifyAccountAgent(f.pool, { account: f.accountId, receipt: crypto.randomUUID() });
  await f.settleIdentity();
  expect((await identityEvents(original)).length).toBeGreaterThan(events.length);
  expect((await f.read(p.prefix)).state).toBe('not_ready');
  expect((await f.consume(p.incarnation, [original, catalogue])).state).toBe('ready');
}, 180_000);

test('zero hits do not bless unknown UUIDs and known empty creation requires actual population provenance', async () => {
  const prefix = f.fresh();
  await createSubjectIndex(f.search, prefix, 1);
  await f.search.request('POST', '/_aliases', {
    actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
  });
  expect((await f.search.request<{ count: number }>('GET', `/${subjectIndexName(prefix, 1)}/_count`)).body.count).toBe(
    0,
  );
  expect((await f.read(prefix)).state).toBe('not_ready');
  await expect(initializeSubjectIncarnation(f.options(prefix), 1)).rejects.toMatchObject({ code: 'index_not_ready' });
  const controlled = f.fresh();
  const config = f.options(controlled);
  const incarnation = await initializeSubjectIncarnation(config, 1);
  expect(incarnation.uuid.length).toBeGreaterThan(0);
  expect((await f.search.request<{ count: number }>('GET', `/${incarnation.index}/_count`)).body.count).toBe(0);
  const coordinator = createSubjectProjectionCoordinator(config);
  while ((await coordinator.populate(incarnation)).state === 'more') {}
  expect((await coordinator.certify(incarnation, { deadline: Date.now() + 30_000 })).state).toBe('ready');
  await activateSubjectIncarnation(config, incarnation);
  await installTemplates(f.search, controlled);
  const runtime = f.scope(controlled);
  const handle = await runtime.prepare(parseFilter({ type: { in: ['schema:Movie'] } }));
  const page = await runtime.prefix(handle, { afterSubject: null, quota: 1, budget: 2 });
  expect(page.hits).toEqual([]);
  expect(page.exhausted).toBe(true);
  expect(page.usage.candidates).toBe(0);
}, 180_000);

test('source cap stays 256 and publication waits for every real source chunk and checkpoint outcome', async () => {
  const ids = await f.books();
  const route = routeOf(ids[0]!)!;
  await expect(
    f.source.read(
      subjectPartition(ids[0]!),
      Array.from({ length: 257 }, () => newId(route)),
    ),
  ).rejects.toThrow();
  const p = await f.population();
  const gate = holdBulk(f.search);
  await f.post(`/v1/subjects/${ids[0]}:hide`, { reason: 'Chunk visibility boundary' });
  const applying = f.consume(p.incarnation, ids, gate.transport);
  try {
    await gate.entered;
    // An ordinary same-basis attempt can preserve the previously verified structural tuple.
    expect((await f.read(p.prefix)).state).toBe('ready');
  } finally {
    gate.release();
    await applying;
  }
  expect((await f.read(p.prefix)).state).toBe('ready');
}, 180_000);

test('two actual coordinators cannot certify over an old source write even beyond finite delete retention', async () => {
  const p = await f.population();
  const ids = await f.books();
  await f.search.request('PUT', `/${p.incarnation.index}/_settings`, { index: { gc_deletes: '1ms' } });
  const gate = holdBulk(f.search);
  // Creation events yield real live-anchor snapshots, held before their engine writes.
  const old = f.consume(p.incarnation, ids, gate.transport);
  let newer: ReturnType<typeof f.consume> | undefined;
  try {
    await gate.entered;
    await f.merge(ids[0]!, ids[2]!);
    await f.settleIdentity();
    newer = f.consume(p.incarnation, ids);
    expect((await f.read(p.prefix)).state).toBe('not_ready');
    await Bun.sleep(20);
    expect((await f.read(p.prefix)).state).toBe('not_ready');
  } finally {
    gate.release();
    await Promise.all([old, newer]);
  }
  expect((await f.consume(p.incarnation, ids)).state).toBe('ready');
  expect((await f.raw(p.prefix)).some((hit) => hit.id === ids[0])).toBe(false);
}, 180_000);

test('ambiguous timeout never becomes completion by lease expiry and recovery uses a fresh physical generation', async () => {
  const ids = await f.books();
  const p = await f.population();
  await f.merge(ids[0]!, ids[2]!);
  const transport: OpenSearch = {
    request: f.search.request.bind(f.search),
    async bulk<T>(...args: Parameters<OpenSearch['bulk']>) {
      await f.search.bulk<T>(...args);
      throw new Error('Ambiguous native response lost after external write');
    },
  };
  await expect(f.consume(p.incarnation, ids, transport)).rejects.toThrow();
  expect((await f.read(p.prefix)).state).toBe('not_ready');
  const replacement = await initializeSubjectIncarnation(p.config, 2);
  expect(replacement.uuid).not.toBe(p.incarnation.uuid);
  expect(replacement.index).not.toBe(p.incarnation.index);
  while ((await p.coordinator.populate(replacement)).state === 'more') {}
  expect((await p.coordinator.certify(replacement, { deadline: Date.now() + 30_000 })).state).toBe('ready');
}, 180_000);

test('conditional publication retirement and process restart retain exact incarnation lineage', async () => {
  const p = await f.population();
  const restarted = createSubjectProjectionCoordinator(p.config);
  expect((await restarted.certify(p.incarnation, { deadline: Date.now() + 30_000 })).state).toBe('ready');
  await retireSubjectIncarnation(p.config, p.incarnation);
  await expect(restarted.run(p.incarnation, 0)).rejects.toThrow();
  expect((await restarted.certify(p.incarnation, { deadline: Date.now() + 30_000 })).state).toBe('not_ready');
  await expect(initializeSubjectIncarnation(p.config, p.incarnation.generation)).rejects.toThrow();
  expect((await f.read(p.prefix)).state).toBe('not_ready');
}, 180_000);

test('actual default worker produces the same certificate before pause and ordinary hide', async () => {
  const client = createDriverClient();
  let pool: pg.Pool | undefined;
  try {
    const driver = await client.init();
    const observation = await client.inspect();
    expect(observation.workerStats!.registeredModules).toEqual(observation.workerStats!.defaultModules);
    expect(observation.workerStats!.registrationCounts.search).toBe(1);
    const database = client.ledger().resources.find((r) => r.kind === 'kernel_database');
    const target = client.ledger().resources.find((r) => r.kind === 'index_prefix');
    if (!database || database.kind !== 'kernel_database' || !target || target.kind !== 'index_prefix')
      throw new Error('Missing native worker ownership');
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${database.name}`;
    pool = new pg.Pool({ connectionString: url.href });
    const search = createOpenSearch(process.env.OPENSEARCH_URL!);
    const read = () =>
      readSubjectCoverage({ pool: pool!, search, prefix: target.name }, { deadline: Date.now() + 30_000 });
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) {
      const response = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        {
          type: 'schema:Book',
          labels: { en: `Default coverage ${n}` },
        },
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
    const deadline = Date.now() + 30_000;
    while ((await raw()).length !== 3) {
      if (Date.now() >= deadline) throw new Error('Actual default worker did not populate A/B/C');
      await Bun.sleep(50);
    }
    const before = await read();
    expect(before.state).toBe('ready');
    const hits = await raw();
    expect(hits.map((hit) => hit.id)).toEqual(ids);
    expect(hits.map((hit) => hit.matched)).toEqual([['f0'], ['f0'], ['f0']]);
    expect(hits.map((hit) => hit.sort)).toEqual(ids.map((id) => [id]));
    await driver.indexing('paused');
    await driver.remove(ids[1]!, 'hidden');
    expect(await read()).toEqual(before);
    expect(await raw()).toEqual(hits);
  } finally {
    await pool?.end();
    await client.close();
  }
}, 600_000);
