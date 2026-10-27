import {afterAll,beforeAll,expect,test} from 'bun:test';
import {openGrowthDatabase,type GrowthDatabase} from '../support/growth.ts';
let db:GrowthDatabase;
beforeAll(async()=>{db=await openGrowthDatabase();});afterAll(async()=>{await db?.close();});
test('type preparation separates immutable source binding from resumable native progress',async()=>{
 const tables=(await db.admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema='library'")).rows.map(r=>r.table_name);for(const name of ['type_preparation_header','type_preparation_progress','type_preparation_slot'])expect(tables).toContain(name);
 const columns=(await db.admin.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='library' AND table_name='type_preparation_progress'")).rows;for(const name of ['chunk','byte_offset'])expect(columns.some(r=>r.column_name===name&&r.data_type==='bigint')).toBe(true);
 const index=(await db.admin.query("SELECT indexname FROM pg_indexes WHERE schemaname='library'")).rows.map(r=>r.indexname);expect(index).toContain('type_preparation_pending');
 const payload=(await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='library' AND table_name='type_preparation_header'")).rows.map(r=>r.column_name);expect(payload).not.toContain('input_bytes');expect(payload).not.toContain('full_type');
});
