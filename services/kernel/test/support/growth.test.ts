import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import {
  checkGrowth,
  GrowthBoundError,
  measure,
  openGrowthDatabase,
  placement,
  seed,
  type GrowthCheck,
  type GrowthDatabase,
  type Population,
} from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_api_test';
const table = `${schema}.records`;
const ordinalsPerScale = 500;
const population: Population = {
  name: 'growth-api',
  hotPartition: 37,
  hotShare: 1,
  rows: ({ ordinal, route }) => ({
    [table]: [{ route, id: ordinal + 1, payload: { group: 'seeded' } }],
  }),
};
const anchor = placement(population, 0);
let db: GrowthDatabase | undefined;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${table} (
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

async function reset(database: GrowthDatabase): Promise<void> {
  await database.admin.query(`TRUNCATE ${table}`);
  await database.admin.query(`INSERT INTO ${table} (route, id, payload) VALUES ($1, 0, $2)`, [
    anchor.route,
    { group: 'anchor' },
  ]);
}

function check(database: GrowthDatabase, operation: GrowthCheck['operation'], bounds: GrowthCheck['bounds']) {
  return checkGrowth(database, {
    name: 'growth table scan',
    rule: 'step',
    bounds,
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, {
        from: previous * ordinalsPerScale,
        to: scale * ordinalsPerScale,
      });
    },
    operation,
  });
}

test('a primary-key point read passes constant rows and logarithmic blocks as the table grows', async () => {
  const database = db!;
  await reset(database);
  const report = await check(
    database,
    (growthDb) =>
      withConnection(growthDb.pool, async (client) => {
        const result = await client.query(`SELECT payload FROM ${table} WHERE route = $1 AND id = 0`, [anchor.route]);
        return result.rows[0]?.payload;
      }),
    { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
  );
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  expect(report.samples.every(({ cost }) => cost.rows === 1)).toBe(true);
}, 60_000);

test('an unindexed payload filter fails logarithmic rows and reports the table evidence', async () => {
  const database = db!;
  await reset(database);
  await expect(
    check(
      database,
      (growthDb) =>
        withConnection(growthDb.pool, async (client) => {
          const result = await client.query(`SELECT id FROM ${table} WHERE payload->>'group' = 'seeded'`);
          return result.rowCount;
        }),
      { rows: 'logarithmic', blocks: 'linear', statements: 'constant' },
    ),
  ).rejects.toMatchObject({
    name: 'GrowthBoundError',
    violations: expect.arrayContaining([expect.objectContaining({ metric: 'rows' })]),
    message: expect.stringContaining(table),
  });
}, 60_000);

test('restricting an unindexed filter to the hot partition routes still exposes partition scans', async () => {
  const database = db!;
  await reset(database);
  const routes = Array.from({ length: 16 }, (_, index) => population.hotPartition * 16 + index);
  await expect(
    check(
      database,
      (growthDb) =>
        withConnection(growthDb.pool, async (client) => {
          const result = await client.query(
            `SELECT id FROM ${table} WHERE route = ANY($1::integer[]) AND payload->>'group' = 'seeded'`,
            [routes],
          );
          return result.rowCount;
        }),
      { rows: 'logarithmic', blocks: 'linear', statements: 'constant' },
    ),
  ).rejects.toMatchObject({
    name: 'GrowthBoundError',
    violations: expect.arrayContaining([expect.objectContaining({ metric: 'rows' })]),
  });
}, 60_000);

test('measure counts request statements through the production pool', async () => {
  const database = db!;
  const result = await measure(database, () =>
    withConnection(database.pool, async (client) => {
      await client.query('BEGIN');
      await client.query('SELECT 41 AS answer');
      await client.query('SELECT 42 AS answer');
      await client.query('COMMIT');
    }),
  );
  expect(result.cost).toMatchObject({ statements: 2, controlStatements: 2 });
}, 60_000);

test('a linear-in-change operation passes linear and fails constant bounds', async () => {
  const database = db!;
  await reset(database);
  const operation: GrowthCheck['operation'] = (growthDb, scale, repetition) =>
    withConnection(growthDb.pool, async (client) => {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ${table} (route, id, payload)
         SELECT $1, $2 + n, $4 FROM generate_series(0, $3 - 1) AS n`,
        [anchor.route, 1_000_000 + repetition * 100_000, scale, { group: 'change' }],
      );
      await client.query(`SELECT id FROM ${table} WHERE payload->>'group' = 'change'`);
      await client.query('ROLLBACK');
    });
  const bounds = { rows: 'linear', blocks: 'linear', statements: 'constant' } as const;
  const report = await checkGrowth(database, {
    name: 'linear write',
    grow: async () => {},
    operation,
    bounds,
    repetitions: 1,
  });
  expect(report.samples.map(({ cost }) => cost.rows)).toEqual([2, 9, 65]);

  await expect(
    checkGrowth(database, {
      name: 'constant write',
      grow: async () => {},
      operation,
      bounds: { ...bounds, rows: 'constant' },
      repetitions: 1,
    }),
  ).rejects.toBeInstanceOf(GrowthBoundError);
});

test('a growth check owns its database through hooks and releases ownership after failure', async () => {
  const database = db!;
  let startGrow!: () => void;
  let releaseGrow!: () => void;
  const started = new Promise<void>((resolve) => (startGrow = resolve));
  const gate = new Promise<void>((resolve) => (releaseGrow = resolve));
  let overlappingHookRan = false;
  const makeCheck = (target: GrowthDatabase, grow: Parameters<typeof checkGrowth>[1]['grow']) =>
    checkGrowth(target, {
      name: 'growth ownership regression',
      scales: [1, 8, 64],
      repetitions: 1,
      bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
      grow,
      operation: async () => {},
    });
  const first = makeCheck(database, async () => {
    startGrow();
    await gate;
    throw new Error('first grow failed');
  });
  const firstFailure = expect(first).rejects.toThrow('first grow failed');
  await started;

  let independent: GrowthDatabase | undefined;
  try {
    await expect(makeCheck(database, async () => { overlappingHookRan = true; })).rejects.toThrow(
      'A growth check is already active for this database',
    );
    independent = await openGrowthDatabase(databaseUrl);
    await expect(makeCheck(independent, async () => { throw new Error('independent check ran'); })).rejects.toThrow(
      'independent check ran',
    );
  } finally {
    releaseGrow();
    await independent?.close();
  }

  await firstFailure;
  expect(overlappingHookRan).toBe(false);
  await expect(makeCheck(database, async () => { throw new Error('ownership released'); })).rejects.toThrow(
    'ownership released',
  );
}, 60_000);
