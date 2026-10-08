import { expect,test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startMediaStack } from './media-support.ts';
import { TemplateSeekIndex } from '../../../services/main/src/modules/query/seek-index.ts';
import { fusekiReadBudget,type FusekiClient,type TemplateIndexDelta } from '../../../services/main/src/infrastructure/fuseki.ts';
import { readDependencyToken } from '../../../services/main/src/modules/work/read-session.ts';
const graph='urn:rezics:graph:current',predicate='https://rezics.com/vocab/work',type='https://rezics.com/vocab/AuthorCredit';
const native=()=>`https://rezics.com/id/${randomUUID()}`;
function delta(epoch:string,root:string,sequence:string,previous:string):TemplateIndexDelta {
  return {position:{dataEpoch:epoch,sequence},bases:[{graph,predicate,anchor:root,type,sequence,previous}],
    entities:[{graph,id:native(),terms:{type:[type],work:[root],ordinal:['0'],externalKey:[`key-${sequence}`]}}]};
}
async function queue(pool:ReturnType<typeof startMediaStack> extends Promise<infer S>?S extends {accessPool:infer P}?P:never:never,value:TemplateIndexDelta) {
  const epoch=value.position.dataEpoch,sequence=value.position.sequence,id=readDependencyToken(value);
  await pool.query('INSERT INTO access.template_seek_pending(epoch,sequence,id,delta) VALUES($1,$2,$3,$4)',[epoch,sequence,id,value]);
  for(const basis of value.bases) await pool.query('INSERT INTO access.template_seek_pending_anchor(epoch,anchor_key,sequence,id) VALUES($1,$2,$3,$4)',
    [epoch,readDependencyToken([basis.graph,basis.predicate,basis.anchor,basis.type]),sequence,id]);
}

test('Independent-anchor applies progress while an unrelated pending row is locked',async()=> {
  const stack=await startMediaStack('template-pending-independent');
  const blocker=await stack.accessPool.connect();
  try {
    const epoch=stack.env.lineage.dataEpoch,a=delta(epoch,native(),'9000001','0'),b=delta(epoch,native(),'9000002','0');
    await queue(stack.accessPool,a);
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM access.template_seek_pending WHERE epoch=$1 AND sequence=$2 FOR UPDATE',[epoch,a.position.sequence]);
    // Neither apply may wait for this transaction to release a common prefix.
    const results=await Promise.allSettled([stack.templateSeek.apply(a),stack.templateSeek.apply(b)]);
    expect(results.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
    const projected=await stack.accessPool.query('SELECT id FROM access.template_seek_entity WHERE epoch=$1 AND id=$2',[epoch,b.entities![0]!.id]);
    expect(projected.rowCount).toBe(1);
    expect((await stack.accessPool.query('SELECT id FROM access.template_seek_pending WHERE epoch=$1 AND sequence=$2',[epoch,a.position.sequence])).rowCount).toBe(1);
    await blocker.query('ROLLBACK');
    await stack.templateSeek.recover(epoch);
    expect((await stack.accessPool.query('SELECT id FROM access.template_seek_pending WHERE epoch=$1 AND sequence=ANY($2::numeric[])',[epoch,[a.position.sequence,b.position.sequence]])).rowCount).toBe(0);
  } finally {await blocker.query('ROLLBACK');blocker.release();await stack.stop();}
},60_000);

test('Same-anchor out-of-order delivery retains gaps, recovers lost consumption and replays lost acknowledgements',async()=> {
  const stack=await startMediaStack('template-pending-ordered');
  const blocker=await stack.accessPool.connect();
  try {
    const epoch=stack.env.lineage.dataEpoch,root=native(),a=delta(epoch,root,'9100001','0'),b=delta(epoch,root,'9100002','9100001');
    await queue(stack.accessPool,a);
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM access.template_seek_pending WHERE epoch=$1 AND sequence=$2 FOR UPDATE',[epoch,a.position.sequence]);
    await Promise.all([stack.templateSeek.apply(b),stack.templateSeek.apply(a)]);
    expect((await stack.accessPool.query('SELECT id FROM access.template_seek_entity WHERE epoch=$1 AND id=ANY($2::text[])',[epoch,[a.entities![0]!.id,b.entities![0]!.id]])).rowCount).toBe(0);
    expect((await stack.accessPool.query('SELECT id FROM access.template_seek_pending WHERE epoch=$1 AND sequence=ANY($2::numeric[])',[epoch,[a.position.sequence,b.position.sequence]])).rowCount).toBe(2);
    await blocker.query('ROLLBACK');
    // No subsequent command is needed: periodic, noncontending recovery closes
    // the interrupted consumption once the predecessor is available.
    stack.templateSeek.startRecovery(epoch);
    for(let turn=0;turn<40;turn++) {
      if((await stack.accessPool.query('SELECT id FROM access.template_seek_pending WHERE epoch=$1 AND sequence=ANY($2::numeric[])',[epoch,[a.position.sequence,b.position.sequence]])).rowCount===0) break;
      await delay(50);
    }
    expect((await stack.accessPool.query('SELECT id FROM access.template_seek_entity WHERE epoch=$1 AND id=ANY($2::text[])',[epoch,[a.entities![0]!.id,b.entities![0]!.id]])).rowCount).toBe(2);
    await Promise.all([stack.templateSeek.apply(a),stack.templateSeek.apply(b)]);
    const basis=(await stack.accessPool.query<{sequence:string}>('SELECT sequence::text FROM access.template_seek_basis WHERE epoch=$1 AND anchor=$2',[epoch,root])).rows[0]!;
    expect(basis.sequence).toBe('9100002');
    expect((await stack.accessPool.query('SELECT id FROM access.template_seek_entity WHERE epoch=$1 AND id=ANY($2::text[])',[epoch,[a.entities![0]!.id,b.entities![0]!.id]])).rowCount).toBe(2);
  } finally {await blocker.query('ROLLBACK');blocker.release();await stack.stop();}
},60_000);

test('Directory preparation deadline includes native I/O and never marks an interrupted rebuild complete',async()=> {
  const stack=await startMediaStack('template-rebuild-deadline');
  try {
    const epoch=stack.env.lineage.dataEpoch;
    let nativeReadStarted=false;
    const fake={attachTemplateIndexWriter:()=>{},commandHealth:async()=>({instanceId:randomUUID()}),
      prepareWorkScopeDirectory:async()=>({status:'unavailable' as const,reason:'writer-not-exclusive'}),templateIndex:async()=> {
      nativeReadStarted=true;
      const signal=fusekiReadBudget.getStore()!.signal;
      await delay(60_000,undefined,{signal});throw new Error('deadline should abort native read');
    }} as unknown as FusekiClient;
    const index=new TemplateSeekIndex(stack.accessPool,fake);
    const started=Date.now();
    await expect(index.backfill(epoch,true,1000)).rejects.toThrow();
    expect(nativeReadStarted).toBe(true);
    expect(Date.now()-started).toBeLessThan(3000);
    const checkpoint=(await stack.accessPool.query<{complete:boolean}>('SELECT complete FROM access.template_seek_checkpoint WHERE epoch=$1',[epoch])).rows[0];
    expect(checkpoint?.complete ?? false).toBe(false);
    await expect(index.backfill(epoch,false,600_001)).rejects.toThrow('budget');
    await stack.templateSeek.backfill(epoch,true);
  } finally {await stack.stop();}
},60_000);
