import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import { accessCheck } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { createSubjectProjectionCoordinator, type IndexIncarnation } from '../../src/search/coverage.ts';
import { createCoverageProjection } from '../../src/search/coverage-projection.ts';
import { createCoverageStore } from '../../src/search/coverage-store.ts';
import { createSubjectIndexer, type SubjectApplyGuard } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { activeRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { writeSubject } from '../../src/semantic/subject.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { createCoverageFixture, holdBulk } from './coverage-fixture.ts';

// Native red specifications. The shared fixture establishes commands/Access/source/engine first.
let f: Awaited<ReturnType<typeof createCoverageFixture>>;
beforeAll(async () => {
  f = await createCoverageFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 180_000);
const store = () => createCoverageStore(f.pool);
async function target(controlled = true) {
  const prefix = f.fresh();
  await createSubjectIndex(f.search, prefix, 1);
  const index = subjectIndexName(prefix, 1);
  const settings = await f.search.request<Record<string, { settings: { index: { uuid: string } } }>>(
    'GET',
    `/${index}/_settings`,
  );
  const incarnation: IndexIncarnation = {
    prefix,
    generation: 1,
    index,
    uuid: settings.body[index]!.settings.index.uuid,
    protocol: 'subject-coverage-v1',
    consumer: subjectConsumer(prefix, 1),
  };
  expect(incarnation.uuid.length).toBeGreaterThan(0);
  if (controlled) {
    const allocation = await store().allocate(prefix, 0n, 1);
    expect(allocation).not.toBeNull();
    const lineage = await store().register(allocation!, incarnation, 'created-empty');
    expect(lineage).toMatchObject({ state: 'populating', complete: false });
  }
  const config = f.options(prefix);
  return { incarnation, config, coordinator: createSubjectProjectionCoordinator(config) };
}
async function checkpoint(i: IndexIncarnation, partition: number) {
  const result = await f.admin.query<{ position: string }>(
    'SELECT position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2',
    [partition, i.consumer],
  );
  return BigInt(result.rows[0]?.position ?? '0');
}
function indexer(i: IndexIncarnation, aroundApply?: SubjectApplyGuard) {
  return createSubjectIndexer({
    ...f.options(i.prefix),
    index: i.index,
    consumer: i.consumer,
    ...(aroundApply ? { aroundApply } : {}),
  });
}
async function count(i: IndexIncarnation) {
  return (await f.search.request<{ count: number }>('GET', `/${i.index}/_count`)).body.count;
}
async function slot(i: IndexIncarnation, partition: number) {
  return (await store().readHome(i, partition))?.attempt;
}

// One genuine native command with many anchors, real authenticated Access, no source facts seeded by SQL.
async function anchors(count: number) {
  const vacant = await f.admin.query<{ partition_no: number }>(
    `SELECT partition_no FROM core.partition p WHERE p.position=0 AND p.partition_no>0 AND NOT EXISTS
     (SELECT 1 FROM core.outbox o WHERE o.partition_no=p.partition_no) ORDER BY partition_no LIMIT 1`,
  );
  const partition = vacant.rows[0]!.partition_no;
  const route = partition * 16;
  const account = newId(30002);
  const auth = await createRealAccess(f.admin, { writer: account }, ['subject:create']);
  const resource = { route: 0, id: GLOBAL_CONTEXT };
  await auth.grant(resource, 'writer', 'subject:create');
  const access = auth.access({ actions: new Map([['subject:create', { anonymous: false }]]) });
  const deadline = Date.now() + 120_000;
  const actor = await access.authenticate(auth.bearer('writer'), { pool: f.admin, deadline });
  if (actor.kind !== 'account') throw new Error('Real account authentication required');
  const check = await accessCheck(access, actor, 'subject:create', resource, { pool: f.admin, deadline });
  const key = crypto.randomUUID();
  const release = (await activeRelease(f.pool))!;
  const ids = Array.from({ length: count }, () => newId(route));
  await runCommand(
    f.pool,
    {
      partition,
      deadline,
      receipt: {
        actorAccountId: actor.accountId,
        kind: 'subject.create',
        key,
        digest: createHash('sha256').update(key).digest(),
      },
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization: {
        action: 'subject:create',
        resource,
        denied: () => new Error('Native creation denied'),
        async authorize(tx, attempt) {
          if (!(await check(tx, attempt.time))) throw new Error('Native creation denied');
          return 'execute';
        },
      },
    },
    async (tx, { transactionId }) => {
      const events = [];
      for (const id of ids) {
        const written = await writeSubject(tx, transactionId, {
          target: { route, id },
          release,
          item: { type: 'schema:Book', labels: { en: 'Projection anchor' } },
        });
        events.push(...written.events);
      }
      return { value: null, events };
    },
  );
  return { partition, ids };
}

test('the optional guard receives parsed consecutive envelopes before the same real source/bulk body', async () => {
  const { partition, ids } = await anchors(1);
  const { incarnation: i } = await target(false);
  let entered = false;
  let reads = 0;
  const relay = createSubjectIndexer({
    ...f.options(i.prefix),
    index: i.index,
    consumer: i.consumer,
    source: {
      ...f.source,
      async read(...args: Parameters<typeof f.source.read>) {
        reads++;
        return f.source.read(...args);
      },
    },
    aroundApply: async (home, envelopes, apply) => {
      expect(reads).toBe(0);
      expect(home).toBe(partition);
      expect(envelopes[0]!.partition).toBe(home);
      expect(envelopes[0]!.position - 1n).toBe(await checkpoint(i, home));
      expect(envelopes.at(-1)!.epoch).toBe(envelopes[0]!.epoch);
      expect(envelopes.flatMap((e) => e.events).some((e) => e.subject === ids[0])).toBe(true);
      expect(await count(i)).toBe(0);
      entered = true;
      await apply();
      expect(await count(i)).toBe(1);
      expect(await checkpoint(i, home)).toBe(0n);
      expect(reads).toBe(1);
    },
  });
  expect((await relay.run(partition)).status).toBe('read');
  expect(entered).toBe(true);
  expect(await checkpoint(i, partition)).toBeGreaterThan(0n);
}, 180_000);

test('guard denial, omission and duplicate apply cannot advance the checkpoint or run a second body', async () => {
  const { partition } = await anchors(1);
  for (const mode of ['denied', 'omitted', 'duplicate']) {
    const { incarnation: i } = await target(false);
    const relay = indexer(i, async (_p, _e, apply) => {
      if (mode === 'denied') throw new Error('Admission denied');
      if (mode === 'omitted') return;
      await apply();
      await expect(async () => apply()).rejects.toThrow();
    });
    await expect(relay.run(partition)).rejects.toThrow();
    expect(await checkpoint(i, partition)).toBe(0n);
    expect(await count(i)).toBe(mode === 'duplicate' ? 1 : 0);
  }
}, 180_000);

test('durable enrollment is observable before source and bulk, and separate coordinator instances compete', async () => {
  const { partition } = await anchors(1);
  const { incarnation: i, config } = await target();
  const gate = holdBulk(f.search);
  let reads = 0;
  const source = {
    ...f.source,
    async read(...args: Parameters<typeof f.source.read>) {
      reads++;
      expect(await slot(i, partition)).toMatchObject({ outcome: 'enrolled', checkpoint: 'pending', source: null });
      return f.source.read(...args);
    },
  };
  const first = createCoverageProjection({ ...config, source, search: gate.transport }).run(i, partition);
  try {
    await Promise.race([
      gate.entered,
      first.then(() => {
        throw new Error('Apply never reached bulk');
      }),
    ]);
    const enrolled = await slot(i, partition);
    expect(enrolled).toMatchObject({ from: { position: 0n }, through: { position: 1n }, checkpoint: 'pending' });
    const second = createSubjectProjectionCoordinator({ ...config, source });
    expect(await second.run(i, partition)).toEqual({ status: 'busy' });
    expect(await slot(i, partition)).toEqual(enrolled);
    expect(reads).toBe(1);
    expect(await checkpoint(i, partition)).toBe(0n);
  } finally {
    gate.release();
    await first;
  }
  expect(await slot(i, partition)).toMatchObject({ outcome: 'completed', checkpoint: 'advanced' });
}, 180_000);

test('409 must refresh the actual superseding winner before checkpoint completion', async () => {
  const { partition } = await anchors(1);
  const { incarnation: i, config } = await target();
  await f.search.request('PUT', `/${i.index}/_settings`, { index: { refresh_interval: '-1' } });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let conflicts = 0;
  const transport: OpenSearch = {
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      if (args[1] === `/${i.index}/_refresh`) {
        entered.resolve();
        await release.promise;
      }
      return f.search.request<T>(...args);
    },
    async bulk<T>(lines: Parameters<OpenSearch['bulk']>[0], options: Parameters<OpenSearch['bulk']>[1]) {
      await f.search.bulk(lines, { query: { refresh: false } });
      const response = await f.search.bulk<{ items: Record<string, { status: number }>[] }>(lines, options);
      conflicts += response.items.filter((item) => Object.values(item)[0]!.status === 409).length;
      return response as T;
    },
  };
  const running = createSubjectProjectionCoordinator({ ...config, search: transport }).run(i, partition);
  try {
    await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error('Conflict never reached refresh');
      }),
    ]);
    expect(conflicts).toBeGreaterThan(0);
    expect(await count(i)).toBe(0);
    expect(await checkpoint(i, partition)).toBe(0n);
    expect((await slot(i, partition))?.outcome).not.toBe('completed');
  } finally {
    release.resolve();
    await running;
  }
  expect(await count(i)).toBe(1);
  expect(await slot(i, partition)).toMatchObject({ outcome: 'completed', checkpoint: 'advanced' });
}, 180_000);

