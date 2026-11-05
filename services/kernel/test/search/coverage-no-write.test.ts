import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createCoverageStore, type HomeGuard } from '../../src/search/coverage-store.ts';
import type { ApplyAttempt, HomeCoverage, IndexIncarnation } from '../../src/search/coverage.ts';
import { subjectIndexName } from '../../src/search/indices.ts';
import { subjectConsumer } from '../../src/search/consumer-name.ts';

// Staged implementation acceptance: real migrated DB/pool, no mock SQL or store.
// Synthetic durable observations exercise storage only, never native readiness evidence.
const pool = createPool(process.env.DATABASE_URL!);
const store = createCoverageStore(pool);
afterAll(() => pool.end());
const large = 9007199254740993n;
const current = { partition: 7, epoch: 1, home: 'b', generation: large };
const point = { epoch: 1, position: large };
const fence = { ...point, generation: large };
const observation = { current, fence, coveredThrough: point };
const results = [
  { outcome: 'aborted', checkpoint: 'pending' },
  { outcome: 'skipped', checkpoint: 'advanced' },
  { outcome: 'skipped', checkpoint: 'lost' },
  { outcome: 'skipped', checkpoint: 'stopped' },
] as const;
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
async function target(live = false): Promise<HomeGuard> {
  const prefix = `no-write-${crypto.randomUUID().slice(0, 8)}-`;
  const control = await store.allocate(prefix, 0n, 1);
  expect(control).not.toBeNull();
  const incarnation: IndexIncarnation = {
    prefix,
    generation: 1,
    index: subjectIndexName(prefix, 1),
    uuid: crypto.randomUUID(),
    protocol: 'subject-coverage-v1',
    consumer: subjectConsumer(prefix, 1),
  };
  let lineage = await store.register(control!, incarnation, 'created-empty');
  expect(lineage).not.toBeNull();
  if (live) {
    lineage = await store.population(
      { incarnation, lineageRevision: lineage!.revision },
      {
        partition: 4096,
        after: null,
        complete: true,
      },
    );
    lineage = await store.transition({ incarnation, lineageRevision: lineage!.revision }, 'live');
    expect(lineage).not.toBeNull();
  }
  return { incarnation, lineageRevision: lineage!.revision, partition: 7, revision: 0n };
}
async function reopen(g: HomeGuard, row: HomeCoverage) {
  expect(await createCoverageStore(pool).readHome(g.incarnation, g.partition)).toEqual(row);
}
async function enrolled(g?: HomeGuard, slot = attempt()) {
  const guard = g ?? (await target());
  const row = await store.enroll(guard, slot);
  expect(row).not.toBeNull();
  await reopen(guard, row!);
  return { guard: { ...guard, revision: row!.revision }, slot, row: row! };
}
async function verified() {
  let { guard, slot } = await enrolled(await target(true));
  const visible = await store.outcome(guard, slot.id, { outcome: 'visible', source: current, fence });
  guard = { ...guard, revision: visible!.revision };
  const complete = await store.complete(guard, slot.id, 'advanced');
  guard = { ...guard, revision: complete!.revision };
  const row = await store.promote(guard, slot.id, observation);
  expect(row!.verified).toEqual(current);
  return { guard: { ...guard, revision: row!.revision }, row: row! };
}

for (const result of results) {
  test(`${result.outcome}/${result.checkpoint} settles a fresh slot losslessly and permits replacement`, async () => {
    const { guard, slot, row } = await enrolled();
    const settled = await store.settleNoWrite(guard, slot.id, result);
    expect(settled).toEqual({ ...row, revision: row.revision + 1n, attempt: { ...slot, ...result } });
    await reopen(guard, settled!);
    const g = { ...guard, revision: settled!.revision };
    expect(await store.promote(g, slot.id, observation)).toBeNull();
    expect(await store.complete(g, slot.id, 'advanced')).toBeNull();
    expect(await store.outcome(g, slot.id, { outcome: 'visible', source: current, fence })).toBeNull();
    expect(await store.enroll(g, slot)).toBeNull();
    expect(await store.settleNoWrite(g, slot.id, result)).toBeNull();
    const replacement = attempt();
    const next = await store.enroll(g, replacement);
    expect(next!.revision).toBe(settled!.revision + 1n);
    expect(next!.attempt).toEqual(replacement);
    await reopen(g, next!);
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM search.index_home_coverage WHERE consumer=$1 AND index_uuid=$2',
      [g.incarnation.consumer, g.incarnation.uuid],
    );
    expect(count.rows[0].n).toBe(1);
  });

  test(`${result.outcome}/${result.checkpoint} preserves every existing certificate field without promotion`, async () => {
    const old = await verified();
    const { guard, slot, row } = await enrolled(old.guard, {
      ...attempt(),
      through: { ...point, position: large + 10n },
    });
    const settled = await store.settleNoWrite(guard, slot.id, result);
    expect(settled).toEqual({ ...row, revision: row.revision + 1n, attempt: { ...slot, ...result } });
    expect(settled!.current).toEqual(old.row.current);
    expect(settled!.fence).toEqual(old.row.fence);
    expect(settled!.verified).toEqual(old.row.verified);
    expect(settled!.coveredThrough).toEqual(old.row.coveredThrough);
    await reopen(guard, settled!);
    const g = { ...guard, revision: settled!.revision };
    expect(await store.promote(g, slot.id, observation)).toBeNull();
    const next = await store.enroll(g, attempt());
    expect(next!.verified).toEqual(old.row.verified);
    expect(next!.coveredThrough).toEqual(old.row.coveredThrough);
  });
}

