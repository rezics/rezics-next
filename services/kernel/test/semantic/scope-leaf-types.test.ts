import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccess } from '../../src/access/index.ts';
import { readScopeLeafEvidence, type LeafReader, type LeafWork } from '../../src/semantic/scope-leaf-evidence.ts';

test('invalid native leaf work is rejected before Access preparation or SQL and the shared types have one source', async()=>{
  const pool=new Pool({connectionString:'postgresql://127.0.0.1:1/unused',connectionTimeoutMillis:50,max:1});
  const access=createAccess({actions:new Map([['subject:read',{anonymous:true}]])});
  const reader:LeafReader=readScopeLeafEvidence;
  const budget:LeafWork={keys:17,points:512,witnesses:16,rows:2048,bytes:262144,emptySeeks:512};
  try {
    for(const field of Object.keys(budget) as (keyof LeafWork)[]) {
      for(const value of [0,-1,0.5,NaN,Infinity]) {
        await expect(reader(pool,{
          subject:'019a1b2c-3d4e-7f00-8a00-750000000083',
          leaf:{facet:'type',values:['schema:Book']},after:null,revalidate:null,
          budget:{...budget,[field]:value},
        },{access,actor:{kind:'anonymous'},routeKey:new Uint8Array(32).fill(83),deadline:Date.now()+1000})).rejects.toBeInstanceOf(RangeError);
        expect(pool.totalCount).toBe(0);
      }
    }
    for(const excess of [{keys:102},{witnesses:101}]) {
      await expect(reader(pool,{
        subject:'019a1b2c-3d4e-7f00-8a00-750000000083',
        leaf:{facet:'type',values:['schema:Book']},after:null,revalidate:null,budget:{...budget,...excess},
      },{access,actor:{kind:'anonymous'},routeKey:new Uint8Array(32).fill(83),deadline:Date.now()+1000})).rejects.toBeInstanceOf(RangeError);
      expect(pool.totalCount).toBe(0);
    }
  } finally {await pool.end();}
});
