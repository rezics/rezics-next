import { afterAll, beforeAll, expect, test } from 'bun:test';
import { classifyUnavailability } from '../../src/access/unavailable.ts';
import { completeAgentVerification, mergeVerifiedAgent, unmergeVerifiedAgent } from '../../src/access/agent-verification.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, PARTITIONS } from '../../src/route/route.ts';
import { ensureAccountAgent, verifyAccountAgent, unverifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { nativeEpochStore, nativeMappingStep, seedLegacyGroup, home, release } from './support/identity-epoch.ts';
import { afterSourceRelease, allChanges, approvedVerification, birthAt, crossHomeLegacy, cutoverFixture, ordinaryAdmission, withInFlightControlMove, withoutOwner } from './support/identity-epoch-cutover.ts';

const fixtures: Awaited<ReturnType<typeof cutoverFixture>>[] = [];
beforeAll(async () => {
  // Independent native databases: a pending-only proof must not poison a later schedule or fake publication.
  for (let i = 0; i < 4; i++) fixtures.push(await cutoverFixture());
}, 60_000);
afterAll(async () => {
  for (const f of fixtures) await f.close();
}, 30_000);

test('native identity cutover covers all homes and lower key births without fake readiness', async () => {
  const f = fixtures[0]!;
  const root = (await f.create('Selected endpoint', 0x5d10)).subject.id;
  const unselected = await crossHomeLegacy(f, root, 0xc710);
  const topology = await f.admin.query('SELECT partition_no FROM core.partition ORDER BY partition_no');
  expect(topology.rows.map((row) => row.partition_no)).toEqual(Array.from({ length: PARTITIONS }, (_, i) => i));
  // Actual writes precede the first missing producer boundary. No selected-home bootstrap helper is called.
  const high = (await f.create('Scanned high key', 0x5e10)).subject.id;
  const lower = newId(0x5e10).replace(/^.{8}/, '00000000');
  expect(lower < high).toBe(true);
  await birthAt(f, lower);
  const store = await nativeEpochStore();
  expect(await store.readMapping(f.pool, lower)).toMatchObject({ state: 'mapped', original: lower, terminal: lower });
  // readEpoch must derive complete coverage from the real scheduler/owner cuts, including empty homes.
  expect(await store.readEpoch(f.pool)).toMatchObject({ state: 'published' });
  expect(await store.readMapping(f.pool, unselected)).toMatchObject({ state: 'mapped', original: unselected, terminal: root });
  await withoutOwner(f, 4095, async () => {
    expect(await store.readEpoch(f.pool)).toMatchObject({ state: 'unavailable', reason: 'missing-owner' });
    expect(await store.readMapping(f.pool, newId(0xfff0))).toEqual({ state: 'unavailable', reason: 'missing-owner' });
  });
  await f.admin.query("UPDATE core.partition SET write_state='moved',moved_to='cutover-test-node' WHERE partition_no=$1", [home(unselected)]);
  try {
    expect(await store.readMapping(f.pool, unselected)).toEqual({ state: 'unavailable', reason: 'moved-owner' });
  } finally {
    await f.admin.query("UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=$1", [home(unselected)]);
  }
});

test('retained immutable group inputs admit exact capped pending work before participant publication', async () => {
  const f = fixtures[1]!;
  const a = (await f.create()).subject.id;
  const b = (await f.create()).subject.id;
  const c = (await f.create()).subject.id;
  const left = await seedLegacyGroup(f, a, 2047);
  const right = await seedLegacyGroup(f, b, 2047);
  const overflow = await seedLegacyGroup(f, c, 2047);
  const remote = await crossHomeLegacy(f, c, 0xc810); // 2049 originals, outside the endpoint homes.
  const ids = [a, b, c, remote, ...left, ...right, ...overflow];
  const store = await nativeEpochStore();
  const intent = { kind: 'merge' as const, survivor: a, redirected: b, release: release.digest };
  const tooLarge = await ordinaryAdmission(f, store, { ...intent, redirected: c });
  const before = await f.snapshot(ids);
  await expect(tooLarge.execute()).rejects.toMatchObject({ code: 'identity_group_overflow' });
  expect(await f.snapshot(ids), '4097 refusal precedes ALL legacy effects/receipts/outbox').toEqual(before);
  const input = await ordinaryAdmission(f, store, intent);
  const job = (await input.execute()).value;
  expect(await store.readEpoch(f.pool)).toMatchObject({ state: 'pending', job });
  expect((await input.execute()).value).toEqual(job);
  expect((await store.findJob(f.pool, input.receipt))?.intent).toEqual(intent);
  await expect(input.execute({ ...intent, survivor: c })).rejects.toMatchObject({ name: 'IdempotencyConflictError' });
  await expect((await ordinaryAdmission(f, store, intent)).execute()).rejects.toMatchObject({ code: 'identity_epoch_busy' });
  const changes = await allChanges(f, store, job);
  expect(changes.map((change) => change.original)).toEqual([a, b, ...left, ...right].sort());
  expect(new Set(changes.map((change) => change.original)).size).toBe(4096);
  expect(changes.every((change) => change.terminal === a)).toBe(true);
  expect(await store.pageChanges(f.pool, job, changes.at(-1)!.original)).toEqual({ changes: [], next: null });
  const afterAdmission = await f.snapshot(ids);
  for (const field of ['subjects', 'revisions', 'redirects', 'members']) expect(afterAdmission[field]).toEqual(before[field]);
  const saved = await store.readJob(f.pool, job);
  expect(saved?.mapping).toBeNull();
  expect(saved?.participants).toEqual({ 'search-canonical-index': null, 'library-private-follow-counts': null });
  await expect(runCommand(f.pool, { partition: store.controlPartition }, (tx) => store.publish(tx, job))).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
});

test('released mapping observes pending once and coherently revalidates epoch', async () => {
  const f = fixtures[2]!;
  const original = (await f.create()).subject.id;
  const terminal = (await f.create('New terminal', 0x6d10)).subject.id;
  const unrelated = (await f.create('Unrelated self', 0x7d10)).subject.id;
  const store = await nativeEpochStore();
  expect(await store.readMapping(f.pool, original)).toMatchObject({ state: 'mapped', terminal: original });
  const request = await ordinaryAdmission(f, store, { kind: 'merge', survivor: terminal, redirected: original, release: release.digest });
  let job: import('../../src/semantic/identity-epoch-contract.ts').IdentityJobRef | undefined;
  const observed = await afterSourceRelease(
    f,
    () => store.readMapping(f.pool, original),
    async () => { job = (await request.execute()).value; },
  );
  expect(job).toBeDefined();
  // Pending commits after source read and before the first actual home gate/control observation.
  expect(observed).toEqual({ state: 'pending', original, job });
  expect(await store.readMapping(f.pool, unrelated)).toMatchObject({ state: 'mapped', original: unrelated, terminal: unrelated });
  const fresh = (await f.create('Search absent during pending', 0x8d10)).subject.id;
  expect(await store.readMapping(f.pool, fresh)).toMatchObject({ state: 'mapped', original: fresh, terminal: fresh });
  await withoutOwner(f, store.controlPartition, async () => {
    expect(await store.readMapping(f.pool, unrelated)).toEqual({ state: 'unavailable', reason: 'missing-owner' });
  });
  const mapping = await nativeMappingStep();
  for (let page = 0; page < 100; page++) {
    const progress = await mapping(f.pool, job!);
    expect(progress.work.rows).toBeLessThanOrEqual(100);
    expect(progress.frontier.after.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(JSON.stringify(progress.frontier))).toBeLessThanOrEqual(2048);
    if (progress.state === 'complete') break;
  }
  // Local work complete still supplies no fixed participant publication authority.
  expect(await store.readMapping(f.pool, original)).toEqual({ state: 'pending', original, job });
  expect((await store.readJob(f.pool, job!))?.participants).toEqual({ 'search-canonical-index': null, 'library-private-follow-counts': null });
});

test('native handoff preserves in flight verification and reversal for durable redrive', async () => {
  const f = fixtures[3]!;
  const catalogue = (await f.create('Reviewed person')).subject.id;
  const approved = await approvedVerification(f, catalogue);
  const { account, workflow } = approved;
  const agent = await ensureAccountAgent(f.pool, { account, kind: 'person', name: null });
  const receipt = workflow.receiptId;
  // Owner-produced immutable decision is persisted before the actual durable-step callback starts.
  const inFlight = await withInFlightControlMove(f, () => mergeVerifiedAgent(f.pool, workflow));
  expect(inFlight.state, 'NO early successful callback while native control/publication is unavailable').toBe('unavailable');
  if (inFlight.state !== 'unavailable') throw new Error('Unpublished verification returned early success');
  expect(classifyUnavailability(inFlight.error), 'handoff is retryable, never failed/denied review').toBeDefined();
  const savedPending = await f.admin.query(
    'SELECT pending_agent_receipt_id, pending_agent_subject_id, agent_verified FROM access.account WHERE account_id=$1', [account],
  );
  expect(savedPending.rows).toEqual([{ pending_agent_receipt_id: receipt, pending_agent_subject_id: catalogue, agent_verified: false }]);
  // The existing step is redriven with the exact decision receipt after owner availability returns.
  await mergeVerifiedAgent(f.pool, workflow);
  const verified = await verifyAccountAgent(f.pool, { account, catalogue, receipt });
  expect(Object.keys(verified).sort()).toEqual(['component', 'redirected', 'revision', 'subject', 'survivor']);
  expect(verified.subject.id).toBe(catalogue);
  expect(verified.redirected).toBe(agent.subject.id);
  const store = await nativeEpochStore();
  const verification = await store.findJob(f.pool, { kind: 'account-agent.verify', account, receipt });
  expect(verification?.state, 'unchanged successful DTO requires actual publication').toBe('published');
  expect(verification?.mapping?.state).toBe('complete');
  for (const name of ['search-canonical-index', 'library-private-follow-counts'] as const) expect(verification?.participants[name]?.state).toBe('complete');
  const replay = await verifyAccountAgent(f.pool, { account, catalogue, receipt });
  expect(replay.subject.id).toBe(catalogue);
  expect((await store.findJob(f.pool, { kind: 'account-agent.verify', account, receipt }))?.ref).toEqual(verification?.ref);
  // Account completion uses its actual consuming callback ONLY after the published Semantic success above.
  await completeAgentVerification(f.pool, workflow, approved.clock);
  const reversedDecision = await approved.commands.release(await approved.context('person'), { accountId: account, key: crypto.randomUUID() });
  expect(reversedDecision.value.verificationReceiptId).toBe(receipt);
  const reversing = await withInFlightControlMove(f, () => unmergeVerifiedAgent(f.pool, reversedDecision.value));
  expect(reversing.state, 'NO early reversal success during unavailable handoff').toBe('unavailable');
  if (reversing.state !== 'unavailable') throw new Error('Unpublished reversal returned early success');
  expect(classifyUnavailability(reversing.error)).toBeDefined();
  const reversalReceipt = reversedDecision.value.receiptId;
  expect((await f.admin.query('SELECT pending_agent_receipt_id FROM access.account WHERE account_id=$1', [account])).rows)
    .toEqual([{ pending_agent_receipt_id: reversalReceipt }]);
  await unmergeVerifiedAgent(f.pool, reversedDecision.value);
  const reversed = await unverifyAccountAgent(f.pool, { account, receipt: reversalReceipt });
  expect(reversed.subject.id).toBe(agent.subject.id);
  const reversal = await store.findJob(f.pool, { kind: 'account-agent.unverify', account, receipt: reversalReceipt });
  expect(reversal?.state).toBe('published');
  expect(reversal?.intent).toMatchObject({ kind: 'unmerge', original: agent.subject.id, undoJob: verification?.ref, verificationReceipt: receipt });
  expect((await unverifyAccountAgent(f.pool, { account, receipt: reversalReceipt })).subject.id).toBe(agent.subject.id);
  expect((await store.findJob(f.pool, { kind: 'account-agent.unverify', account, receipt: reversalReceipt }))?.ref).toEqual(reversal?.ref);
});
