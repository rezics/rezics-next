import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createShelfMaintenanceOps, type ShelfMaintenanceBinding } from '../../src/library/shelf-maintenance-ops-contract.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import { noEffect } from '../../src/command/command.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { createOwnedErasureFixture } from './support/erasure-worker.ts';
import { deletePersona } from '../support/account-deletion.ts';
import type { CloudEvent } from '../../src/events/log.ts';

let f:Awaited<ReturnType<typeof createOwnedErasureFixture>>;
beforeAll(async()=>{f=await createOwnedErasureFixture();},360000);
afterAll(async()=>{await f?.close();});
const owner=(accountId:string)=>({route:routeOf(accountId)!,accountId});
const actor=(person: {bearer:string})=>f.kernel.testAccess.authenticate(person.bearer,{pool:f.db.pool,deadline:Date.now()+5000});
const ops=()=>createShelfMaintenanceOps({pool:f.db.pool,access:f.kernel.testAccess,client:f.client});
async function finish(binding:ShelfMaintenanceBinding) {
  for(let n=0;n<100;n++) {
    const receipt=await ops().page(binding);
    if(receipt.terminal)return receipt;
    expect(receipt.next).not.toBeNull();binding=receipt.next!;
  }
  throw new Error('Quiescent empty native shelf did not finish');
}

test('default native empty owner initializes, drains, fences a late writer and atomically publishes with exact Core replay',async()=>{
  const person=f.people.alice,as=await actor(person),account=owner(person.accountId);
  const runner=createLibraryCommandRunner({pool:f.db.pool});
  const initialized=await runner.ownAccount(as,{action:'library_entry:update',kind:'library.shelf.init.probe',requestKey:crypto.randomUUID(),input:{}},async tx=>noEffect(await ops().initialize(tx,account)));
  expect(initialized.value).toMatchObject({readiness:'ready',generationId:'00000000-0000-0000-0000-000000000000',requested:null});
  const requested=await ops().requestRebuild(as,{owner:account,kind:'backfill',requestKey:crypto.randomUUID()});
  const recovered=await ops().recover({after:null,limit:100});
  expect(recovered.enqueued.some(binding=>binding.runId===requested.runId)).toBe(true);
  expect((await f.client.getWorkflow(`shelf:${account.accountId}:${requested.runId}:0:0:0:0`))?.workflowName).toBe('library.shelfMaintenance');
  const drained=await ops().page(requested);
  expect(drained.next?.epoch).toBe('1');
  await expect(runner.ownAccount(as,{action:'library_entry:update',kind:'library.shelf.late.probe',requestKey:crypto.randomUUID(),input:{}},async()=>noEffect(null))).rejects.toThrow();
  const terminal=await finish(drained.next!);
  expect(terminal.terminal).toBe(true);
  expect(await ops().page(requested)).toEqual(drained);
  const gate=(await f.db.admin.query('SELECT mode,ready,active_generation FROM library.shelf_maintenance WHERE route=$1 AND account_id=$2',[account.route,account.accountId])).rows[0];
  expect(gate).toMatchObject({mode:'open',ready:true});
  expect(gate.active_generation).not.toBe('00000000-0000-0000-0000-000000000000');
  const next=await ops().requestRebuild(as,{owner:account,kind:'counters',requestKey:crypto.randomUUID()});
  await expect(ops().page(drained.next!)).rejects.toThrow();
  await finish(next);
},30000);

test('terminal native tombstone rejects fabricated envelopes and late writers; private completion leaves shared erasure pending',async()=>{
  const person=f.people.bob,as=await actor(person),account=owner(person.accountId);
  await deletePersona(f.options,person);
  const row=(await f.db.admin.query("SELECT id,epoch,position::text,data,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS time FROM core.outbox WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.access.account-tombstoned.v1' ORDER BY position LIMIT 1",[partitionOf(account.route),account.accountId])).rows[0];
  const envelope:CloudEvent={specversion:'1.0',id:row.id,source:`urn:rezics:log:${partitionOf(account.route)}.${row.epoch}`,type:'com.rezics.access.account-tombstoned.v1',subject:account.accountId,time:row.time,datacontenttype:'application/json',sequence:row.position.padStart(19,'0'),data:row.data};
  await expect(ops().requestPurge({...envelope,id:crypto.randomUUID()})).rejects.toThrow();
  const requested=await ops().requestPurge(envelope);
  const terminal=await finish(requested);
  expect(terminal.sharedEvidence).toBe('separate-contract');
  expect(await ops().page(terminal.binding)).toEqual(terminal);
  await expect(ops().requestRebuild(as,{owner:account,kind:'backfill',requestKey:crypto.randomUUID()})).rejects.toThrow();
  expect((await readErasureStatus(f.db.pool,account.accountId))?.state).toBe('pending');
  const recovered=await ops().recover({after:null,limit:100});
  expect(recovered.enqueued.some(b=>b.runId===requested.runId)).toBe(false);
},30000);
