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

// Additive schedules: the four preceding acceptance cases and their assertions remain unchanged.
import { duringNativeSQL, libraryCutoverInput, nativeCutoverCoordinator } from './support/identity-epoch-cutover.ts';
import { noEffect } from '../../src/command/command.ts';

async function isolatedCutover(work: (f: Awaited<ReturnType<typeof cutoverFixture>>) => Promise<void>) {
  const f = await cutoverFixture();
  try {
    await work(f);
  } finally {
    await f.close();
  }
}

test('Library canonical directory effects are required before the fixed participant can publish and redrive completes all records', async () => {
  await isolatedCutover(async (f) => {
    const original = (await f.create('Directory original', 0xad10)).subject.id;
    const terminal = (await f.create('Directory terminal', 0xae10)).subject.id;
    // Actual Library owner commands run before the missing Store/coordinator boundary.
    const input = await libraryCutoverInput(f, [original, terminal]);
    const stored = (
      await f.admin.query(
        'SELECT member_id,subject_id,note,ordinal_key FROM library.collection_member WHERE collection_id=$1 ORDER BY member_id',
        [input.collection.id],
      )
    ).rows;
    expect(stored).toHaveLength(2);
    const follows = (
      await f.admin.query('SELECT target_id,state,reason FROM library.follow WHERE account_id=$1 ORDER BY target_id', [
        input.account,
      ])
    ).rows;
    expect(follows).toHaveLength(2);
    const store = await nativeEpochStore();
    const job = (
      await (
        await ordinaryAdmission(f, store, {
          kind: 'merge',
          survivor: terminal,
          redirected: original,
          release: release.digest,
        })
      ).execute()
    ).value;
    const resume = await nativeCutoverCoordinator();
    await duringNativeSQL(
      f,
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+library\.canonical_source_(?:fact|state)\b/i,
      () => resume(f.pool, job),
      async () => {
        // A real canonical effect is still uncommitted: a follow-only observation cannot publish it.
        expect(await store.readEpoch(f.pool)).toMatchObject({ state: 'pending', job });
        await expect(
          runCommand(f.pool, { partition: store.controlPartition }, (tx) => store.publish(tx, job)),
        ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
      },
    );
    const published = await store.readJob(f.pool, job);
    expect(published?.state).toBe('published');
    expect(published?.participants['library-private-follow-counts']?.state).toBe('complete');
    expect(published?.participants['search-canonical-index']?.state).toBe('complete');
    await resume(f.pool, job); // Lost coordinator result: no second job or repeated source write.
    expect((await store.readJob(f.pool, job))?.ref).toEqual(job);
    expect(
      (
        await f.admin.query(
          'SELECT member_id,subject_id,note,ordinal_key FROM library.collection_member WHERE collection_id=$1 ORDER BY member_id',
          [input.collection.id],
        )
      ).rows,
    ).toEqual(stored);
    expect(
      (
        await f.admin.query(
          'SELECT target_id,state,reason FROM library.follow WHERE account_id=$1 ORDER BY target_id',
          [input.account],
        )
      ).rows,
    ).toEqual(follows);
    const canonical = (
      await f.admin.query(
        'SELECT canonical_subject_id,stored_subject_id FROM library.canonical_source_fact WHERE collection_id=$1 ORDER BY stored_subject_id',
        [input.collection.id],
      )
    ).rows;
    expect(canonical).toEqual(
      [original, terminal].sort().map((stored_subject_id) => ({ canonical_subject_id: terminal, stored_subject_id })),
    );
  });
});

test('publication between released mapping reads and a newer pending job never reuse the old source basis', async () => {
  await isolatedCutover(async (f) => {
    const original = (await f.create('Epoch source', 0xbd10)).subject.id;
    const terminal = (await f.create('First terminal', 0xbe10)).subject.id;
    const next = (await f.create('Next terminal', 0xbf10)).subject.id;
    const store = await nativeEpochStore();
    const first = (
      await (
        await ordinaryAdmission(f, store, {
          kind: 'merge',
          survivor: terminal,
          redirected: original,
          release: release.digest,
        })
      ).execute()
    ).value;
    const resume = await nativeCutoverCoordinator();
    const observed = await afterSourceRelease(
      f,
      () => store.readMapping(f.pool, original),
      () => resume(f.pool, first),
    );
    expect(
      observed.state === 'unavailable' ||
        (observed.state === 'mapped' && observed.terminal === terminal && observed.epoch === first.epoch),
    ).toBe(true);
    expect(await store.readMapping(f.pool, original)).toMatchObject({ state: 'mapped', terminal, epoch: first.epoch });
    const second = await ordinaryAdmission(f, store, {
      kind: 'merge',
      survivor: next,
      redirected: terminal,
      release: release.digest,
    });
    let newer: import('../../src/semantic/identity-epoch-contract.ts').IdentityJobRef | undefined;
    const afterNewer = await afterSourceRelease(
      f,
      () => store.readMapping(f.pool, original),
      async () => {
        newer = (await second.execute()).value;
      },
    );
    expect(newer?.epoch).toBeGreaterThan(first.epoch);
    expect(afterNewer).toEqual({ state: 'pending', original, job: newer });
  });
});

test('native receipt reconciliation rejects same-position wrong transaction owner scope and unfinished prior mapping page', async () => {
  await isolatedCutover(async (f) => {
    const original = (await f.create('Receipt original', 0xcd10)).subject.id;
    const terminal = (await f.create('Receipt terminal', 0xce10)).subject.id;
    await seedLegacyGroup(f, original, 101);
    const store = await nativeEpochStore();
    const job = (
      await (
        await ordinaryAdmission(f, store, {
          kind: 'merge',
          survivor: terminal,
          redirected: original,
          release: release.digest,
        })
      ).execute()
    ).value;
    const step = await nativeMappingStep();
    const first = await step(f.pool, job);
    expect(first.state).toBe('more');
    // A real but unfinished record must not certify complete observation or prior-page custody.
    await expect(store.reconcileStepReceipt(f.pool, first.receipt)).rejects.toBeDefined();
    for (const receipt of [
      { ...first.receipt, native: { ...first.receipt.native, transactionId: crypto.randomUUID() } },
      {
        ...first.receipt,
        native: { ...first.receipt.native, partition: (first.receipt.native.partition + 1) % PARTITIONS },
      },
      { ...first.receipt, native: { ...first.receipt.native, epoch: first.receipt.native.epoch + 1 } },
      { ...first.receipt, job: { ...job, jobId: crypto.randomUUID() } },
      { ...first.receipt, step: 'library-private-follow-counts' as const },
    ])
      await expect(store.reconcileStepReceipt(f.pool, receipt)).rejects.toBeDefined();
    await expect(
      runCommand(f.pool, { partition: store.controlPartition }, (tx) => store.publish(tx, job)),
    ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
    expect(await store.readEpoch(f.pool)).toMatchObject({ state: 'pending', job });
    let last = first;
    for (let page = 0; page < 100 && last.state !== 'complete'; page++) last = await step(f.pool, job);
    expect(last.state).toBe('complete');
    expect(await store.reconcileStepReceipt(f.pool, last.receipt)).toEqual(last);
    expect(await store.reconcileStepReceipt(f.pool, last.receipt)).toEqual(last);
  });
});

test('same-effect home admission rolls back its caller effect and first absent gate insertion serializes', async () => {
  await isolatedCutover(async (f) => {
    const original = (await f.create('First apply original', 0xdd10)).subject.id;
    const terminal = (await f.create('First apply destination', 0xde10)).subject.id;
    const store = await nativeEpochStore();
    const basis = await store.readMapping(f.pool, original);
    expect(basis.state).toBe('mapped');
    if (basis.state !== 'mapped') throw new Error('Actual creation did not initialize mapping');
    const job = (
      await (
        await ordinaryAdmission(f, store, {
          kind: 'merge',
          survivor: terminal,
          redirected: original,
          release: release.digest,
        })
      ).execute()
    ).value;
    const step = await nativeMappingStep();
    const before = await f.snapshot([original, terminal]);
    await expect(
      runCommand(f.pool, { partition: home(terminal) }, async (tx) => {
        await store.admitHomeEffect(tx, { kind: 'structural', job, original });
        return noEffect(null);
      }),
    ).rejects.toBeDefined(); // Wrong actual source home, regardless of matching job strings.
    expect(await f.snapshot([original, terminal])).toEqual(before);
    await duringNativeSQL(
      f,
      /INSERT\s+INTO\s+semantic\.identity_epoch_home_gate/i,
      () => step(f.pool, job),
      async () => {
        // Installer is paused before its first insert. A genuinely stale old-destination apply must not obtain
        // new-destination authority from absence. No fabricated positive is written after this call.
        await expect(
          runCommand(f.pool, { partition: home(terminal) }, async (tx) => {
            await store.admitHomeEffect(tx, { kind: 'follow-count', original, terminal, epoch: basis.epoch });
            return noEffect(null);
          }),
        ).rejects.toBeDefined();
      },
    );
    expect(await store.readEpoch(f.pool)).toMatchObject({ state: 'pending', job });
  });
});

test('all named and unlabeled person and organization births use their real source transaction without Search', async () => {
  await isolatedCutover(async (f) => {
    const originals = [];
    for (const kind of ['person', 'organization'] as const)
      for (const name of ['Named native agent', null]) {
        const account = newId(0xed10);
        const agent = await ensureAccountAgent(f.pool, { account, kind, name });
        expect(agent.created).toBe(true);
        expect(agent.subject.revision).toBe(1);
        originals.push(agent.subject.id);
        expect((await ensureAccountAgent(f.pool, { account, kind, name })).subject.id).toBe(agent.subject.id);
      }
    const store = await nativeEpochStore();
    for (const original of originals)
      expect(await store.readMapping(f.pool, original)).toMatchObject({
        state: 'mapped',
        original,
        terminal: original,
      });
  });
});

import { observeCutoverSQL } from './support/identity-epoch-cutover.ts';

test('immutable affected input raw page boundary charges metadata lookahead and replay before returning unique originals', async () => {
  await isolatedCutover(async (f) => {
    const original = (await f.create('Boundary original', 0xfd10)).subject.id;
    const terminal = (await f.create('Boundary terminal', 0xfe10)).subject.id;
    const inherited = await seedLegacyGroup(f, original, 99); // 101 including BOTH self/terminal rows.
    const store = await nativeEpochStore();
    const job = (
      await (
        await ordinaryAdmission(f, store, {
          kind: 'merge',
          survivor: terminal,
          redirected: original,
          release: release.digest,
        })
      ).execute()
    ).value;
    const seen = [];
    let after: string | null = null;
    for (let pages = 0; pages < 100; pages++) {
      const observed = await observeCutoverSQL(f, () => store.pageChanges(f.pool, job, after));
      expect(
        observed.queries.reduce((sum, q) => sum + q.rows, 0),
        'metadata/raw input/lookahead are not free',
      ).toBeLessThanOrEqual(100);
      expect(
        observed.queries.some((q) => /\bLIMIT\s+101\b/i.test(q.sql)),
        'no hidden row 101',
      ).toBe(false);
      expect(await store.pageChanges(f.pool, job, after)).toEqual(observed.value);
      seen.push(...observed.value.changes);
      if (observed.value.next === null) break;
      expect(observed.value.next > (after ?? '')).toBe(true);
      after = observed.value.next;
    }
    expect(seen.map((change) => change.original)).toEqual([original, terminal, ...inherited].sort());
    expect(new Set(seen.map((change) => change.original)).size).toBe(101);
    expect(seen.every((change) => change.terminal === terminal)).toBe(true);
  });
});

test('current generation reads stay independent of completed history while deep receipt replay retains native custody', async () => {
  await isolatedCutover(async (f) => {
    const original = (await f.create('Retained original', 0x1d10)).subject.id;
    const other = (await f.create('Retained destination', 0x1e10)).subject.id;
    let terminal = original;
    const store = await nativeEpochStore();
    const resume = await nativeCutoverCoordinator();
    const receipts: Awaited<ReturnType<typeof ordinaryAdmission>>[] = [];
    const history: import('../../src/semantic/identity-epoch-contract.ts').IdentityJobRef[] = [];
    let firstStatements: number | undefined;
    let undoJob: import('../../src/semantic/identity-epoch-contract.ts').IdentityJobRef | undefined;
    for (let generation = 1; generation <= 64; generation++) {
      // Fixed two-subject population: grow history independently of membership and owner data.
      const merging = generation % 2 === 1;
      const intent: import('../../src/semantic/identity-epoch-contract.ts').IdentityIntent = merging
        ? { kind: 'merge', survivor: other, redirected: original, release: release.digest }
        : { kind: 'unmerge', original, undoJob: undoJob!, verificationReceipt: null, release: release.digest };
      const request = await ordinaryAdmission(f, store, intent);
      const job = (await request.execute()).value;
      if (merging) undoJob = job;
      receipts.push(request);
      history.push(job);
      await resume(f.pool, job);
      expect((await store.readJob(f.pool, job))?.state).toBe('published');
      terminal = merging ? other : original;
      if (![1, 8, 64].includes(generation)) continue;
      const observed = await observeCutoverSQL(f, () => store.readMapping(f.pool, original));
      expect(observed.value).toMatchObject({ state: 'mapped', terminal, epoch: job.epoch });
      expect(observed.queries.some((q) => /WITH\s+RECURSIVE|parent_generation|ancestor_generation/i.test(q.sql))).toBe(
        false,
      );
      firstStatements ??= observed.queries.length;
      expect(observed.queries.length).toBe(firstStatements);
      // Current reads use the flat current basis. Receipt replay uses minimized retained custody instead of
      // resurrecting first/deep generations or advancing a saved empty reclamation frontier over a later job.
      for (const index of new Set([0, Math.floor((history.length - 1) / 2), history.length - 1])) {
        expect((await receipts[index]!.execute()).value).toEqual(history[index]);
        expect((await store.findJob(f.pool, receipts[index]!.receipt))?.state).toBe('published');
      }
      await resume(f.pool, job);
      expect(await store.readMapping(f.pool, original)).toEqual(observed.value);
    }
  });
});
