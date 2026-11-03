import { afterEach, expect, test } from 'bun:test';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { OWNER_INDEX_WORKFLOW } from '../../src/library/owner-index-work.ts';
import { createDynamicCollectionsDriver, type NativeDynamicCollectionsDriver } from './support/native-dynamic-driver.ts';

let driver: NativeDynamicCollectionsDriver | undefined;
afterEach(async () => { await driver?.close(); driver = undefined; });

async function pending() {
  const current = driver = await createDynamicCollectionsDriver();
  await current.world.native.hold();
  const subject = await current.provisionSubject('game');
  const response = await current.setEntryState(subject.id, current.profiles.game.states[0]!.id);
  expect(response.ok).toBe(true);
  await response.arrayBuffer();
  return current;
}
async function metadata(current: NativeDynamicCollectionsDriver) {
  return (await current.world.native.reader.query(
    'SELECT collection_id AS id,labels FROM library.owner_index_state WHERE account_id=$1 ORDER BY collection_id',
    [current.accounts.owner.id],
  )).rows;
}
async function refused(current: NativeDynamicCollectionsDriver, ids: string[]) {
  for (const id of ids) for (const method of ['GET', 'PUT'] as const) {
    const input = {
      method, path: method === 'GET' ? `/v1/collections/${id}` : `/v1/follows/${id}`,
      headers: { 'Idempotency-Key': `"${Bun.randomUUIDv7()}"` },
    };
    expect((await current.request('owner', input)).ok).toBe(false);
    const response = await current.request('other', input);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'not_found' });
  }
}

test('installed maintenance page captures the accepted pin and real handle, applies current meaning and refuses a fabricated ready-pin capture', async () => {
  const current = await pending();
  const accepted = current.profiles.game;
  await current.activateProfileRelease('game', {
    states: accepted.states.map((state) => ({ id: state.id, labels: { en: `Changed ${state.id}` } })),
  });
  const latch = await current.holdStateReferenceRepair();
  const run = await current.world.native.stateReferenceRepair.start();
  try {
    await latch.reached;
    const captured = await latch.captured;
    expect(captured).toMatchObject({
      workflowId: run.workflowId,
      accountId: current.accounts.owner.id,
      meaning: { pin: { releaseDigest: accepted.releaseDigest, profileId: accepted.profileId } },
    });
    expect(captured.meaning.states.map((state) => ({ id: state.stateId, labels: state.labels }))).toEqual([...accepted.states]);
    expect(await current.world.native.workClient.getWorkflow(run.workflowId)).toMatchObject({
      workflowName: OWNER_INDEX_WORKFLOW, queueName: 'maintenance',
    });
    expect(await metadata(current)).toEqual([]);
  } finally { latch.resume(); }
  await run.result;
  await run.handle.getResult();
  expect(await current.world.native.workClient.getWorkflow(run.workflowId)).toMatchObject({ status: 'SUCCESS' });
  expect(await metadata(current)).toHaveLength(accepted.states.length);
  const ready = await current.holdStateReferenceRepair();
  const repair = current.repairStateReferences();
  await Promise.all([
    expect(ready.reached).rejects.toThrow('bounded accepted ready-pin state-reference recapture producer is absent'),
    expect(repair).rejects.toThrow('captured no pending pin'),
  ]);
}, 240000);

test('committed account deletion passes a held native capture and the same operation cannot resurrect state meaning', async () => {
  const current = await pending();
  const latch = await current.holdStateReferenceRepair();
  const repair = current.repairStateReferences();
  let ids: string[] = [];
  let references: { id: string }[] = [];
  const readReferences = async () => (await current.world.native.reader.query<{ id: string }>(
    'SELECT collection_id AS id FROM library.builtin_collection_reference WHERE collection_id=ANY($1::uuid[]) ORDER BY collection_id',
    [ids],
  )).rows;
  try {
    await latch.reached;
    const captured = await latch.captured;
    ids = captured.meaning.states.map((state) => state.collectionId);
    expect(ids.length).toBeGreaterThan(0);
    references = await readReferences();
    const response = await current.deleteAccount();
    expect(response.status).toBe(200);
    const receipt = await response.json();
    const status = await readErasureStatus(current.world.native.reader, current.accounts.owner.id);
    expect(receipt).toEqual({ accountId: current.accounts.owner.id, at: status!.at });
    expect(status).toMatchObject({ state: 'pending', completedAt: null });
    await refused(current, ids);
  } finally { latch.resume(); }
  await repair;
  expect(await metadata(current)).toEqual([]);
  expect((await readReferences()).every((row) => references.some((before) => row.id === before.id))).toBe(true);
  await refused(current, ids);
}, 240000);
