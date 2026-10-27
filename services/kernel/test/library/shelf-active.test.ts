import {afterAll,beforeAll,expect,test} from 'bun:test';
import {newId} from '../../src/route/route.ts';
import {openGrowthDatabase,type GrowthDatabase} from '../support/growth.ts';
import {createShelfActiveReader} from '../../src/library/shelf-active.ts';
let db:GrowthDatabase;
beforeAll(async()=>{db=await openGrowthDatabase();});
afterAll(async()=>{await db?.close();});
test('active probes preserve sparse BASIC sessions and activity ties',async()=>{
 const route=0x6a10,owner=newId(route),other=newId(route),subject=newId(0x7b20),none=newId(0x7b20);
 const ids=[newId(route),newId(route)].sort();
 for(const [id,account,state,time] of [[ids[0]!,owner,'active','2026-10-27'],[ids[1]!,owner,'active','2026-10-27'],[newId(route),owner,'abandoned','2026-10-28'],[newId(route),other,'active','2026-10-29']] as const){
  await db.admin.query("INSERT INTO library.progress_session(route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,started_at,transaction_id,last_changed_at) VALUES($1,$2,$3,$4,'completed_units','chapter',3,$5,1,'2026-10-20',$6,$7)",[route,id,account,subject,state,newId(route),time]);
 }
 for(const unit of ['1','3','7']) await db.admin.query("INSERT INTO library.progress_unit(route,session_id,unit_id,added_at) VALUES($1,$2,$3,'2026-10-27')",[route,ids[0],unit]);
 const got=await createShelfActiveReader().sessions(db.admin,route,owner,[subject,none]);
 expect(got.size).toBe(1);
 const active=got.get(subject)!;
 expect(active.id).toBe(ids[0]!);expect(active.mode).toBe('completed_units');expect(active.completedUnitCount).toBe(3);
 expect(Object.keys(active).sort()).toEqual(['id','subjectId','versionSubjectId','mode','unit','total','amount','locator','position','completedUnitCount','state','revision','startedAt','completedAt'].sort());
 expect(active.amount).toBeNull();expect(active.total).toBeNull();
 expect((await createShelfActiveReader().sessions(db.admin,route,owner,[])).size).toBe(0);
});
