import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import {
  capture,
  catalogStatementBound,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  withoutCatalogStatements,
  type GrowthCheck,
  type GrowthDatabase,
} from './growth.ts';

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

test('Reylo freshness probes are set apart without a bound however often they repeat', async () => {
  const database = db!;
  await reset(database);
  const pool = database.openPool({ max: 2 });
  const clients = [await pool.connect(), await pool.connect()];
  const probeQueries = [
    `SELECT r.relname AS fresh_table, a.attname::text AS fresh_column,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS fresh_type
       FROM pg_catalog.pg_class AS r
       JOIN pg_catalog.pg_attribute AS a ON a.attrelid = r.oid
      WHERE a.attnum > 0 AND r.oid = $1::regclass`,
    `SELECT r.relname AS    FRESH_TABLE, a.attname::text AS fresh_column,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS fresh_type
       FROM pg_catalog.pg_class AS r
       JOIN pg_catalog.pg_attribute AS a ON a.attrelid = r.oid
      WHERE a.attnum > 0 AND r.oid = $1::regclass`,
    `SELECT r.relname AS fresh_table, a.attname::text AS fresh_column,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS FRESH_TYPE
       FROM pg_catalog.pg_class AS r
       JOIN pg_catalog.pg_attribute AS a ON a.attrelid = r.oid
      WHERE a.attnum > 0 AND r.oid = $1::regclass`,
  ];
  const dataQueries = [
    `SELECT payload FROM ${table} WHERE id = $1`,
    `SELECT id FROM ${table} WHERE id = $1`,
    `SELECT payload FROM ${table} WHERE id > $1 LIMIT 1`,
  ];

  try {
    const measured = await capture(
      database,
      async () => {
        await Promise.all([
          (async () => {
            await clients[0]!.query(dataQueries[0]!, [1]);
            for (const query of probeQueries) {
              await clients[0]!.query(query, [`${schema}.records`]);
              await clients[0]!.query(query, [`${schema}.records`]);
            }
          })(),
          (async () => {
            await clients[1]!.query(dataQueries[1]!, [1]);
            await clients[1]!.query(dataQueries[2]!, [1]);
            for (const query of probeQueries) await clients[1]!.query(query, [`${schema}.records`]);
          })(),
        ]);
      },
      { includeBackends: true },
    );

    const classification = catalogStatementBound(measured.capture);
    expect(classification).toMatchObject({ catalogStatements: 0, freshnessProbes: 9, allowedStatements: 3 });
    expect(new Set(measured.capture.statementBackends).size).toBe(2);

    const kept = withoutCatalogStatements('freshness probe capture', measured.capture);
    expect(kept.statements).toEqual(dataQueries);
    expect(kept.plans).toHaveLength(3);
  } finally {
    for (const client of clients) client.release();
  }
}, 60_000);

test('a statement with the probe columns that reads a data relation counts in full', () => {
  const query = `SELECT id AS fresh_table, payload AS fresh_column, id::text AS fresh_type
                 FROM public.records`;
  const captured = {
    statements: [query],
    plans: [
      [
        {
          'Query Text': query,
          Plan: {
            'Node Type': 'Seq Scan',
            Schema: 'public',
            'Relation Name': 'records',
            'Actual Rows': 1,
            'Actual Loops': 1,
            'Shared Hit Blocks': 1,
            'Shared Read Blocks': 0,
          },
        },
      ],
    ],
  };

  expect(catalogStatementBound(captured)).toMatchObject({
    catalogStatements: 0,
    freshnessProbes: 0,
    allowedStatements: 1,
  });
  expect(costOf(captured)).toMatchObject({
    statements: 1,
    plans: 1,
    rows: 1,
    relations: { 'public.records': expect.anything() },
  });
  expect(withoutCatalogStatements('mixed relation capture', captured).statements).toEqual([query]);
});

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

test('a capture outside checkGrowth is held to the same catalog bound', async () => {
  const database = db!;
  await reset(database);
  await seed(database, 1, 0);
  const columns = `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`;

  const bounded = await capture(database, () =>
    withConnection(database.pool, async (client) => {
      await client.query(`SELECT payload FROM ${table} WHERE id = $1`, [1]);
      await client.query(columns, [schema, 'records']);
    }),
  );
  expect(bounded.capture.statements).toHaveLength(2);
  const kept = withoutCatalogStatements('catalog capture', bounded.capture);
  expect(kept.statements).toEqual([`SELECT payload FROM ${table} WHERE id = $1`]);
  expect(kept.plans).toHaveLength(1);

  const perRow = await capture(database, () =>
    withConnection(database.pool, async (client) => {
      const result = await client.query<{ id: number }>(`SELECT id FROM ${table} WHERE id <= $1`, [3]);
      for (const _row of result.rows) await client.query(columns, [schema, 'records']);
    }),
  );
  expect(() => withoutCatalogStatements('catalog capture', perRow.capture)).toThrow(
    expect.objectContaining({
      name: 'GrowthBoundError',
      message: expect.stringMatching(/catalog capture: catalog count \(\d+\) exceeds allowed count 1;/),
    }),
  );
}, 60_000);
