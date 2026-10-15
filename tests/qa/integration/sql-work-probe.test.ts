import { expect, test } from 'bun:test';
import pg from 'pg';
import { meterSqlReadWork, prepareSqlReadWork } from './support/sql-read-work.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';

test('SQL work evidence includes a stored function scan and counts rejected rows', async () => {
  await prepareSqlReadWork();
  const meter = meterSqlReadWork(() => true);
  const client = new pg.Client({ connectionString: process.env.ACCESS_DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.ACCESS_DATABASE_URL });
  const content = new pg.Pool({ connectionString: process.env.CONTENT_DATABASE_URL });
  await client.connect();
  try {
    await migrateContent(content);
    await client.query('CREATE TEMP TABLE growth_probe AS SELECT generate_series(1,100) AS n');
    await client.query(`CREATE FUNCTION pg_temp.scan_growth_probe() RETURNS bigint LANGUAGE plpgsql AS $$
      BEGIN RETURN (SELECT count(*) FROM growth_probe WHERE n=1); END $$`);
    const measured = await meter.measure(() => client.query('SELECT pg_temp.scan_growth_probe()'));
    expect(measured.work.plans.length).toBeGreaterThan(1);
    expect(measured.work.rowsTouched).toBe(100);
    expect(measured.work.statements).toBe(1);
    const pooled = await meter.measure(() => pool.query('SELECT * FROM access.realm_directory d LIMIT 1'));
    expect(pooled.work.plans).toHaveLength(1);
    const connected = await pool.connect();
    try {
      await connected.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const transaction = await meter.measure(() => connected.query('SELECT * FROM access.realm_directory d LIMIT 1'));
      expect(transaction.work.plans).toHaveLength(1);
      await connected.query('COMMIT');
    } finally { connected.release(); }
  } finally { await client.end(); await pool.end(); await content.end(); meter.restore(); }
});