test('source failure before HTTP is safely aborted and retryable; response lost after real apply stays ambiguous', async () => {
  const { partition } = await anchors(1);
  const { incarnation: i, config, coordinator } = await target();
  let sent = 0;
  const transport: OpenSearch = {
    request: f.search.request.bind(f.search),
    async bulk<T>(...args: Parameters<OpenSearch['bulk']>) {
      sent++;
      return f.search.bulk<T>(...args);
    },
  };
  const failed = createSubjectProjectionCoordinator({
    ...config,
    search: transport,
    source: {
      ...f.source,
      async read() {
        throw new Error('Source failed before any engine request');
      },
    },
  });
  await expect(failed.run(i, partition)).rejects.toThrow();
  expect(sent).toBe(0);
  // Additive store contract below is deliberately specified before its production implementation.
  expect(await slot(i, partition)).toMatchObject({ outcome: 'aborted', checkpoint: 'pending', source: null });
  expect((await coordinator.run(i, partition)).status).toBe('read');
  const next = await target();
  const lost: OpenSearch = {
    request: f.search.request.bind(f.search),
    async bulk<T>(...args: Parameters<OpenSearch['bulk']>): Promise<T> {
      await f.search.bulk(...args);
      throw new Error('Actual response lost after external apply');
    },
  };
  await expect(
    createSubjectProjectionCoordinator({ ...next.config, search: lost }).run(next.incarnation, partition),
  ).rejects.toThrow();
  expect(await count(next.incarnation)).toBe(1);
  expect(await slot(next.incarnation, partition)).toMatchObject({ outcome: 'ambiguous', checkpoint: 'pending' });
  expect(await next.coordinator.run(next.incarnation, partition)).toEqual({ status: 'busy' });
  expect(await checkpoint(next.incarnation, partition)).toBe(0n);
}, 180_000);

