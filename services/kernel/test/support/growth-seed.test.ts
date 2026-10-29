import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openGrowthDatabase, type GrowthDatabase } from './growth.ts';
import { placement, seed, type Population } from './growth-seed.ts';

let database: GrowthDatabase;
let pool: GrowthDatabase['pool'];
const schemas = ['growth_seed_test', 'growth_seed_cumulative_a', 'growth_seed_cumulative_b', 'growth_seed_write'];

beforeAll(async () => {
  database = await openGrowthDatabase();
  pool = database.pool;
  for (const schema of schemas) {
    await database.admin.query(`CREATE SCHEMA ${schema}`);
    await database.admin.query(`CREATE TABLE ${schema}.parent (
      route integer NOT NULL, id integer NOT NULL, payload jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (route, id)
    )`);
    await database.admin.query(`CREATE TABLE ${schema}.child (
      route integer NOT NULL, id integer NOT NULL, parent_id integer NOT NULL, PRIMARY KEY (route, id),
      FOREIGN KEY (route, parent_id) REFERENCES ${schema}.parent (route, id)
    )`);
  }
});

afterAll(async () => {
  for (const schema of schemas) await database.admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await database.close();
});

function rows(schema: string, name = schema): Population {
  return {
    name,
    hotPartition: 23,
    rows: ({ ordinal, route }) => ({
      [`${schema}.parent`]: [{ route, id: ordinal }],
      [`${schema}.child`]: [{ route, id: ordinal, parent_id: ordinal }],
    }),
  };
}

test('places the declared share of ordinals in the hot partition and spreads the rest elsewhere', () => {
  const population: Population = { name: 'placement', hotPartition: 9, hotShare: 0.5 };
  const values = Array.from({ length: 1_000 }, (_, ordinal) => placement(population, ordinal));
  expect(values.filter((value) => value.hot)).toHaveLength(500);
  expect(values.every((value) => value.hot === (value.route >>> 4 === 9))).toBe(true);
  expect(values).toEqual(Array.from({ length: 1_000 }, (_, ordinal) => placement(population, ordinal)));
});

test('inserts the rows of each ordinal range once, in table order, and refreshes planner statistics', async () => {
  const population = rows('growth_seed_test');
  await seed({ pool, admin: database.admin }, population, { from: 0, to: 20 });
  const parents = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM growth_seed_test.parent');
  const children = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM growth_seed_test.child');
  expect(parents.rows[0]!.count).toBe('20');
  expect(children.rows[0]!.count).toBe('20');
  const stats = await pool.query<{ reltuples: number }>(
    `SELECT reltuples FROM pg_class WHERE oid = 'growth_seed_test.parent'::regclass`,
  );
  expect(stats.rows[0]!.reltuples).toBe(20);
});

test('grows cumulatively: seeding 0..8n after 0..n equals seeding 0..8n at once', async () => {
  await seed({ pool, admin: database.admin }, rows('growth_seed_cumulative_a', 'cumulative'), { from: 0, to: 10 });
  await seed({ pool, admin: database.admin }, rows('growth_seed_cumulative_a', 'cumulative'), { from: 10, to: 80 });
  await seed({ pool, admin: database.admin }, rows('growth_seed_cumulative_b', 'cumulative'), { from: 0, to: 80 });
  const counts = async (schema: string) =>
    pool.query<{ partition: number; count: string }>(
      `SELECT route / 16 AS partition, count(*)::int AS count FROM ${schema}.parent GROUP BY 1 ORDER BY 1`,
    );
  expect((await counts('growth_seed_cumulative_a')).rows).toEqual((await counts('growth_seed_cumulative_b')).rows);
});

test('seeds through a production write path when the population supplies write', async () => {
  let calls = 0;
  const population: Population = {
    name: 'write',
    hotPartition: 4,
    write: async ({ pool: writePool }, { ordinal, route }) => {
      calls++;
      await writePool.query('INSERT INTO growth_seed_write.parent (route, id) VALUES ($1, $2)', [route, ordinal]);
    },
  };
  await seed({ pool, admin: database.admin }, population, { from: 0, to: 12 });
  expect(calls).toBe(12);
  expect((await pool.query('SELECT count(*)::int AS count FROM growth_seed_write.parent')).rows[0]!.count).toBe(12);
});

test('rejects rows whose columns differ within a table or name an invalid table', async () => {
  const mismatched: Population = {
    name: 'mismatched',
    hotPartition: 1,
    rows: ({ ordinal, route }) => ({ 'growth_seed_test.parent': [ordinal === 0 ? { route, id: ordinal } : { route }] }),
  };
  await expect(seed({ pool, admin: database.admin }, mismatched, { from: 0, to: 2 })).rejects.toThrow();
  const invalid: Population = { name: 'invalid', hotPartition: 1, rows: () => ({ 'bad-name.parent': [{ id: 1 }] }) };
  await expect(seed({ pool, admin: database.admin }, invalid, { from: 0, to: 1 })).rejects.toThrow();
  expect((await pool.query('SELECT count(*)::int AS count FROM growth_seed_test.parent')).rows[0]!.count).toBe(20);
});
