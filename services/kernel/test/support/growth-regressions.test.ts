import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from './growth.ts';
import { captureWarmup } from './growth-capture.ts';
import { statementOccurrences } from './growth-report.ts';
import { seed, type Population } from './growth-seed.ts';

const schema = 'growth_regressions_test';
const table = `${schema}.written`;
const cloneName = `growth_regressions_${Bun.randomUUIDv7().replaceAll('-', '').slice(0, 16)}`;
let db: GrowthDatabase;
let cloneUrl: string;
let clonePool: pg.Pool;
let cloneAdmin: pg.Pool;

beforeAll(async () => {
  db = await openGrowthDatabase();
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, payload text NOT NULL)`);
  const clone = new URL(db.url);
  clone.pathname = `/${cloneName}`;
  cloneUrl = clone.toString();
  await db.admin.query(`CREATE DATABASE "${cloneName}"`);
  cloneAdmin = new pg.Pool({ connectionString: cloneUrl, max: 2 });
  await cloneAdmin.query(`CREATE SCHEMA ${schema}`);
  await cloneAdmin.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, payload text NOT NULL)`);
  await cloneAdmin.query(`INSERT INTO ${table} SELECT i, repeat('x', 100) FROM generate_series(1, 3000) i`);
  clonePool = db.openPool({ max: 2 });
  clonePool.options.connectionString = cloneUrl;
});

afterAll(async () => {
  if (!db) return;
  await cloneAdmin?.end();
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
  const cleanup = new pg.Pool({ connectionString: db.url, max: 1 });
  try {
    await cleanup.query(`DROP DATABASE IF EXISTS "${cloneName}" WITH (FORCE)`);
  } finally {
    await cleanup.end();
  }
});

test('a warmup capture is allowed and its writes settle before the first measured repetition', async () => {
  let id = 10_000;
  const vacuumBeforeWarmup = new Map<number, number>();
  await checkGrowth(db, {
    name: 'nested warmup capture settles',
    scales: [1, 4, 16],
    repetitions: 1,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {},
    warmup: async (database, scale) => {
      const before = await cloneAdmin.query<{ vacuumCount: number }>(
        `SELECT vacuum_count::integer AS "vacuumCount" FROM pg_stat_user_tables WHERE relid=$1::regclass`,
        [table],
      );
      vacuumBeforeWarmup.set(scale, before.rows[0]!.vacuumCount);
      await capture(database, async () => {
        await clonePool.query(`INSERT INTO ${table} VALUES ($1, repeat('w', 100))`, [id++]);
      });
    },
    operation: async (_database, scale) => {
      const result = await cloneAdmin.query<{ vacuumCount: number }>(
        `SELECT vacuum_count::integer AS "vacuumCount" FROM pg_stat_user_tables WHERE relid=$1::regclass`,
        [table],
      );
      expect(result.rows[0]!.vacuumCount).toBeGreaterThanOrEqual(vacuumBeforeWarmup.get(scale)! + 1);
    },
  });
});

test('same-database measured nesting rejects before child effects and preserves the parent capture', async () => {
  const sentinelId = 1_000_000 + Math.floor(Math.random() * 1_000_000);
  let childCalls = 0;
  const parent = await capture(db, async () => {
    await db.pool.query('SELECT 431 AS parent_before_rejected_child');
    await expect(
      capture(db, async () => {
        childCalls++;
        await db.pool.query(`INSERT INTO ${table} VALUES ($1, 'nested child ran')`, [sentinelId]);
      }),
    ).rejects.toThrow('A growth capture is already active for this database');
    await db.pool.query('SELECT 432 AS parent_after_rejected_child');
  });

  expect(childCalls).toBe(0);
  const sentinel = await db.admin.query(`SELECT id FROM ${table} WHERE id = $1`, [sentinelId]);
  expect(sentinel.rows).toEqual([]);
  expect(parent.capture.statements).toEqual([
    'SELECT 431 AS parent_before_rejected_child',
    'SELECT 432 AS parent_after_rejected_child',
  ]);
  expect(parent.capture.plans).toHaveLength(2);
  expect(parent.capture.planStatements).toEqual([0, 1]);
  const occurrences = statementOccurrences(parent.capture).statements;
  expect(occurrences.map(({ statement }) => statement)).toEqual([
    'SELECT ? AS parent_before_rejected_child',
    'SELECT ? AS parent_after_rejected_child',
  ]);
  expect(occurrences.map(({ plans }) => plans)).toEqual([[0], [1]]);
  expect(occurrences.flatMap(({ planDocuments }) => planDocuments)).toEqual([...parent.capture.plans]);

  const independent = await capture(db, () => db.pool.query('SELECT 433 AS independent_after_rejected_child'));
  expect(independent.capture.statements).toEqual(['SELECT 433 AS independent_after_rejected_child']);
  expect(independent.capture.plans).toHaveLength(1);
});

test('checkGrowth rejects an operation that opens a measured capture on its database', async () => {
  let operationCalls = 0;
  let nestedCallbackCalls = 0;
  await expect(
    checkGrowth(db, {
      name: 'measured operation opens a nested capture',
      scales: [1, 4, 16],
      warmups: 1,
      repetitions: 1,
      bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
      grow: async () => {},
      async operation(database) {
        operationCalls++;
        await capture(database, async () => {
          nestedCallbackCalls++;
          await database.pool.query('SELECT 434 AS nested_measured_operation');
        });
      },
    }),
  ).rejects.toThrow('A growth capture is already active for this database');
  expect(operationCalls).toBe(2);
  expect(nestedCallbackCalls).toBe(1);
});

