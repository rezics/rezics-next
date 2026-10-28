import { afterAll, expect, test } from 'bun:test';
import { subjectIndexName } from '../../src/search/indices.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { createPool } from '../../src/database/pool.ts';
import { createCoverageStore, type HomeGuard } from '../../src/search/coverage-store.ts';
import type { ApplyAttempt, IndexIncarnation } from '../../src/search/coverage.ts';

// The check runner supplies a real freshly migrated database. No coordinator, certificate or mock store.
const pool = createPool(process.env.DATABASE_URL!);
const store = createCoverageStore(pool);
afterAll(() => pool.end());
const large = 9007199254740993n;
const tuple = { partition: 7, epoch: 1, home: 'b', generation: large };
const point = { epoch: 1, position: large };
const fence = { ...point, generation: large };
const observation = { current: tuple, fence, coveredThrough: point };
function attempt(): ApplyAttempt {
  return {
    id: crypto.randomUUID(),
    from: { epoch: 1, position: 0n },
    through: point,
    source: null,
    outcome: 'enrolled',
    checkpoint: 'pending',
  };
}
async function target(prefix = `store-${crypto.randomUUID().slice(0, 8)}-`, generation = 1, revision = 0n) {
  const control = await store.allocate(prefix, revision, generation);
  expect(control).not.toBeNull();
  const incarnation: IndexIncarnation = {
    prefix,
    generation,
    index: subjectIndexName(prefix, generation),
    uuid: crypto.randomUUID(),
    protocol: 'subject-coverage-v1',
    consumer: subjectConsumer(prefix, generation),
  };
  const lineage = await store.register(control!, incarnation, 'created-empty');
  expect(lineage).not.toBeNull();
  return { incarnation, lineageRevision: lineage!.revision };
}
async function live() {
  let guard = await target();
  const population = await store.population(guard, { partition: 4096, after: null, complete: true });
  expect(population).not.toBeNull();
  guard = { ...guard, lineageRevision: population!.revision };
  const lineage = await store.transition(guard, 'live');
  expect(lineage).not.toBeNull();
  return { ...guard, lineageRevision: lineage!.revision, partition: 7, revision: 0n };
}
async function completed() {
  let guard: HomeGuard = await live();
  const slot = attempt();
  const enrolled = await store.enroll(guard, slot);
  guard = { ...guard, revision: enrolled!.revision };
  const visible = await store.outcome(guard, slot.id, { outcome: 'visible', source: tuple, fence });
  guard = { ...guard, revision: visible!.revision };
  const done = await store.complete(guard, slot.id, 'lost');
  expect(done!.attempt!.checkpoint).toBe('lost');
  return { guard: { ...guard, revision: done!.revision }, slot };
}

test('allocation is monotonic, CAS conditional, capped at three and never reused after reclamation', async () => {
  const first = await target();
  const { prefix } = first.incarnation;
  expect(await store.allocate(prefix, 0n, 2)).toBeNull();
  expect(await store.allocate(prefix, 1n, 1)).toBeNull();
  await target(prefix, 2, 1n);
  await target(prefix, 3, 2n);
  const fourth = await store.allocate(prefix, 3n, 4);
  expect(fourth!.issuedGeneration).toBe(4);
  expect(
    await store.register(
      fourth!,
      {
        ...first.incarnation,
        generation: 4,
        uuid: crypto.randomUUID(),
        index: subjectIndexName(prefix, 4),
        consumer: subjectConsumer(prefix, 4),
      },
      'audit',
    ),
  ).toBeNull();
  const retiring = await store.transition(first, 'retiring');
  expect(await store.reclaim({ ...first, lineageRevision: retiring!.revision })).toBe(true);
  expect(await store.readLineage(first.incarnation)).toBeNull();
  expect(await store.allocate(prefix, fourth!.revision, 1)).toBeNull();
  expect((await store.readPrefix(prefix))!.issuedGeneration).toBe(4);
});

test('exact physical identity and lifecycle CAS gate population and publication', async () => {
  const guard = await target();
  expect(await store.transition(guard, 'live')).toBeNull();
  expect(await store.readLineage({ ...guard.incarnation, uuid: crypto.randomUUID() })).toBeNull();
  expect(await store.readLineage({ ...guard.incarnation, index: 'wrong-name' })).toBeNull();
  await expect(store.readLineage({ ...guard.incarnation, protocol: 'wrong' as never })).rejects.toThrow();
  const next = await store.population(guard, { partition: 1, after: null, complete: false });
  expect(next!.revision).toBeGreaterThan(guard.lineageRevision);
  expect(
    await store.population(
      { ...guard, lineageRevision: next!.revision },
      { partition: 0, after: null, complete: false },
    ),
  ).toBeNull();
  expect(await store.population(guard, { partition: 4096, after: null, complete: true })).toBeNull();
});

