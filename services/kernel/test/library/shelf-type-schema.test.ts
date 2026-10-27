import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => { db = await openGrowthDatabase(); });
afterAll(async () => { await db?.close(); });
test('dictionary keys are bounded and owner scoped with retained terminals', async () => {
  const result = await db.admin.query<{table_name:string}>("SELECT table_name FROM information_schema.tables WHERE table_schema='library' AND table_name LIKE 'shelf_type_%'");
  for (const name of ['shelf_type_value','shelf_type_root','shelf_type_node','shelf_type_reservation']) expect(result.rows.map(r=>r.table_name)).toContain(name);
  const route=0x6a10, owner=newId(route), parent=newId(route);
  await db.admin.query('INSERT INTO library.shelf_type_node(route,account_id,node_id,parent_id,chunk) VALUES($1,$2,$3,$4,$5)',[route,owner,newId(route),parent,Buffer.alloc(256,65)]);
  await expect(db.admin.query('INSERT INTO library.shelf_type_node(route,account_id,node_id,parent_id,chunk) VALUES($1,$2,$3,$4,$5)',[route,owner,newId(route),parent,Buffer.alloc(257,66)])).rejects.toMatchObject({code:'23514'});
  await expect(db.admin.query('INSERT INTO library.shelf_type_node(route,account_id,node_id,parent_id,chunk) VALUES($1,$2,$3,$4,$5)',[route+16,owner,newId(route),parent,Buffer.from('a')])).rejects.toMatchObject({code:'23514'});
});
test('dictionary full values have no invented identifier cap', async () => {
  const route=0x6a20, owner=newId(route), key=newId(route), full='schema:'+ 'A'.repeat(131072);
  await db.admin.query('INSERT INTO library.shelf_type_value(route,account_id,type_id,full_type,byte_length,json_byte_length) VALUES($1,$2,$3,$4,octet_length($4::text),octet_length(to_json($4::text)::text))',[route,owner,key,full]);
  const result=await db.admin.query<{full_type:string}>('SELECT full_type FROM library.shelf_type_value WHERE route=$1 AND account_id=$2 AND type_id=$3',[route,owner,key]);
  expect(result.rows[0]?.full_type).toBe(full);
});
