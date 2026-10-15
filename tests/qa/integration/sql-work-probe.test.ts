import { expect, test } from 'bun:test';
import pg from 'pg';
import { meterSqlReadWork, prepareSqlReadWork } from './support/sql-read-work.ts';
import { RealmReplyThreadStore } from '../../../services/main/src/modules/realm-reply/thread-store.ts';
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
    const threads = new RealmReplyThreadStore(content,pool);
    expect(await threads.subtree('https://rezics.com/id/00000000-0000-4000-8000-000000000001')).toEqual([]);
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
    // Both directory generations receive deltas. Each end-day rank drops
    // exactly the source days outside its seven-day window, and epochs stay separate.
    await client.query('BEGIN');
    try {
      await client.query(`INSERT INTO access.realm_growth_day(realm,day,data_epoch,members,posts) VALUES
        ('rolling-growth-probe',current_date-6,'',3,0),
        ('rolling-growth-probe',current_date,'epoch-a',0,5),
        ('rolling-growth-probe',current_date,'epoch-b',0,7)`);
      for (const generation of [0,1]) await client.query(`INSERT INTO access.realm_directory
        (generation,realm,space,created,activity,search_text,count_kind,count_value,growth_epoch)
        VALUES($1,'rolling-growth-probe','probe-space',0,0,'','exact',0,'epoch-a')`,[generation]);
      const ranks = async (generation: number) => (await client.query<{ growth: string }>(
        'SELECT growth::text FROM access.realm_directory_growth WHERE realm=$1 AND generation=$2 ORDER BY day',
        ['rolling-growth-probe',generation])).rows.map(row => Number(row.growth));
      expect(await ranks(0)).toEqual([8,5,5,5,5,5,5]);
      await client.query(`UPDATE access.realm_growth_day SET posts=9 WHERE realm='rolling-growth-probe' AND data_epoch='epoch-a'`);
      expect(await ranks(0)).toEqual([12,9,9,9,9,9,9]);
      expect(await ranks(1)).toEqual(await ranks(0));
      await client.query(`DELETE FROM access.realm_growth_day WHERE realm='rolling-growth-probe' AND data_epoch=''`);
      expect(await ranks(0)).toEqual([9,9,9,9,9,9,9]);
      await client.query(`UPDATE access.realm_directory SET growth_epoch='epoch-b' WHERE realm='rolling-growth-probe' AND generation=1`);
      expect(await ranks(1)).toEqual([7,7,7,7,7,7,7]);
      expect(await ranks(0)).toEqual([9,9,9,9,9,9,9]);
    } finally { await client.query('ROLLBACK'); }
  } finally { await client.end(); await pool.end(); await content.end(); meter.restore(); }
});