test('actual checkpoint CAS loss after visible apply records lost, distinct from busy before apply', async () => {
  const { partition } = await anchors(1);
  const { incarnation: i, config } = await target();
  const gate = holdBulk(f.search);
  const running = createSubjectProjectionCoordinator({ ...config, search: gate.transport }).run(i, partition);
  try {
    await Promise.race([
      gate.entered,
      running.then(() => {
        throw new Error('Apply never reached bulk');
      }),
    ]);
    // Adversarial old unguarded caller: the same production apply genuinely wins core CAS.
    expect((await indexer(i).run(partition)).status).toBe('read');
  } finally {
    gate.release();
  }
  expect(await running).toEqual({ status: 'busy' });
  expect(await slot(i, partition)).toMatchObject({ outcome: 'completed', checkpoint: 'lost' });
  expect(await count(i)).toBe(1);
}, 180_000);

test('empty batches enroll nothing; genuine link-only batches complete without source coverage', async () => {
  const person = (await f.post('/v1/subjects', { type: 'schema:Person', labels: { en: 'Projection author' } })).subject
    .id;
  const partition = subjectPartition(person);
  const { incarnation: i, config, coordinator } = await target();
  await coordinator.run(i, partition);
  const previous = await slot(i, partition);
  expect(await coordinator.run(i, partition)).toMatchObject({ status: 'read', envelopes: 0 });
  expect(await slot(i, partition)).toEqual(previous);
  const book = (
    await f.post('/v1/subjects', {
      type: 'schema:Book',
      labels: { en: 'Projection authored book' },
      statements: {
        'schema:author': [{ property: { id: 'schema:author' }, value: { type: 'value', content: person } }],
      },
    })
  ).subject.id;
  // Consume a colliding creation before projecting its genuine link maintenance event.
  if (subjectPartition(book) === partition) await coordinator.run(i, partition);
  await f.settleIdentity();
  let reads = 0;
  const source = {
    ...f.source,
    async read(...args: Parameters<typeof f.source.read>) {
      reads++;
      return f.source.read(...args);
    },
  };
  expect(await createSubjectProjectionCoordinator({ ...config, source }).run(i, partition)).toMatchObject({
    status: 'read',
  });
  expect(reads).toBe(0);
  expect(await slot(i, partition)).toMatchObject({ outcome: 'skipped', checkpoint: 'advanced', source: null });
}, 180_000);

