import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import { ensureAccountAgent, verifyAccountAgent, unverifyAccountAgent } from '../../src/semantic/account-agents.ts';
import type {
  IdentityJobRef,
  IdentityReceipt,
  IdentityEpochStore,
} from '../../src/semantic/identity-epoch-contract.ts';
import {
  digest,
  epochFixture,
  nativeEpochStore,
  nativeMappingStep,
  release,
  type EpochFixture,
} from './support/identity-epoch.ts';

let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
  await f?.close();
});

function successfulAgentDTO(value: Awaited<ReturnType<typeof verifyAccountAgent>>) {
  expect(Object.keys(value).sort()).toEqual(['component', 'redirected', 'revision', 'subject', 'survivor']);
  expect(value.component.position).toBeTypeOf('bigint');
  expect(value.component.position).toBeGreaterThan(0n);
  expect(value.subject.id).toBeString();
  expect(value.revision).toBeGreaterThanOrEqual(1);
}
async function publishedJob(store: IdentityEpochStore, receipt: IdentityReceipt) {
  const job = await store.findJob(f.pool, receipt);
  expect(job?.state, 'a successful unchanged DTO requires a durably published job').toBe('published');
  expect(job?.mapping?.state).toBe('complete');
  for (const name of ['search-canonical-index', 'library-private-follow-counts'] as const) {
    expect(job?.participants[name]?.state, `publication must include actual ${name} ACK`).toBe('complete');
    expect(job?.participants[name]?.job).toEqual(job?.ref);
  }
  return job!;
}

test('serialized durable epoch publication requires bounded actual mapping index and participant work with crash replay and unchanged Accounts success semantics', async () => {
  // Real migrated creation and existing Accounts inputs/DTOs run BEFORE checking the missing STORE.
  const catalogue = (await f.create('Reviewed catalogue person')).subject.id;
  const account = f.accounts.editor;
  const agent = await ensureAccountAgent(f.pool, { account, kind: 'person', name: 'Unverified account person' });
  expect(agent.subject.revision).toBe(1);
  const receipt = randomUUID();
  const input = { account, catalogue, receipt };
  const verified = await verifyAccountAgent(f.pool, input);
  successfulAgentDTO(verified);
  expect(verified.subject.id).toBe(catalogue);
  expect(verified.survivor).toBe(catalogue);
  expect(verified.redirected).toBe(agent.subject.id);
  const replay = await verifyAccountAgent(f.pool, input);
  successfulAgentDTO(replay);
  expect([replay.survivor, replay.redirected, replay.subject.id]).toEqual([catalogue, agent.subject.id, catalogue]);

  const store = await nativeEpochStore();
  const job = await publishedJob(store, { kind: 'account-agent.verify', account, receipt });
  // Re-delivery of the same native callable after a committed result was lost cannot allocate a new epoch.
  const redelivery = await verifyAccountAgent(f.pool, input);
  successfulAgentDTO(redelivery);
  expect([redelivery.survivor, redelivery.redirected, redelivery.subject.id]).toEqual([
    catalogue,
    agent.subject.id,
    catalogue,
  ]);
  expect((await publishedJob(store, { kind: 'account-agent.verify', account, receipt })).ref).toEqual(job.ref);
  const reversalReceipt = randomUUID();
  const reversed = await unverifyAccountAgent(f.pool, { account, receipt: reversalReceipt });
  successfulAgentDTO(reversed);
  expect(reversed.subject.id).toBe(agent.subject.id);
  const reversedReplay = await unverifyAccountAgent(f.pool, { account, receipt: reversalReceipt });
  successfulAgentDTO(reversedReplay);
  expect([
    reversedReplay.survivor,
    reversedReplay.redirected,
    reversedReplay.revision,
    reversedReplay.subject.id,
  ]).toEqual([reversed.survivor, reversed.redirected, reversed.revision, reversed.subject.id]);
  const reversal = await publishedJob(store, { kind: 'account-agent.unverify', account, receipt: reversalReceipt });
  expect(reversal.ref.epoch).toBeGreaterThan(job.ref.epoch);
});

test('native STORE serializes pending work and mapping replay cannot publish without fixed participant ACKs', async () => {
  const first = await f.create();
  const second = await f.create();
  const unrelated = await f.create('Unaffected point identity');
  expect(first.subject.revision).toBe(1);
  const store = await nativeEpochStore();
  const mappingStep = await nativeMappingStep();
  const [survivor, redirected] = [first.subject.id, second.subject.id].sort() as [string, string];
  const initial = await store.readEpoch(f.pool);
  expect(initial.state).toBe('published');
  const key = randomUUID();
  const actor = await f.actor();
  const receipt: IdentityReceipt = {
    kind: 'subject.merge',
    command: {
      actorAccountId: actor.accountId,
      kind: 'subject.merge',
      key,
      digest: digest(key),
    },
  };
  const admit = async (otherKey = key) =>
    runCommand(
      f.pool,
      {
        partition: store.controlPartition,
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
        authorization: await f.authorization('subject:merge'),
      },
      (tx) =>
        store.admit(tx, {
          intent: { kind: 'merge', survivor, redirected, release: release.digest },
          receipt:
            otherKey === key
              ? receipt
              : {
                  kind: 'subject.merge',
                  command: {
                    actorAccountId: actor.accountId,
                    kind: 'subject.merge',
                    key: otherKey,
                    digest: digest(otherKey),
                  },
                },
        }),
    );
  const job: IdentityJobRef = (await admit()).value;
  expect(await store.readEpoch(f.pool)).toMatchObject({ state: 'pending', job });
  expect((await admit()).value).toEqual(job);
  await expect(admit(randomUUID())).rejects.toMatchObject({ code: 'identity_epoch_busy' });
  expect(await store.readMapping(f.pool, redirected)).toMatchObject({ state: 'pending', job });
  expect(await store.readMapping(f.pool, unrelated.subject.id)).toMatchObject({
    state: 'mapped',
    original: unrelated.subject.id,
    terminal: unrelated.subject.id,
  });
  const changes = await store.pageChanges(f.pool, job, null);
  expect(changes.changes).toContainEqual({ original: redirected, previousTerminal: redirected, terminal: survivor });
  expect(changes.changes.length).toBeLessThanOrEqual(100);
  let complete = false;
  for (let step = 0; step < 100; step++) {
    const progress = await mappingStep(f.pool, job);
    expect(progress.job).toEqual(job);
    expect(progress.work.rows).toBeGreaterThanOrEqual(0);
    expect(progress.frontier.after.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(JSON.stringify(progress.frontier))).toBeLessThanOrEqual(2048);
    // Drop the returned result: the next call must use the COMMITTED native frontier, like crash redelivery.
    if (progress.state === 'complete') {
      complete = true;
      break;
    }
  }
  expect(complete, 'finite fixed input must finish bounded mapping maintenance').toBe(true);
  const saved = await store.readJob(f.pool, job);
  await mappingStep(f.pool, job);
  expect((await store.readJob(f.pool, job))?.mapping?.frontier).toEqual(saved?.mapping?.frontier);
  // No fake Search/Library implementation: STORE/mapping acceptance remains independently runnable.
  await expect(
    runCommand(f.pool, { partition: store.controlPartition }, (tx) => store.publish(tx, job)),
  ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
  expect(await store.readEpoch(f.pool)).toMatchObject({ state: 'pending', job });
});
