import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { readAggregate } from '../../src/rating/aggregate-effect.ts';
import { readAggregateFigure } from '../../src/rating/aggregate-read.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const questionRoute = 0x3110;
const populationRoute = 0x4211;
const targetRoute = 0x5312;
const questionId = newId(questionRoute);
const populationId = newId(populationRoute);
const targetId = newId(targetRoute);
const input = { questionId, populationId, targetId };
const earlier = '2026-10-30T10:00:00.000Z';
const later = '2026-10-30T11:00:00.000Z';
type Statement = { text: string; values: readonly unknown[]; checkout: number };
let database: GrowthDatabase;
let pool: Pool;
const statements: Statement[] = [];
const lifetimes: string[] = [];
let checkout = 0;

beforeAll(async () => {
  database = await openGrowthDatabase();
  // A nested acquisition cannot succeed. The normal reader must release each
  // preparation snapshot, and the PoolClient path must keep its caller's checkout.
  pool = database.openPool({ max: 1, connectionTimeoutMillis: 500 });
  pool.on('acquire', () => {
    checkout++;
    lifetimes.push(`acquire:${checkout}`);
  });
  pool.on('release', () => lifetimes.push(`release:${checkout}`));
  pool.on('connect', (client) => {
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((query: string | QueryConfig, ...args: unknown[]) => {
      const text = typeof query === 'string' ? query : query.text;
      const values = (typeof query === 'string' ? args[0] : query.values) as unknown[] | undefined;
      if (/\bFROM\s+(?:rating\.|core\.partition\b)/i.test(text))
        statements.push({ text, values: values ?? [], checkout });
      if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(text)) lifetimes.push(text.split(/\s+/)[0]!.toUpperCase());
      return original(query, ...args);
    }) as PoolClient['query'];
  });
  await database.admin.query(
    `INSERT INTO rating.question (id, revision, label, grain, minimum_units, maximum_units, step_units)
     VALUES ($1, 1, 'Anchored scale', 'work', 2, 10, 2)`,
    [questionId],
  );
  await database.admin.query(
    'INSERT INTO rating.population_pending(route, population_id, pending_jobs) VALUES ($1, $2, 1)',
    [populationRoute, populationId],
  );
  await component(targetId, 0, 2n, 8n, [0n, 2n, 0n, 0n, 0n], later);
  await component(targetId, 15, 3n, 30n, [0n, 0n, 0n, 0n, 3n], earlier);
});

afterAll(async () => {
  await database?.close();
});

function resetTrace() {
  statements.length = 0;
  lifetimes.length = 0;
}

async function component(target: string, shard: number, count: bigint, sum: bigint, histogram: bigint[], at = earlier) {
  await database.admin.query(
    `INSERT INTO rating.aggregate_component
       (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
     VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8::bigint[], $9)`,
    [targetRoute, questionId, populationId, target, shard, String(count), String(sum), histogram.map(String), at],
  );
}

function expectAnchors(address = input) {
  expect(statements).toHaveLength(6);
  const homes = [questionRoute, populationRoute, targetRoute].map(partitionOf);
  expect(new Set(homes).size).toBe(3);
  const relations = ['question', 'population_pending', 'aggregate_component'];
  for (let index = 0; index < 3; index++) {
    const binding = statements[index * 2]!;
    const data = statements[index * 2 + 1]!;
    expect(binding.text).toMatch(/FROM core\.partition\b/);
    expect(binding.values).toEqual([homes[index]]);
    expect(data.checkout).toBe(binding.checkout);
    expect(data.text).toContain(`FROM rating.${relations[index]}`);
    expect(data.text).not.toMatch(/\bJOIN\b/i);
    expect(data.text.match(/\brating\.[a-z_]+/g)).toEqual([`rating.${relations[index]}`]);
  }
  expect(statements[1]!.values).toEqual([address.questionId]);
  expect(statements[3]!.values).toEqual([populationRoute, address.populationId]);
  expect(statements[5]!.values).toEqual([targetRoute, address.questionId, address.populationId, address.targetId]);
}

test('The default rating aggregate read obtains question scale, population freshness and target components through separate anchored statements without joining foreign homes or changing its public figure', async () => {
  resetTrace();
  // Real default figure -> public readAggregate export -> dedicated reader -> pg.
  // Native bigint, text[] and timestamp decoding are exercised without a reader override.
  expect(await readAggregateFigure(pool, input)).toEqual({
    population: populationId,
    count: 5,
    mean: 7.6,
    histogram: [0, 2, 0, 0, 3],
    freshness: { asOf: later, updating: true },
  });
  expectAnchors();
  const acquisitions = statements.filter((_, index) => index % 2 === 0).map((row) => row.checkout);
  expect(new Set(acquisitions).size).toBe(3);
  expect(lifetimes).toEqual(acquisitions.flatMap((id) => [`acquire:${id}`, 'BEGIN', 'COMMIT', `release:${id}`]));
});

