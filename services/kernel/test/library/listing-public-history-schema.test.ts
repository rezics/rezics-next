import {afterAll,beforeAll,expect,test} from 'bun:test';
import {newId} from '../../src/route/route.ts';
import {insertCollection} from '../../src/library/collection-store.ts';
import {openGrowthDatabase,type GrowthDatabase} from '../support/growth.ts';
let db:GrowthDatabase;
beforeAll(async()=>{db=await openGrowthDatabase();});
afterAll(async()=>{await db?.close();});
test('source publication history survives old prepared withdrawal without tracking never-public holders',async()=>{
 const route=0x6a10,curatorAccountId=newId(route),id=newId(route),quiet=newId(route),context={transactionId:newId(route),time:'2026-10-27T00:00:00Z'};
 for(const collectionId of [id,quiet])await insertCollection(db.admin,route,{id:collectionId,curatorAccountId,title:'Source',description:null,visibility:'private'},context);
 const history=async(collectionId:string)=>(await db.admin.query('SELECT listing_ever_public AS ever FROM library.collection WHERE route=$1 AND collection_id=$2',[route,collectionId])).rows[0]?.ever;
 expect(await history(id)).toBe(false);
 await db.admin.query("UPDATE library.collection SET visibility='public' WHERE route=$1 AND collection_id=$2",[route,id]);expect(await history(id)).toBe(true);
 await db.admin.query("UPDATE library.collection SET visibility='private',listing_ever_public=false WHERE route=$1 AND collection_id=$2",[route,id]);expect(await history(id)).toBe(true);
 await db.admin.query('DELETE FROM library.collection WHERE route=$1 AND collection_id=ANY($2::uuid[])',[route,[id,quiet]]);
 const rows=await db.admin.query('SELECT collection_id FROM library.collection_listing_history WHERE route=$1 ORDER BY collection_id',[route]);expect(rows.rows).toEqual([{collection_id:id}]);
});
