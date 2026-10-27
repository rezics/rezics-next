import {expect,test} from 'bun:test';
import {initialShelfReadiness,counterWriteMode} from '../services/kernel/src/library/shelf-maintenance-ops-contract.ts';
test('empty owner projections are ready and legacy inputs require backfill',()=>{
 const empty={hasEntries:false,hasCollections:false,hasSessions:false};expect(initialShelfReadiness(empty)).toBe('ready');
 for(const key of ['hasEntries','hasCollections','hasSessions'] as const)expect(initialShelfReadiness({...empty,[key]:true})).toBe('backfill');
});
test('unpublished counters are deferred rather than decremented as complete',()=>{
 expect(counterWriteMode(false)).toBe('defer');expect(counterWriteMode(true)).toBe('active');
});