test('settlement compares exact attempt, home, physical identity and both revisions atomically', async () => {
  const { guard, slot, row } = await enrolled();
  const wrongPhysical = Object.entries(guard.incarnation).map(([key, value]) => ({
    ...guard,
    incarnation: { ...guard.incarnation, [key]: typeof value === 'number' ? value + 1 : `${value}x` },
  }));
  for (const bad of [
    { ...guard, partition: 8 },
    { ...guard, revision: guard.revision - 1n },
    { ...guard, lineageRevision: guard.lineageRevision + 1n },
    ...wrongPhysical.filter((g) => g.incarnation.protocol === 'subject-coverage-v1'),
  ])
    expect(await store.settleNoWrite(bad, slot.id, results[0])).toBeNull();
  expect(await store.settleNoWrite(guard, crypto.randomUUID(), results[0])).toBeNull();
  await expect(
    store.settleNoWrite(
      { ...guard, incarnation: { ...guard.incarnation, protocol: 'unknown' } } as never,
      slot.id,
      results[0],
    ),
  ).rejects.toBeInstanceOf(TypeError);
  await reopen(guard, row);
  const raced = await Promise.all(results.slice(0, 2).map((r) => store.settleNoWrite(guard, slot.id, r)));
  expect(raced.filter(Boolean)).toHaveLength(1);
  expect(raced.find(Boolean)!.revision).toBe(row.revision + 1n);
  await reopen(guard, raced.find(Boolean)!);
  const other = await enrolled();
  const retired = await store.transition(other.guard, 'retiring');
  expect(await store.settleNoWrite(other.guard, other.slot.id, results[0])).toBeNull();
  expect(
    await store.settleNoWrite({ ...other.guard, lineageRevision: retired!.revision }, other.slot.id, results[0]),
  ).toBeNull();
  await reopen(other.guard, other.row);
});

test('ambiguous, non-null-source, visible and completed attempts cannot be relabeled no-write', async () => {
  for (const state of ['ambiguous-null', 'ambiguous-source', 'visible', 'completed'] as const) {
    let { guard, slot } = await enrolled();
    let row = await store.outcome(guard, slot.id, {
      outcome: state.startsWith('ambiguous') ? 'ambiguous' : 'visible',
      source: state === 'ambiguous-null' ? null : current,
      fence: state === 'ambiguous-null' ? null : fence,
    });
    guard = { ...guard, revision: row!.revision };
    if (state === 'completed') {
      row = await store.complete(guard, slot.id, 'advanced');
      guard = { ...guard, revision: row!.revision };
    }
    for (const result of results) expect(await store.settleNoWrite(guard, slot.id, result)).toBeNull();
    await reopen(guard, row!);
  }
});

test('visible and completed null-fence observations record real effects without fabricated promotion', async () => {
  let { guard, slot } = await enrolled(await target(true));
  const visible = await store.outcome(guard, slot.id, { outcome: 'visible', source: current, fence: null });
  expect(visible!.current).toEqual(current);
  expect(visible!.attempt).toEqual({ ...slot, source: current, outcome: 'visible' });
  expect(visible!.fence).toBeNull();
  await reopen(guard, visible!);
  guard = { ...guard, revision: visible!.revision };
  const complete = await store.complete(guard, slot.id, 'advanced');
  expect(complete!.attempt!.checkpoint).toBe('advanced');
  expect(complete!.verified).toBeNull();
  expect(complete!.coveredThrough).toBeNull();
  expect(complete!.fence).toBeNull();
  await reopen(guard, complete!);
  guard = { ...guard, revision: complete!.revision };
  expect(await store.promote(guard, slot.id, observation)).toBeNull();
  await reopen(guard, complete!);
});

test('missing new fence preserves a matching old fence but changed source clears the old certificate', async () => {
  for (const change of ['same', 'generation', 'home'] as const) {
    const changed = change !== 'same';
    const old = await verified();
    const { guard, slot } = await enrolled(old.guard);
    const source =
      change === 'home' ? { ...current, home: 'c' } : changed ? { ...current, generation: large + 1n } : current;
    const row = await store.outcome(guard, slot.id, { outcome: 'visible', source, fence: null });
    expect(row!.current).toEqual(source);
    expect(row!.fence).toEqual(changed ? null : fence);
    expect(row!.verified).toEqual(changed ? null : current);
    expect(row!.coveredThrough).toEqual(changed ? null : point);
    await reopen(guard, row!);
    const g = { ...guard, revision: row!.revision };
    const done = await store.complete(g, slot.id, 'lost');
    await reopen(g, done!);
    if (changed)
      expect(
        await store.promote({ ...g, revision: done!.revision }, slot.id, { ...observation, current: source }),
      ).toBeNull();
  }
});

test('no-write result is a closed discriminated shape and malformed combinations reject without writes', async () => {
  const { guard, slot, row } = await enrolled();
  for (const bad of [
    { outcome: 'aborted', checkpoint: 'advanced' },
    { outcome: 'aborted', checkpoint: 'lost' },
    { outcome: 'aborted', checkpoint: 'stopped' },
    { outcome: 'skipped', checkpoint: 'pending' },
    { outcome: 'completed', checkpoint: 'advanced' },
    { outcome: 'aborted' },
    { ...results[0], source: null },
    null,
    [],
  ])
    await expect(store.settleNoWrite(guard, slot.id, bad as never)).rejects.toBeInstanceOf(TypeError);
  await reopen(guard, row);
});
