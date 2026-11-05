import {afterAll,beforeAll,expect,test} from 'bun:test';
import {newId} from '../../src/route/route.ts';
import {pageBulkOutcomes} from '../../src/library/bulk-outcome-page.ts';
import {openGrowthDatabase,type GrowthDatabase} from '../support/growth.ts';
let db:GrowthDatabase;
beforeAll(async()=>{db=await openGrowthDatabase();});afterAll(async()=>{await db?.close();});
test('native outcome pages preserve ordinal precision filter and emitted-prefix continuation',async()=>{
 const route=0x6a10,accountId=newId(route),operationId=newId(route),base=9007199254740993n,ids=Array.from({length:5},()=>newId(0x7b20));
 for(let i=0;i<5;i++)await db.admin.query(`INSERT INTO library.bulk_target(route,operation_id,ordinal,account_id,subject_id,target_kind,target,source_digest,receipt,created_transaction_id,state,chunk_index) VALUES($1,$2,$3,$4,$5,'subject','{}',$6,'{}',$7,$8,0)`,[route,operationId,(base+BigInt(i)).toString(),accountId,ids[i],'a'.repeat(64),newId(route),i%2===0?'applied':'pending']);
 const input={route,accountId,operationId,after:null,limit:2,state:null} as const;
 const a=await pageBulkOutcomes(db.admin,input);expect(a.outcomes.map(x=>x.ordinal)).toEqual([base.toString(),(base+1n).toString()]);expect(a.nextAfter).toBe((base+1n).toString());
 const b=await pageBulkOutcomes(db.admin,{...input,state:'applied'});expect(b.outcomes.map(x=>x.subjectId)).toEqual([ids[0]!,ids[2]!]);expect(b.nextAfter).toBe((base+2n).toString());
 const c=await pageBulkOutcomes(db.admin,{...input,state:'applied',after:b.nextAfter});expect(c.outcomes.map(x=>x.subjectId)).toEqual([ids[4]!]);expect(c.nextAfter).toBeNull();
 expect(Object.keys(c.outcomes[0]!).sort()).toEqual(['memberId','ordinal','reason','resultingMemberId','state','subjectId','deletion','memberDeletion'].sort());
 expect((await pageBulkOutcomes(db.admin,{...input,accountId:newId(route)})).outcomes).toEqual([]);
 await expect(pageBulkOutcomes(db.admin,{...input,limit:21})).rejects.toThrow();await expect(pageBulkOutcomes(db.admin,{...input,after:'01'})).rejects.toThrow();
});
