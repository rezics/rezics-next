import { suspendAccount } from '../support/native-suspension-driver.ts';
import {afterAll,beforeAll,expect,test} from 'bun:test';
import {newId} from '../../src/route/route.ts';
import {STANDARD_QUESTION_ID} from '../../src/rating/votes.ts';
import {readOwnVotes} from '../../src/rating/own-votes.ts';
import {openGrowthDatabase,type GrowthDatabase} from '../support/growth.ts';
let db:GrowthDatabase;
beforeAll(async()=>{db=await openGrowthDatabase();});afterAll(async()=>{await db?.close();});
test('own vote batch preserves zero tombstones and owner scope boundaries',async()=>{
 const route=0x6a10,accountId=newId(route),other=newId(route),ids=Array.from({length:3},()=>newId(0x7b20));
 for(const id of [accountId,other])await db.admin.query("INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2)",[route,id]);
 const seed=async(voter:string,target:string,units:number|null)=>db.admin.query(`INSERT INTO rating.vote(route,voter_id,question_id,target_id,units,revision,changed_at,transaction_id) VALUES($1,$2,$3,$4,$5,1,'2026-10-27T00:00:00Z',$6)`,[route,voter,STANDARD_QUESTION_ID,target,units,newId(route)]);
 await seed(accountId,ids[0]!,0);await seed(accountId,ids[1]!,null);await seed(other,ids[2]!,20);
 const actor={kind:'account' as const,accountId,clientId:'own-votes',scopes:['rating:vote'],authnEpoch:1,requestedBy:null};const got=await readOwnVotes(db.admin,actor,STANDARD_QUESTION_ID,ids);
 expect([...got.keys()]).toEqual([ids[0]!]);expect(got.get(ids[0]!)).toEqual({units:0,revision:1,at:'2026-10-27T00:00:00.000Z'});
 await expect(readOwnVotes(db.admin,{...actor,scopes:[]},STANDARD_QUESTION_ID,ids)).rejects.toThrow();await expect(readOwnVotes(db.admin,actor,STANDARD_QUESTION_ID,Array.from({length:101},()=>ids[0]!))).rejects.toThrow();
 await suspendAccount(db.admin, accountId);await expect(readOwnVotes(db.admin,actor,STANDARD_QUESTION_ID,ids)).rejects.toThrow();
});