test('one competing enrollment wins; pending and ambiguous attempts survive retries and reopen', async () => {
  let guard: HomeGuard = await live();
  const a = attempt(),
    b = attempt();
  const results = await Promise.all([store.enroll(guard, a), store.enroll(guard, b)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const winner = results.find(Boolean)!;
  guard = { ...guard, revision: winner.revision };
  expect(await store.enroll(guard, attempt())).toBeNull();
  expect(await store.outcome(guard, crypto.randomUUID(), { outcome: 'visible', source: tuple, fence })).toBeNull();
  const ambiguous = await store.outcome(guard, winner.attempt!.id, { outcome: 'ambiguous', source: null, fence: null });
  guard = { ...guard, revision: ambiguous!.revision };
  expect(await store.enroll(guard, attempt())).toBeNull();
  expect(await store.complete(guard, winner.attempt!.id, 'advanced')).toBeNull();
  expect(await store.promote(guard, winner.attempt!.id, observation)).toBeNull();
  expect((await createCoverageStore(pool).readHome(guard.incarnation, 7))!.attempt).toEqual(ambiguous!.attempt);
});

test('visibility, actual checkpoint outcomes and promotion require current revision and attempt ID', async () => {
  const { guard, slot } = await completed();
  expect(await store.promote({ ...guard, revision: guard.revision - 1n }, slot.id, observation)).toBeNull();
  expect(await store.promote(guard, crypto.randomUUID(), observation)).toBeNull();
  expect(
    await store.promote(guard, slot.id, { ...observation, coveredThrough: { ...point, position: large - 1n } }),
  ).toBeNull();
  expect(
    await store.promote(guard, slot.id, { ...observation, current: { ...tuple, generation: large + 1n } }),
  ).toBeNull();
  const promoted = await store.promote(guard, slot.id, observation);
  expect(promoted!.verified).toEqual(tuple);
  expect(promoted!.coveredThrough).toEqual(point);
  expect(promoted!.fence).toEqual(fence);
  const durable = await pool.query(
    'SELECT "current", fence, attempt FROM search.index_home_coverage WHERE partition_no=$1 AND consumer=$2 AND index_uuid=$3',
    [7, guard.incarnation.consumer, guard.incarnation.uuid],
  );
  expect(durable.rows[0].current.generation).toBe(large.toString());
  expect(durable.rows[0].fence.position).toBe(large.toString());
  expect(durable.rows[0].attempt.through.position).toBe(large.toString());
  const nextGuard = { ...guard, revision: promoted!.revision };
  const next = await store.enroll(nextGuard, attempt());
  expect(next!.verified).toBeNull();
  expect(await store.complete({ ...nextGuard, revision: next!.revision }, slot.id, 'advanced')).toBeNull();
  for (const checkpoint of ['advanced', 'stopped'] as const) {
    const other = await completed();
    const fresh = attempt();
    const enrolled = await store.enroll(other.guard, fresh);
    let g = { ...other.guard, revision: enrolled!.revision };
    const visible = await store.outcome(g, fresh.id, { outcome: 'visible', source: tuple, fence });
    g = { ...g, revision: visible!.revision };
    expect((await store.complete(g, fresh.id, checkpoint))!.attempt!.checkpoint).toBe(checkpoint);
  }
});

test('closed bounded shapes reject arrays, unknown fields, zero observations and invalid partitions', async () => {
  const guard = await live();
  for (const bad of [
    { ...attempt(), history: [] },
    { ...attempt(), from: [] },
    { ...attempt(), through: { epoch: 1, position: '01' } },
    { ...attempt(), id: 'not-uuid' },
    { ...attempt(), source: { ...tuple, generation: 0n } },
    { ...attempt(), through: { epoch: 1, position: 9223372036854775808n } },
  ]) {
    await expect(store.enroll(guard, bad as never)).rejects.toThrow();
  }
  for (const partition of [-1, 4096, 0.5]) await expect(store.readHome(guard.incarnation, partition)).rejects.toThrow();
  const done = await completed();
  await expect(
    store.promote(done.guard, done.slot.id, { ...observation, current: { ...tuple, epoch: 0 } }),
  ).rejects.toThrow();
  await expect(store.promote(done.guard, done.slot.id, { ...observation, current: null } as never)).rejects.toThrow();
});

test('retirement fences late publication and reclaims at most the fixed 4096 homes', async () => {
  const { guard, slot } = await completed();
  for (let partition = 0; partition < 4096; partition++) {
    if (partition !== 7) expect(await store.enroll({ ...guard, partition, revision: 0n }, attempt())).not.toBeNull();
  }
  const count = await pool.query(
    'SELECT count(*)::int AS n FROM search.index_home_coverage WHERE consumer=$1 AND index_uuid=$2',
    [guard.incarnation.consumer, guard.incarnation.uuid],
  );
  expect(count.rows[0].n).toBe(4096);
  const retiring = await store.transition(guard, 'retiring');
  expect(await store.promote(guard, slot.id, observation)).toBeNull();
  const fenced = { ...guard, lineageRevision: retiring!.revision };
  expect(await store.enroll(fenced, attempt())).toBeNull();
  expect(await store.complete(fenced, slot.id, 'advanced')).toBeNull();
  expect(await store.reclaim(guard)).toBe(false);
  expect(await store.reclaim(fenced)).toBe(true);
  expect(await store.readHome(guard.incarnation, 7)).toBeNull();
  expect(await store.enroll(guard, attempt())).toBeNull();
}, 120_000);

test('all authoritative primary keys lead partition_no and controls enforce fixed zero', async () => {
  const keys = await pool.query(`SELECT t.relname, array_agg(a.attname ORDER BY k.ordinality) AS columns
    FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ordinality)
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
    WHERE n.nspname='search' AND i.indisprimary AND t.relname IN
    ('index_prefix_control','index_incarnation','index_home_coverage') GROUP BY t.relname`);
  expect(Object.fromEntries(keys.rows.map((r) => [r.relname, r.columns]))).toEqual({
    index_prefix_control: ['partition_no', 'prefix'],
    index_incarnation: ['partition_no', 'consumer', 'index_uuid'],
    index_home_coverage: ['partition_no', 'consumer', 'index_uuid'],
  });
  const checks = await pool.query(`SELECT t.relname, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='search' AND c.contype='c' AND t.relname IN ('index_prefix_control','index_incarnation')`);
  for (const table of ['index_prefix_control', 'index_incarnation'])
    expect(checks.rows.some((r) => r.relname === table && /partition_no = 0/.test(r.definition))).toBe(true);
});