for (const corruption of ['gap', 'invalid_data'] as const)
  for (const broken of [1, 2])
    test(`a ${corruption} at ${broken} stops at the genuine valid prefix`, async () => {
      const { partition, ids } = await anchors(1);
      await f.post(`/v1/subjects/${ids[0]}:hide`, { reason: 'Second genuine envelope' });
      const { incarnation: i, coordinator } = await target();
      const saved = await f.admin.query('SELECT * FROM core.outbox WHERE partition_no=$1 AND position=$2', [
        partition,
        broken,
      ]);
      expect(saved.rows.length).toBeGreaterThan(0);
      try {
        if (corruption === 'gap')
          await f.admin.query(
            'UPDATE core.outbox SET event_count=event_count+1 WHERE partition_no=$1 AND position=$2',
            [partition, broken],
          );
        else
          await f.admin.query(
            "UPDATE core.outbox SET data='{}'::jsonb WHERE partition_no=$1 AND position=$2 AND event_seq=0",
            [partition, broken],
          );
        expect(await coordinator.run(i, partition)).toMatchObject({
          status: 'stopped',
          reason: corruption,
          envelopes: broken - 1,
          position: BigInt(broken - 1),
        });
        expect(await checkpoint(i, partition)).toBe(BigInt(broken - 1));
        if (broken === 1) expect(await slot(i, partition)).toBeUndefined();
        else
          expect(await slot(i, partition)).toMatchObject({
            through: { position: 1n },
            outcome: 'completed',
            checkpoint: 'stopped',
          });
      } finally {
        for (const row of saved.rows)
          await f.admin.query(
            'UPDATE core.outbox SET data=$4,event_count=$5 WHERE partition_no=$1 AND position=$2 AND event_seq=$3',
            [partition, row.position, row.event_seq, row.data, row.event_count],
          );
      }
    }, 180_000);

test('all real source chunks are at most 256 and every chunk is visible before the envelope checkpoint', async () => {
  const { partition, ids } = await anchors(257);
  await expect(f.source.read(partition, ids)).rejects.toThrow();
  const { incarnation: i, config } = await target();
  const sizes: number[] = [];
  let writes = 0;
  const source = {
    ...f.source,
    async read(p: number, selected: readonly string[]) {
      sizes.push(selected.length);
      expect(selected.length).toBeLessThanOrEqual(256);
      expect(await checkpoint(i, partition)).toBe(0n);
      return f.source.read(p, selected);
    },
  };
  const transport: OpenSearch = {
    request: f.search.request.bind(f.search),
    async bulk<T>(...args: Parameters<OpenSearch['bulk']>) {
      const response = await f.search.bulk<T>(...args);
      writes++;
      expect(await checkpoint(i, partition)).toBe(0n);
      return response;
    },
  };
  expect(
    (await createSubjectProjectionCoordinator({ ...config, source, search: transport }).run(i, partition)).status,
  ).toBe('read');
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(257);
  expect(sizes.length).toBeGreaterThan(1);
  expect(writes).toBeGreaterThan(0);
  expect(await count(i)).toBe(257);
  expect(await checkpoint(i, partition)).toBe(1n);
}, 180_000);

test('a native structural change during a real source snapshot cannot be stamped as its source tuple or fence', async () => {
  const ids = await f.books(2);
  const partition = subjectPartition(ids[0]!);
  const { incarnation: i, config } = await target();
  let changed = false;
  let sent = 0;
  const transport: OpenSearch = {
    request: f.search.request.bind(f.search),
    async bulk<T>(...args: Parameters<OpenSearch['bulk']>) {
      sent++;
      return f.search.bulk<T>(...args);
    },
  };
  const source = {
    ...f.source,
    async read(...args: Parameters<typeof f.source.read>) {
      const snapshot = await f.source.read(...args);
      if (!changed) {
        changed = true;
        await f.merge(ids[0]!, ids[1]!);
      }
      return snapshot;
    },
  };
  await expect(
    createSubjectProjectionCoordinator({ ...config, source, search: transport }).run(i, partition),
  ).rejects.toThrow();
  expect(sent).toBe(0);
  expect(await count(i)).toBe(0);
  expect(await checkpoint(i, partition)).toBe(0n);
  expect(await slot(i, partition)).toMatchObject({ outcome: 'aborted', source: null });
}, 180_000);
