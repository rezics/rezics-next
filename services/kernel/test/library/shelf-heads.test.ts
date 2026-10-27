import {afterAll,beforeAll,expect,test} from 'bun:test';
import {newId} from '../../src/route/route.ts';
import {openGrowthDatabase,type GrowthDatabase} from '../support/growth.ts';
import {createShelfHeads,createProgressActivity} from '../../src/library/shelf-heads.ts';
let db:GrowthDatabase;
beforeAll(async()=>{db=await openGrowthDatabase();});
afterAll(async()=>{await db?.close();});
test('empty heads serialize entry create and progress raise in two statements',async()=>{
 const route=0x6a10,accountId=newId(route),subjectId=newId(0x7b20),write={client:db.admin,route,accountId};
 const empty=await createShelfHeads().ensure(write,subjectId);
 expect(empty).toEqual({lastChangedAt:null,lastCompletedAt:null});
 await createProgressActivity().touch(write,{subjectId,time:'2026-10-27T00:00:10.000Z',completed:true});
 await createProgressActivity().touch(write,{subjectId,time:'2026-10-27T00:00:05.000Z',completed:false});
 const head=await createShelfHeads().ensure(write,subjectId);
 expect(new Date(head.lastChangedAt!).toISOString()).toBe('2026-10-27T00:00:10.000Z');
 expect(new Date(head.lastCompletedAt!).toISOString()).toBe('2026-10-27T00:00:10.000Z');
 const entry=await db.admin.query('SELECT subject_id FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3',[route,accountId,subjectId]);
 expect(entry.rows).toEqual([]);
});
test('head and entry raises roll back together without changing entry identity',async()=>{
 const route=0x6a20,accountId=newId(route),subjectId=newId(0x7b20),transaction=newId(route);
 await db.admin.query("INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,activity_at) VALUES($1,$2,$3,'planned',1,'2026-10-20','2026-10-20',$4,'2026-10-20')",[route,accountId,subjectId,transaction]);
 const client=await db.pool.connect();
 try{
  await client.query('BEGIN');
  await createProgressActivity().touch({client,route,accountId},{subjectId,time:'2026-10-27T00:00:10.000Z',completed:true});
  await client.query('ROLLBACK');
 }finally{client.release();}
 const row=(await db.admin.query('SELECT state,revision,transaction_id,activity_at::text,finished_at FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3',[route,accountId,subjectId])).rows[0]!;
 expect(row.state).toBe('planned');expect(row.revision).toBe(1);expect(row.transaction_id).toBe(transaction);expect(row.finished_at).toBeNull();expect(String(row.activity_at)).toContain('2026-10-20');
 const heads=await db.admin.query('SELECT subject_id FROM library.progress_head WHERE route=$1 AND account_id=$2 AND subject_id=$3',[route,accountId,subjectId]);
 expect(heads.rows).toEqual([]);
});