test('unknown questions return null before foreign preparation, and empty targets retain their question scale and observed freshness', async () => {
  const absent = { ...input, questionId: newId(questionRoute) };
  for (const read of [readAggregate, readAggregateFigure]) {
    resetTrace();
    expect(await read(pool, absent)).toBeNull();
    expect(statements).toHaveLength(2);
    expect(statements[0]!.values).toEqual([partitionOf(questionRoute)]);
    expect(statements[1]!.values).toEqual([absent.questionId]);
  }
  const empty = { ...input, targetId: newId(targetRoute) };
  resetTrace();
  expect(await readAggregate(pool, empty)).toEqual({
    count: 0n,
    sum: 0n,
    histogram: [0n, 0n, 0n, 0n, 0n],
    appliedAt: null,
    updating: true,
  });
  expectAnchors(empty);
  expect(await readAggregateFigure(pool, empty)).toEqual({
    population: populationId,
    count: 0,
    freshness: { asOf: null, updating: true },
  });
  const noPending = { ...empty, populationId: newId(populationRoute) };
  expect(await readAggregateFigure(pool, noPending)).toEqual({
    population: noPending.populationId,
    count: 0,
    freshness: { asOf: null, updating: false },
  });
  const zero = newId(targetRoute);
  await component(zero, 0, 0n, 0n, [0n, 0n, 0n, 0n, 0n]);
  expect(await readAggregateFigure(pool, { ...input, targetId: zero })).toEqual({
    population: populationId,
    count: 0,
    freshness: { asOf: earlier, updating: true },
  });
  await database.admin.query(
    'UPDATE rating.population_pending SET pending_jobs = 0 WHERE route = $1 AND population_id = $2',
    [populationRoute, populationId],
  );
  try {
    expect((await readAggregateFigure(pool, input))?.freshness).toEqual({ asOf: later, updating: false });
  } finally {
    await database.admin.query(
      'UPDATE rating.population_pending SET pending_jobs = 1 WHERE route = $1 AND population_id = $2',
      [populationRoute, populationId],
    );
  }
});

test('native bigint histograms and sums stay exact beyond the JavaScript safe range, with the newest shard time selected', async () => {
  const target = newId(targetRoute);
  const large = 9_007_199_254_740_993n;
  await component(target, 0, large, large * 2n, [large, 0n, 0n, 0n, 0n], later);
  await component(target, 15, 1n, 10n, [0n, 0n, 0n, 0n, 1n]);
  const aggregate = await readAggregate(pool, { ...input, targetId: target });
  expect(aggregate).toEqual({
    count: large + 1n,
    sum: large * 2n + 10n,
    histogram: [large, 0n, 0n, 0n, 1n],
    appliedAt: aggregate!.appliedAt,
    updating: true,
  });
  expect(new Date(aggregate!.appliedAt!).toISOString()).toBe(later);
  await expect(readAggregateFigure(pool, { ...input, targetId: target })).rejects.toThrow('outside the safe range');
  const incompatible = newId(targetRoute);
  await component(incompatible, 0, 1n, 2n, [1n]);
  await expect(readAggregate(pool, { ...input, targetId: incompatible })).rejects.toThrow('histogram scale mismatch');
});

test('the existing default and explicit grain thresholds keep the same figure shape', async () => {
  for (const count of [1, 5, 10]) {
    const target = newId(targetRoute);
    await component(target, 0, BigInt(count), BigInt(count * 6), [0n, 0n, BigInt(count), 0n, 0n]);
    for (const grain of ['work', 'release', 'episode', 'character'] as const) {
      const threshold = grain === 'work' || grain === 'release' ? 5 : 10;
      const figure = await readAggregateFigure(pool, { ...input, targetId: target, grain });
      expect(figure).toEqual({
        population: populationId,
        count,
        ...(count < threshold ? { remaining: threshold - count } : { mean: 6, histogram: [0, 0, count, 0, 0] }),
        freshness: { asOf: earlier, updating: true },
      });
    }
  }
});

