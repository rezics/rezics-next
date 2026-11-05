import { afterAll, beforeAll, expect, test } from 'bun:test';
import { BATCH_ENVELOPES } from '../../src/events/log.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createCoverageStore } from '../../src/search/coverage-store.ts';
import {
  createSubjectProjectionCoordinator,
  initializeSubjectIncarnation,
  type IndexIncarnation,
  type ProjectionOptions,
} from '../../src/search/coverage.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { createCoverageFixture, holdBulk } from './coverage-fixture.ts';

// Population proves actual engine keys and durable progress, without certification or alias publication.
let f: Awaited<ReturnType<typeof createCoverageFixture>>;
beforeAll(async () => {
  f = await createCoverageFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 180_000);

async function checkpoints(target: IndexIncarnation) {
  return (
    await f.admin.query<{ partition_no: number; epoch: number; position: string }>(
      `SELECT partition_no, epoch, position::text FROM core.consumer_checkpoint
       WHERE consumer=$1 ORDER BY partition_no`,
      [target.consumer],
    )
  ).rows;
}

async function keys(target: IndexIncarnation) {
  const response = await f.search.request<{
    timed_out: boolean;
    _shards: { failed: number };
    hits: { hits: { _id: string; _source: { id: string } }[] };
  }>('POST', `/${target.index}/_search`, { size: 1000, sort: [{ id: 'asc' }], query: { match_all: {} } });
  expect(response.body.timed_out).toBe(false);
  expect(response.body._shards.failed).toBe(0);
  for (const hit of response.body.hits.hits) expect(hit._source.id).toBe(hit._id);
  return response.body.hits.hits.map((hit) => hit._id);
}

async function populate(config: ProjectionOptions, target: IndexIncarnation) {
  const deadline = Date.now() + 120_000;
  let steps = 0;
  for (;;) {
    if (Date.now() >= deadline) throw new Error('Bounded population failed to finish its durable frontier');
    const store = createCoverageStore(f.pool);
    const before = (await store.readLineage(target))!;
    expect(before).not.toBeNull();
    const priorCheckpoints = await checkpoints(target);
    // Reconstruct both owners every step: progress must live in the DB, not a closure-local cursor.
    const result = await createSubjectProjectionCoordinator(config).populate(target);
    const after = (await createCoverageStore(f.pool).readLineage(target))!;
    expect(after).not.toBeNull();
    expect(after.partition).toBeGreaterThanOrEqual(before.partition);
    if (after.partition === before.partition && before.after !== null)
      expect(after.after !== null && after.after >= before.after).toBe(true);
    if (result.state === 'complete') {
      expect(after).toMatchObject({ partition: 4096, after: null, complete: true });
      return steps + 1;
    }
    expect(after.complete).toBe(false);
    expect(after.revision).toBeGreaterThanOrEqual(before.revision);
    expect(
      after.partition > before.partition ||
        after.after !== before.after ||
        JSON.stringify(await checkpoints(target)) !== JSON.stringify(priorCheckpoints),
      'A more result must persist actual replay/audit progress',
    ).toBe(true);
    if (++steps > 16_384) throw new Error('Population did not advance through its bounded home/keyset schedule');
  }
}

test('bounded bootstrap persists and resumes a complete real source/event frontier with exact stored IDs', async () => {
  const ids = await f.books(70);
  const prefix = f.fresh();
  const config = f.options(prefix);
  const target = await initializeSubjectIncarnation(config, 1);
  const store = createCoverageStore(f.pool);
  expect((await store.readLineage(target))!.complete).toBe(false);
  expect(await keys(target)).toEqual([]);
  expect(await populate(config, target)).toBeGreaterThan(1);
  const actual = await keys(target);
  expect(actual.filter((id) => ids.includes(id))).toEqual(ids);
  for (const partition of new Set(ids.map(subjectPartition))) {
    const head = (
      await f.admin.query<{ epoch: number; position: string }>(
        'SELECT epoch, position::text FROM core.partition WHERE partition_no=$1',
        [partition],
      )
    ).rows[0]!;
    let result;
    do {
      result = await createSubjectProjectionCoordinator(config).run(target, partition);
      if (result.status === 'read') expect(result.envelopes).toBeLessThanOrEqual(BATCH_ENVELOPES);
    } while (result.status === 'read' && result.envelopes > 0);
    expect(result.status).toBe('read');
    const checkpoint = (await checkpoints(target)).find((row) => row.partition_no === partition)!;
    expect(checkpoint.epoch).toBe(head.epoch);
    expect(BigInt(checkpoint.position)).toBeGreaterThanOrEqual(BigInt(head.position));
    const home = (await store.readHome(target, partition))!;
    expect(home.attempt).toMatchObject({ outcome: 'completed', checkpoint: 'advanced' });
    expect(home.attempt!.source).not.toBeNull();
    expect(home.attempt!.through.position).toBeLessThanOrEqual(BigInt(checkpoint.position));
  }
  expect((await store.readLineage(target))!.complete).toBe(true);
}, 180_000);

test('population honors the unchanged source256 cap and waits for actual source chunks and engine completion', async () => {
  const ids = await f.books(257);
  const first = ids[0];
  await expect(
    f.source.read(
      subjectPartition(first),
      Array.from({ length: 257 }, () => newId(routeOf(first)!)),
    ),
  ).rejects.toThrow();
  const observed: number[] = [];
  const gate = holdBulk(f.search);
  const prefix = f.fresh();
  const config: ProjectionOptions = {
    ...f.options(prefix, gate.transport),
    source: {
      ...f.source,
      async read(partition, requested) {
        observed.push(requested.length);
        expect(requested.length).toBeLessThanOrEqual(256);
        return f.source.read(partition, requested);
      },
    },
  };
  const target = await initializeSubjectIncarnation(config, 1);
  const pending = populate(config, target).then(
    (steps) => ({ steps }),
    (error: unknown) => ({ error }),
  );
  try {
    await Promise.race([
      gate.entered,
      pending.then(() => {
        throw new Error('Population finished before reaching its real engine write');
      }),
    ]);
    expect((await createCoverageStore(f.pool).readLineage(target))!.complete).toBe(false);
    expect((await keys(target)).filter((id) => ids.includes(id))).toEqual([]);
  } finally {
    gate.release();
    const result = await pending;
    if ('error' in result) throw result.error;
  }
  expect(observed.length).toBeGreaterThan(0);
  expect((await keys(target)).filter((id) => ids.includes(id))).toEqual(ids);
  // A fresh coordinator sees exactly the committed terminal frontier; no supplied source facts or tuples.
  expect(await createSubjectProjectionCoordinator(config).populate(target)).toEqual({ state: 'complete' });
}, 180_000);

test('a retained creation-log gap stops replay without checkpoint jumps or complete population', async () => {
  const [id] = await f.books(1);
  const partition = subjectPartition(id);
  const row = (
    await f.admin.query<{ position: string }>(
      'SELECT position::text FROM core.outbox WHERE partition_no=$1 AND subject=$2 ORDER BY position LIMIT 1',
      [partition, id],
    )
  ).rows[0]!;
  expect(row).toBeDefined();
  const prefix = f.fresh();
  const config = f.options(prefix);
  const target = await initializeSubjectIncarnation(config, 1);
  // Simulate retention on one real committed envelope; restore exactly those rows in finally.
  const removed = await f.admin.query<{ saved: unknown }>(
    'DELETE FROM core.outbox WHERE partition_no=$1 AND position=$2 RETURNING to_jsonb(core.outbox.*) AS saved',
    [partition, row.position],
  );
  expect(removed.rows.length).toBeGreaterThan(0);
  try {
    const coordinator = createSubjectProjectionCoordinator(config);
    const deadline = Date.now() + 30_000;
    let result;
    do {
      if (Date.now() >= deadline) throw new Error('Replay failed to observe the retained-log gap');
      result = await coordinator.run(target, partition);
    } while (result.status === 'busy' || (result.status === 'read' && result.envelopes > 0));
    expect(result).toMatchObject({ status: 'stopped', reason: 'gap' });
    if (result.status !== 'stopped') throw new Error('Replay crossed a missing creation envelope');
    expect(result.position).toBeLessThan(BigInt(row.position));
    for (const checkpoint of (await checkpoints(target)).filter((point) => point.partition_no === partition))
      expect(BigInt(checkpoint.position)).toBeLessThan(BigInt(row.position));
    expect((await createCoverageStore(f.pool).readLineage(target))!.complete).toBe(false);
    let state: string;
    try {
      state = (await coordinator.populate(target)).state;
    } catch (error) {
      expect(error).toMatchObject({ code: 'index_not_ready' });
      state = 'not_ready';
    }
    expect(state).not.toBe('complete');
    expect((await createCoverageStore(f.pool).readLineage(target))!.complete).toBe(false);
  } finally {
    await f.admin.query(
      'INSERT INTO core.outbox SELECT * FROM jsonb_populate_recordset(NULL::core.outbox, $1::jsonb)',
      [JSON.stringify(removed.rows.map(({ saved }) => saved))],
    );
  }
}, 180_000);