test('captureWarmup cannot replace an active measured parent or enter nested child work', async () => {
  const sentinelId = 2_000_000 + Math.floor(Math.random() * 1_000_000);
  let warmupCalls = 0;
  let nestedCaptureCalls = 0;
  const parent = await capture(db, async () => {
    await db.pool.query('SELECT 435 AS measured_parent_before_warmup');
    await expect(
      captureWarmup(db, async () => {
        warmupCalls++;
        await capture(db, async () => {
          nestedCaptureCalls++;
          await db.pool.query(`INSERT INTO ${table} VALUES ($1, 'nested warmup ran')`, [sentinelId]);
        });
      }),
    ).rejects.toThrow('A growth capture is already active for this database');
    await db.pool.query('SELECT 436 AS measured_parent_after_warmup');
  });

  expect(warmupCalls).toBe(0);
  expect(nestedCaptureCalls).toBe(0);
  const sentinel = await db.admin.query(`SELECT id FROM ${table} WHERE id = $1`, [sentinelId]);
  expect(sentinel.rows).toEqual([]);
  expect(parent.capture.statements).toEqual([
    'SELECT 435 AS measured_parent_before_warmup',
    'SELECT 436 AS measured_parent_after_warmup',
  ]);
  expect(parent.capture.plans).toHaveLength(2);
});

test('writes through a connection to another database settle there, not by relation name in the growth database', async () => {
  let id = 20_000;
  const vacuumBeforeWarmup = new Map<number, number>();
  await checkGrowth(db, {
    name: 'other database write targets',
    scales: [1, 4, 16],
    repetitions: 2,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {},
    warmup: async (_database, scale) => {
      const before = await cloneAdmin.query<{ vacuumCount: number }>(
        `SELECT vacuum_count::integer AS "vacuumCount" FROM pg_stat_user_tables WHERE relid=$1::regclass`,
        [table],
      );
      vacuumBeforeWarmup.set(scale, before.rows[0]!.vacuumCount);
      await clonePool.query(`INSERT INTO ${table} VALUES ($1, 'warmup')`, [id++]);
    },
    operation: async (_database, scale, repetition) => {
      const state = await cloneAdmin.query<{ vacuumCount: number }>(
        `SELECT vacuum_count::integer AS "vacuumCount" FROM pg_stat_user_tables WHERE relid=$1::regclass`,
        [table],
      );
      expect(state.rows[0]!.vacuumCount).toBeGreaterThanOrEqual(vacuumBeforeWarmup.get(scale)! + repetition + 1);
      await clonePool.query(`INSERT INTO ${table} VALUES ($1, 'other database')`, [id++]);
    },
  });
});

test('seed settles an admin pool handed out by openPool', async () => {
  const admin = db.openPool({ max: 2 });
  const before = await db.admin.query<{ vacuumCount: number }>(
    `SELECT vacuum_count::integer AS "vacuumCount" FROM pg_stat_user_tables WHERE relid=$1::regclass`,
    [table],
  );
  await seed(
    { pool: admin, admin },
    {
      name: 'open pool seed',
      hotPartition: 4,
      rows: ({ ordinal }) => ({ [table]: [{ id: 40_000 + ordinal, payload: 'seeded' }] }),
    },
    { from: 0, to: 8 },
  );
  const result = await db.admin.query<{ count: string; pages: number; vacuumCount: number }>(
    `SELECT (SELECT count(*)::text FROM ${table} WHERE id >= 40000) AS count,
            c.relpages AS pages,s.vacuum_count::integer AS "vacuumCount"
       FROM pg_class c JOIN pg_stat_user_tables s ON s.relid=c.oid WHERE c.oid=$1::regclass`,
    [table],
  );
  expect(result.rows[0]!.count).toBe('8');
  expect(result.rows[0]!.pages).toBeGreaterThan(0);
  expect(result.rows[0]!.vacuumCount).toBeGreaterThanOrEqual(before.rows[0]!.vacuumCount + 1);
});

test('seed settles a redirected database handed out by openPool', async () => {
  const before = await cloneAdmin.query<{ vacuumCount: number }>(
    `SELECT vacuum_count::integer AS "vacuumCount" FROM pg_stat_user_tables WHERE relid=$1::regclass`,
    [table],
  );
  const population: Population = {
    name: 'external pool seed',
    hotPartition: 4,
    rows: ({ ordinal }) => ({ [table]: [{ id: 30_000 + ordinal, payload: 'seeded' }] }),
  };
  await seed({ pool: clonePool, admin: clonePool }, population, { from: 0, to: 8 });
  const rows = await cloneAdmin.query<{ count: string; vacuumCount: number }>(
    `SELECT (SELECT count(*)::text FROM ${table} WHERE id >= 30000) AS count,
            s.vacuum_count::integer AS "vacuumCount"
       FROM pg_class c JOIN pg_stat_user_tables s ON s.relid=c.oid WHERE c.oid=$1::regclass`,
    [table],
  );
  expect(rows.rows[0]!.count).toBe('8');
  expect(rows.rows[0]!.vacuumCount).toBeGreaterThanOrEqual(before.rows[0]!.vacuumCount + 1);
});

test('a measured backend holding its transaction across repetitions fails immediately with commit guidance', async () => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const backend = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const report = await checkGrowth(db, {
      name: 'operation transaction spans repetitions',
      scales: [1, 4, 16],
      repetitions: 2,
      bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
      grow: async () => {},
      async operation() {
        await client.query(
          `INSERT INTO ${table} VALUES (900001, 'held') ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload`,
        );
      },
    });
    const failures = report.samples.flatMap(({ settleFailures }) => settleFailures ?? []);
    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some(
        (failure) =>
          failure.includes(`Backend ${backend} from the measured operation`) &&
          failure.includes('each repetition must commit'),
      ),
    ).toBe(true);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
