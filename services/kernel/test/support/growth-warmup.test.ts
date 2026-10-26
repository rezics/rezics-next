import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, type GrowthCheck, type GrowthDatabase, type GrowthReport } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_warmup_test';
const probes = `${schema}.probes`;
const catalog = `${schema}.catalog`;
const route = 1;
const spareProbe = 1_000_000;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;

type Call = { readonly kind: 'warmup' | 'operation'; readonly scale: number; readonly repetition: number };

let db: GrowthDatabase | undefined;
let cold = true;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${probes} (
    route integer NOT NULL,
    id integer NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (route, id)
  )`);
  await db.admin.query(`CREATE TABLE ${catalog} (
    route integer NOT NULL,
    id integer NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (route, id)
  )`);
});

afterAll(async () => {
  if (!db) return;
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

function record(calls: Call[], kind: Call['kind']): GrowthCheck['operation'] {
  return async (_database, scale, repetition) => {
    calls.push({ kind, scale, repetition });
  };
}

test('checkGrowth refuses fewer than one warm-up per scale and names the warmup hook', async () => {
  const calls: string[] = [];
  await expect(
    checkGrowth(db!, {
      name: 'zero warm-ups',
      warmups: 0,
      bounds,
      grow: async () => {
        calls.push('grow');
      },
      operation: async () => {
        calls.push('operation');
      },
    }),
  ).rejects.toMatchObject({ name: 'RangeError', message: expect.stringContaining('warmup') });
  expect(calls).toEqual([]);
});

test('a warmup hook runs in place of the operation for every unmeasured run', async () => {
  const calls: Call[] = [];
  await checkGrowth(db!, {
    name: 'warmup in place of the operation',
    warmups: 2,
    repetitions: 2,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {},
    warmup: record(calls, 'warmup'),
    operation: record(calls, 'operation'),
  });
  expect(calls).toEqual([
    { kind: 'warmup', scale: 1, repetition: 0 },
    { kind: 'warmup', scale: 1, repetition: 1 },
    { kind: 'operation', scale: 1, repetition: 2 },
    { kind: 'operation', scale: 1, repetition: 3 },
    { kind: 'warmup', scale: 8, repetition: 4 },
    { kind: 'warmup', scale: 8, repetition: 5 },
    { kind: 'operation', scale: 8, repetition: 6 },
    { kind: 'operation', scale: 8, repetition: 7 },
    { kind: 'warmup', scale: 64, repetition: 8 },
    { kind: 'warmup', scale: 64, repetition: 9 },
    { kind: 'operation', scale: 64, repetition: 10 },
    { kind: 'operation', scale: 64, repetition: 11 },
  ]);
});

test('without a warmup hook the unmeasured runs call the operation as before', async () => {
  const calls: Call[] = [];
  await checkGrowth(db!, {
    name: 'unmeasured runs call the operation',
    warmups: 2,
    repetitions: 2,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {},
    operation: record(calls, 'operation'),
  });
  expect(calls).toEqual([
    { kind: 'operation', scale: 1, repetition: 0 },
    { kind: 'operation', scale: 1, repetition: 1 },
    { kind: 'operation', scale: 1, repetition: 2 },
    { kind: 'operation', scale: 1, repetition: 3 },
    { kind: 'operation', scale: 8, repetition: 4 },
    { kind: 'operation', scale: 8, repetition: 5 },
    { kind: 'operation', scale: 8, repetition: 6 },
    { kind: 'operation', scale: 8, repetition: 7 },
    { kind: 'operation', scale: 64, repetition: 8 },
    { kind: 'operation', scale: 64, repetition: 9 },
    { kind: 'operation', scale: 64, repetition: 10 },
    { kind: 'operation', scale: 64, repetition: 11 },
  ]);
});

/** The first call in the process reads one extra catalog row, standing in for a cold backend start. */
async function consume(database: GrowthDatabase, id: number): Promise<void> {
  await withConnection(database.pool, async (client) => {
    if (cold) {
      cold = false;
      await client.query(`SELECT payload FROM ${catalog} WHERE route = $1 AND id = 0`, [route]);
    }
    const deleted = await client.query(`DELETE FROM ${probes} WHERE route = $1 AND id = $2`, [route, id]);
    if (deleted.rowCount !== 1) throw new Error(`probe ${id} was not consumed`);
  });
}

async function seed(database: GrowthDatabase): Promise<void> {
  cold = true;
  await database.admin.query(`TRUNCATE ${probes}, ${catalog}`);
  await database.admin.query(
    `INSERT INTO ${catalog} (route, id, payload)
     SELECT $1::integer, n, CASE WHEN n = 0 THEN $2::jsonb ELSE $3::jsonb END
     FROM generate_series(0, 499) AS n`,
    [route, { pad: 'x'.repeat(64 * 1024) }, { group: 'catalog' }],
  );
  await database.admin.query(
    `INSERT INTO ${probes} (route, id, payload)
     SELECT $1::integer, n, $2::jsonb FROM generate_series(0, 499) AS n`,
    [route, { group: 'probe' }],
  );
  await database.admin.query(
    `INSERT INTO ${probes} (route, id, payload)
     SELECT $1::integer, $2::integer + n, $3::jsonb FROM generate_series(0, 15) AS n`,
    [route, spareProbe, { group: 'spare' }],
  );
  await database.admin.query(`ANALYZE ${probes}`);
  await database.admin.query(`ANALYZE ${catalog}`);
}

function probeCheck(database: GrowthDatabase, warmup?: GrowthCheck['warmup']): Promise<GrowthReport> {
  return checkGrowth(database, {
    name: warmup ? 'warmed probe read' : 'cold probe read',
    repetitions: 1,
    ...(warmup ? { warmup } : { warmups: 0 }),
    bounds,
    grow: async () => {},
    operation: (growthDb, _scale, repetition) => consume(growthDb, repetition),
  });
}

test('a first run that costs more than later runs reaches no sample once each scale is warmed', async () => {
  const database = db!;
  await seed(database);
  const coldReport = await probeCheck(database);

  await seed(database);
  const warmReport = await probeCheck(database, (growthDb, _scale, repetition) =>
    consume(growthDb, spareProbe + repetition),
  );

  expect(coldReport.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  expect(coldReport.samples.map(({ cost }) => cost.rows)).toEqual([2, 1, 1]);
  expect(coldReport.samples.map(({ cost }) => cost.statements)).toEqual([2, 1, 1]);
  const coldBlocks = coldReport.samples[0]!.cost.blocks;
  const warmBaseline = coldReport.samples[1]!.cost.blocks;
  expect(coldBlocks).toBeGreaterThan(warmBaseline);
  expect(coldReport.samples[0]!.cost.relations?.[catalog]?.blocks).toBeGreaterThan(0);
  expect(coldReport.samples[1]!.cost.relations?.[catalog]).toBeUndefined();
  expect(coldReport.samples[2]!.cost.relations?.[catalog]).toBeUndefined();

  expect(warmReport.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  expect(warmReport.samples.map(({ cost }) => cost.rows)).toEqual([1, 1, 1]);
  expect(warmReport.samples.map(({ cost }) => cost.statements)).toEqual([1, 1, 1]);
  for (const sample of warmReport.samples) {
    expect(sample.cost.blocks).toBeGreaterThanOrEqual(warmBaseline - 1);
    expect(sample.cost.blocks).toBeLessThanOrEqual(warmBaseline + 1);
    expect(sample.cost.blocks).toBeLessThan(coldBlocks);
    expect(sample.cost.relations?.[catalog]).toBeUndefined();
    expect(sample.cost.relations?.[probes]).toMatchObject({ rows: 1, sequentialScans: 0 });
  }
}, 60_000);
