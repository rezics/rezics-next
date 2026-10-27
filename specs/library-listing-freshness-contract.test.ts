import {expect,test} from 'bun:test';
import {compareListingStamp,mayRetainListingVersion} from '../services/kernel/src/library/listing-freshness-contract.ts';
test('listing stamps compare bigint positions only within one source partition',()=>{
 const a={partition:7,epoch:1,position:9007199254740992n},b={...a,position:9007199254740993n};
 expect(compareListingStamp(a,b)).toBe(-1);expect(compareListingStamp(b,a)).toBe(1);expect(compareListingStamp(b,b)).toBe(0);
 expect(compareListingStamp({...a,epoch:2},b)).toBe(1);
 expect(()=>compareListingStamp(a,{...b,partition:8})).toThrow();
});
test('never-public private zero observations do not create subject-partition holder state',()=>{
 expect(mayRetainListingVersion({currentlyPublic:false,everPublic:false,knownPublicPair:false})).toBe(false);
 expect(mayRetainListingVersion({currentlyPublic:true,everPublic:false,knownPublicPair:false})).toBe(true);
 expect(mayRetainListingVersion({currentlyPublic:false,everPublic:true,knownPublicPair:false})).toBe(true);
 expect(mayRetainListingVersion({currentlyPublic:false,everPublic:false,knownPublicPair:true})).toBe(true);
});
