import {afterAll,beforeAll,expect,test} from 'bun:test';
import {openGrowthDatabase,type GrowthDatabase} from '../support/growth.ts';
let db:GrowthDatabase;
beforeAll(async()=>{db=await openGrowthDatabase();});
afterAll(async()=>{await db?.close();});
test('bulk target manifests and target-home evidence have distinct routed authority',async()=>{
 const tables=await db.admin.query<{table_name:string}>("SELECT table_name FROM information_schema.tables WHERE table_schema='library'");
 for(const name of ['bulk_target','bulk_effect'])expect(tables.rows.map(r=>r.table_name)).toContain(name);
 const columns=await db.admin.query<{table_name:string,column_name:string,data_type:string}>("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='library' AND table_name IN ('bulk_target','bulk_effect')");
 for(const table of ['bulk_target','bulk_effect'])expect(columns.rows.some(r=>r.table_name===table&&r.column_name==='ordinal'&&r.data_type==='bigint')).toBe(true);
 expect(columns.rows.some(r=>r.table_name==='bulk_effect'&&r.column_name==='target_anchor_id')).toBe(true);
 const indexes=await db.admin.query<{indexname:string}>("SELECT indexname FROM pg_indexes WHERE schemaname='library'");
 for(const name of ['bulk_target_subject','bulk_target_occurrence','bulk_target_state','bulk_target_pending','bulk_effect_expiry'])expect(indexes.rows.map(r=>r.indexname)).toContain(name);
});
