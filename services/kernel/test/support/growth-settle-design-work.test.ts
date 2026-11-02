import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openGrowthDatabase, settle, type GrowthDatabase } from './growth.ts';

const schema = 'growth_settle_design_work_test';
const relation = `${schema}.rows`;
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase();
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${relation} (id integer PRIMARY KEY) WITH (autovacuum_enabled = false)`);
});

afterAll(async () => {
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

test('Growth setup does not require or inspect invisible tuple versions as bounded design work', async () => {
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  const before = await db.admin.query<{ vacuumCount: number }>(
    `SELECT vacuum_count::integer AS "vacuumCount" FROM pg_stat_user_tables WHERE relid=$1::regclass`,
    [relation],
  );
  const originalQuery = db.admin.query.bind(db.admin);
  const statements: string[] = [];
  db.admin.query = ((...args: Parameters<typeof db.admin.query>) => {
    const query = args[0] as unknown as string | { text: string };
    statements.push(typeof query === 'string' ? query : query.text);
    return originalQuery(...args);
  }) as typeof db.admin.query;
  try {
    await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect((await holder.query(`SELECT count(*)::integer AS count FROM ${relation}`)).rows[0]!.count).toBe(0);
    await db.admin.query(`INSERT INTO ${relation} VALUES (1)`);

    await settle(db, { relations: [relation], analyze: true, timeoutMs: 250 });

    expect((await holder.query(`SELECT count(*)::integer AS count FROM ${relation}`)).rows[0]!.count).toBe(0);
    expect((await db.admin.query(`SELECT count(*)::integer AS count FROM ${relation}`)).rows[0]!.count).toBe(1);
    const after = await db.admin.query<{ vacuumCount: number }>(
      `SELECT vacuum_count::integer AS "vacuumCount" FROM pg_stat_user_tables WHERE relid=$1::regclass`,
      [relation],
    );
    expect(after.rows[0]!.vacuumCount).toBe(before.rows[0]!.vacuumCount + 1);
    expect(statements.some((sql) => /pg_visibility|pg_check_visible|\bctid\b|\bxmin\b|\bxmax\b/i.test(sql))).toBe(
      false,
    );
  } finally {
    db.admin.query = originalQuery;
    await holder.query('ROLLBACK');
    await holder.end();
  }
});
