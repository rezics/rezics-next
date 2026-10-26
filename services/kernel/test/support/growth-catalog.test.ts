import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, type GrowthCheck, type GrowthDatabase } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_catalog_test';
const table = `${schema}.records`;
const rowsPerScale = 500;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;

let db: GrowthDatabase | undefined;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, payload text NOT NULL)`);
});

afterAll(async () => {
  if (!db) return;
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

async function reset(database: GrowthDatabase): Promise<void> {
  await database.admin.query(`TRUNCATE ${table}`);
}

async function seed(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  const from = previous * rowsPerScale + 1;
  const to = scale * rowsPerScale;
  await database.admin.query(
    `INSERT INTO ${table} (id, payload)
     SELECT id, 'seeded' FROM generate_series($1::integer, $2::integer) AS id`,
    [from, to],
  );
}

function growthCheck(operation: GrowthCheck['operation']): GrowthCheck {
  return {
    name: 'catalog growth',
    bounds,
    grow: (database, scale, previous) => seed(database, scale, previous),
    operation,
  };
}

test('catalog-only statements are counted apart and one refresh per query passes', async () => {
  const database = db!;
  await reset(database);
  const report = await checkGrowth(
    database,
    growthCheck((growthDb, scale) =>
      withConnection(growthDb.pool, async (client) => {
        await client.query(`SELECT payload FROM ${table} WHERE id = $1`, [1]);
        if (scale === 64)
          await client.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
            [schema, 'records'],
          );
      }),
    ),
  );

  expect(report.samples.map(({ cost }) => cost.catalogStatements)).toEqual([0, 0, 1]);
  expect(report.samples.map(({ cost }) => cost.statements)).toEqual([1, 1, 1]);
  expect(report.samples.map(({ cost }) => cost.rows)).toEqual([1, 1, 1]);
}, 60_000);

test('a catalog read per row fails the check', async () => {
  const database = db!;
  await reset(database);

  await expect(
    checkGrowth(database, {
      ...growthCheck((growthDb) =>
        withConnection(growthDb.pool, async (client) => {
          const result = await client.query<{ id: number }>(`SELECT id FROM ${table}`);
          for (const _row of result.rows)
            await client.query('SELECT relname FROM pg_catalog.pg_class WHERE oid = $1::regclass', [
              `${schema}.records`,
            ]);
          return result.rowCount;
        }),
      ),
      repetitions: 1,
    }),
  ).rejects.toMatchObject({
    name: 'GrowthBoundError',
    message: expect.stringContaining('catalog count'),
  });
}, 60_000);