test('PoolClient and query-only snapshot callers retain their transaction without a nested checkout or transaction control', async () => {
  resetTrace();
  await withReadTransaction(pool, async (client) => {
    expect((await readAggregateFigure(client, input))?.count).toBe(5);
    expectAnchors();
    expect(new Set(statements.map((row) => row.checkout)).size).toBe(1);
    expect(lifetimes).toEqual([`acquire:${checkout}`, 'BEGIN']);
    resetTrace();
    expect((await readAggregate({ query: client.query.bind(client) }, input))?.sum).toBe(38n);
    expectAnchors();
    expect(lifetimes).toEqual([]);
    resetTrace();
    // The supported executor reuses only its own live physical snapshot while
    // every logical home still receives its separate partition binding.
    expect((await readAggregateFigure(pool, input))?.count).toBe(5);
    expectAnchors();
    expect(lifetimes).toEqual([]);
  });
  expect(lifetimes).toEqual(['COMMIT', `release:${checkout}`]);
});

test('invalid addresses issue no statements and a moved home cannot masquerade as an empty aggregate', async () => {
  for (const field of ['questionId', 'populationId', 'targetId']) {
    resetTrace();
    await expect(readAggregate(pool, { ...input, [field]: 'invalid' })).rejects.toBeInstanceOf(TypeError);
    expect(statements).toEqual([]);
  }
  const movedQuestionHome = 0x6410;
  const partition = partitionOf(movedQuestionHome);
  const original = (
    await database.admin.query('SELECT write_state, moved_to FROM core.partition WHERE partition_no = $1', [partition])
  ).rows[0]!;
  await database.admin.query(
    "UPDATE core.partition SET write_state = 'moved', moved_to = 'https://rating.test' WHERE partition_no = $1",
    [partition],
  );
  try {
    resetTrace();
    await expect(readAggregate(pool, { ...input, questionId: newId(movedQuestionHome) })).rejects.toMatchObject({
      reason: 'moved',
      partition,
    });
    expect(statements).toHaveLength(1);
    expect(lifetimes).toEqual([`acquire:${checkout}`, 'BEGIN', 'ROLLBACK', `release:${checkout}`]);
  } finally {
    await database.admin.query('UPDATE core.partition SET write_state = $2, moved_to = $3 WHERE partition_no = $1', [
      partition,
      original.write_state,
      original.moved_to,
    ]);
  }
});

test('separate aggregate reads keep six point statements and at most sixteen components as unrelated populations and targets grow', async () => {
  const target = newId(targetRoute);
  for (let shard = 0; shard < 16; shard++) await component(target, shard, 1n, 6n, [0n, 0n, 1n, 0n, 0n]);
  const address = { ...input, targetId: target };
  const report = await checkGrowth(database, {
    name: 'anchored aggregate unrelated populations and targets',
    scales: [64, 256, 1024],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (db, scale, previous) => {
      await db.admin.query(
        `INSERT INTO rating.aggregate_component
           (route, question_id, population_id, target_id, shard, count, sum, histogram, applied_at)
         SELECT $1::integer, $2::uuid, ('00000000-0000-7000-8000-4211' || lpad(to_hex(n), 8, '0'))::uuid,
                $3::uuid, shard, 1, 6, ARRAY[0,0,1,0,0]::bigint[], $4::timestamptz
         FROM generate_series($5::int + 1, $6::int) n CROSS JOIN generate_series(0,15) shard
         UNION ALL
         SELECT $1::integer, $2::uuid, $7::uuid, ('00000000-0000-7000-8000-5312' || lpad(to_hex(n), 8, '0'))::uuid,
                shard, 1, 6, ARRAY[0,0,1,0,0]::bigint[], $4::timestamptz
         FROM generate_series($5::int + 1, $6::int) n CROSS JOIN generate_series(0,15) shard`,
        [targetRoute, questionId, target, earlier, previous, scale, populationId],
      );
      await db.admin.query(
        `INSERT INTO rating.population_pending(route, population_id, pending_jobs)
         SELECT $1, ('00000000-0000-7000-8000-4211' || lpad(to_hex(n), 8, '0'))::uuid, 1
         FROM generate_series($2::int + 1, $3::int) n`,
        [populationRoute, previous, scale],
      );
    },
    operation: async () => {
      resetTrace();
      expect(await readAggregateFigure(pool, address)).toEqual({
        population: populationId,
        count: 16,
        mean: 6,
        histogram: [0, 0, 16, 0, 0],
        freshness: { asOf: earlier, updating: true },
      });
      expectAnchors(address);
    },
    repetitions: 2,
  });
  for (const { cost } of report.samples) {
    expect(cost.statements).toBe(6);
    const componentCosts = Object.entries(cost.relations).filter(([name]) => name.endsWith('aggregate_component'));
    expect(componentCosts.length).toBeGreaterThan(0);
    expect(componentCosts.reduce((sum, [, value]) => sum + value.rows, 0)).toBeLessThanOrEqual(16);
    for (const [, value] of componentCosts) expect(value.sequentialScans).toBe(0);
  }
}, 600_000);
