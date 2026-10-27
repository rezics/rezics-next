import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => { db = await openGrowthDatabase(); });
afterAll(async () => { await db?.close(); });
test('shelf heads counts stamps and bounded indexes exist', async () => {
  const columns = await db.admin.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='library' AND table_name='entry'",
  );
  const names = columns.rows.map(row => row.column_name);
  for (const name of ['activity_at','finished_at','type_id','type_source_id','type_source_partition','type_source_epoch','type_source_position','incarnation_id']) expect(names).toContain(name);
  const tables = await db.admin.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='library' AND table_name IN ('progress_head','shelf_count')",
  );
  expect(tables.rows.map(row => row.table_name).sort()).toEqual(['progress_head','shelf_count']);
  const session = await db.admin.query<{ data_type: string }>(
    "SELECT data_type FROM information_schema.columns WHERE table_schema='library' AND table_name='progress_session' AND column_name='last_changed_at'",
  );
  expect(session.rows[0]?.data_type).toBe('timestamp with time zone');
  const indexes = await db.admin.query<{ indexname: string; indexdef: string }>(
    "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='library'",
  );
  for (const key of ['activity','finished','created']) for (const suffix of ['', '_state','_type','_state_type']) {
    expect(indexes.rows.some(row => row.indexname === `entry_shelf_${key}${suffix}`)).toBe(true);
  }
  for (const name of ['entry_type_source','progress_session_active','shelf_count_types']) expect(indexes.rows.some(row => row.indexname === name)).toBe(true);
  const active = indexes.rows.find(row => row.indexname === 'progress_session_active')!.indexdef;
  expect(active).toContain('last_changed_at DESC');
  expect(active).toContain("state = 'active'");
});
test('shelf private keys reject a foreign owner route and negative counts', async () => {
  const route = 0x6a10;
  const owner = newId(route);
  const subject = newId(0x7b20);
  await db.admin.query('INSERT INTO library.progress_head(route,account_id,subject_id) VALUES($1,$2,$3)', [route,owner,subject]);
  await expect(db.admin.query('INSERT INTO library.progress_head(route,account_id,subject_id) VALUES($1,$2,$3)', [route+16,owner,newId(0x7b20)])).rejects.toMatchObject({ code: '23514' });
  await expect(db.admin.query("INSERT INTO library.shelf_count(route,account_id,bucket,type_id,n) VALUES($1,$2,'all','00000000-0000-0000-0000-000000000000',-1)", [route,owner])).rejects.toMatchObject({ code: '23514' });
});
