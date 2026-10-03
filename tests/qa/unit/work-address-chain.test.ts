import { expect,test } from 'bun:test';
import { resolveMergedIdentity } from '../../../services/main/src/modules/identity-merge/preflight.ts';
import { MERGE_COST,MergeUnavailable } from '../../../services/main/src/modules/identity-merge/contract.ts';
import { AliasRegistry } from '../../../services/main/src/modules/address/registry.ts';
import type { Pool } from 'pg';
const node=(index:number) => 'https://rezics.com/id/00000000-0000-0000-0000-'+index.toString(16).padStart(12,'0');

test('VIEW02: bounded redirect traversal preserves a valid last hop',async () => {
  let lookups=0,calls=0;
  const registry=new AliasRegistry({ query: async () => { lookups++;return { rows:[{ holder:node(0),state:'redirect' }] }; } } as unknown as Pool);
  const identified=await registry.identify('work','Old Route');
  const result=await resolveMergedIdentity(identified.holder!,resource => {
    calls++;const index=Number.parseInt(resource.slice(-12),16);return index<MERGE_COST.redirectHops ? node(index+1) : null;
  });
  expect(result).toMatchObject({ state:'merged',source:node(0),survivor:node(MERGE_COST.redirectHops),hops:MERGE_COST.redirectHops });
  expect(lookups).toBe(1);expect(calls).toBe(MERGE_COST.redirectHops+1);
});

test('VIEW02: a valid chain past the bound is unavailable, not missing',async () => {
  let calls=0;
  await expect(resolveMergedIdentity(node(0),resource => { calls++;return node(Number.parseInt(resource.slice(-12),16)+1); }))
    .rejects.toBeInstanceOf(MergeUnavailable);
  expect(calls).toBe(MERGE_COST.redirectHops+1);
});

test('VIEW02: a cycle or missing redirect target is unavailable',async () => {
  let calls=0;
  await expect(resolveMergedIdentity(node(0),resource => { calls++;return resource===node(0) ? node(1) : node(0); }))
    .rejects.toBeInstanceOf(MergeUnavailable);
  expect(calls).toBe(2);
  await expect(resolveMergedIdentity(node(0),resource => {
    if (resource === node(0)) return node(1);throw new MergeUnavailable('Missing redirect target');
  })).rejects.toBeInstanceOf(MergeUnavailable);
});
