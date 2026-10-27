import {expect,test} from 'bun:test';
import type {Pool} from 'pg';
import {newId,partitionOf} from '../../src/route/route.ts';
import {createListingSourceObserver} from '../../src/library/listing-source-observer.ts';
function harness(){const sql:string[]=[];const client={query:async(text:string)=>{sql.push(text);return {rows:[]};},release:()=>sql.push('release')};return {sql,client,pool:{connect:async()=>client} as unknown as Pool};}
test('listing source stamp and truth share one released RR client',async()=>{
 const h=harness(),collectionId=newId(0x6a10),subjectId=newId(0x7b20),position=9007199254740993n;let stamped=false;
 const read=createListingSourceObserver({pool:h.pool,source:{
 readPartition:async(client,partition)=>{expect(client).toBe(h.client);expect(partition).toBe(partitionOf(0x6a10));stamped=true;return {partitionNo:partition,node:'local',writeState:'active' as const,movedTo:null,epoch:3,position};},
 readTruth:async(client,key)=>{expect(client).toBe(h.client);expect(stamped).toBe(true);expect(key).toEqual({subjectId,collectionId});return {multiplicity:2,currentlyPublic:true,everPublic:true};}}});
 expect(await read({subjectId,collectionId})).toEqual({subjectId,collectionId,collectionRoute:0x6a10,stamp:{partition:partitionOf(0x6a10),epoch:3,position},multiplicity:2,currentlyPublic:true,everPublic:true});
 expect(h.sql.some(s=>/BEGIN.*REPEATABLE READ.*READ ONLY/i.test(s))).toBe(true);expect(h.sql).toContain('COMMIT');expect(h.sql.at(-1)).toBe('release');
});
test('unavailable listing sources never become successful zero',async()=>{
 for(const state of ['missing','moved','fenced'] as const){const h=harness(),collectionId=newId(0x6a10),subjectId=newId(0x7b20);let probes=0;
 const read=createListingSourceObserver({pool:h.pool,source:{readPartition:async()=>state==='missing'?null:{partitionNo:partitionOf(0x6a10),node:'old',writeState:state,movedTo:state==='moved'?'new':null,epoch:1,position:4n},readTruth:async()=>{probes++;return {multiplicity:0,currentlyPublic:false,everPublic:false};}}});
 let error:any;try{await read({subjectId,collectionId});}catch(e){error=e;}expect(error?.reason).toBe(state==='missing'?'deadline':state);if(state==='moved')expect(error.movedTo).toBe('new');expect(probes).toBe(0);expect(h.sql).toContain('ROLLBACK');expect(h.sql.at(-1)).toBe('release');}
});
