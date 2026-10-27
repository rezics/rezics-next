import {expect,test} from 'bun:test';
import {typePreparationBinding} from '../services/kernel/src/library/type-preparation-contract.ts';
test('preparation identity binds owner request source and epochs without source text',()=>{
 const input={accountId:'00000000-0000-7000-8000-6a1000000001',subjectId:'00000000-0000-7000-8000-7b2000000001',requestKey:'11111111-1111-4111-8111-111111111111',sourceId:'00000000-0000-7000-8000-7b2000000002',source:{partition:1970,epoch:2,position:9007199254740993n},ownerEpoch:3n};
 const binding=typePreparationBinding(input);
 expect(binding).toEqual({accountId:input.accountId,subjectId:input.subjectId,requestKey:input.requestKey,sourceId:input.sourceId,sourcePartition:1970,sourceEpoch:2,sourcePosition:'9007199254740993',ownerEpoch:'3'});
 expect(typePreparationBinding({...input,ownerEpoch:4n})).not.toEqual(binding);
 expect(typePreparationBinding({...input,requestKey:'22222222-2222-4222-8222-222222222222'})).not.toEqual(binding);
 expect(typePreparationBinding({...input,source:{...input.source,position:9007199254740992n}})).not.toEqual(binding);
 expect(JSON.stringify(binding).length).toBeLessThan(1024);
});
