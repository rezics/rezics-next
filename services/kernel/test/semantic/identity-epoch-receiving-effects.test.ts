import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { newId } from '../../src/route/route.ts';
import { identityEpochStore as store } from '../../src/semantic/identity-epoch-store.ts';
import { epochFixture, home, type EpochFixture } from './support/identity-epoch.ts';
import { admittedReceivingJob, completeReceivingParticipant } from './support/identity-receiving-effects.ts';

let f: EpochFixture;
beforeAll(async () => { f = await epochFixture(); });
afterAll(async () => { await f?.close(); });

test('real native receiving-home admission permits the fixed participant owned effect and preserves source control custody', async () => {
  const input = await admittedReceivingJob(f);
  expect(home(input.original)).not.toBe(home(input.library.collection.id));
  const before = await input.members();
  const progress = await completeReceivingParticipant(f, input.job);
  const accepted = await store.reconcileStepReceipt(f.pool, progress.receipt);
  expect(accepted).toEqual(progress);
  expect(await store.reconcileStepReceipt(f.pool, progress.receipt)).toEqual(accepted);
  expect(await input.members()).toEqual(before);
  expect((await store.readJob(f.pool, input.job))?.participants['library-private-follow-counts']).toEqual(accepted);
  // Library completion cannot fabricate the separate mapping and Search acknowledgements.
  await expect(runCommand(f.pool, { partition: home(input.job.jobId) }, tx => store.publish(tx, input.job)))
    .rejects.toMatchObject({ code: 'identity_participants_incomplete' });
  for (const receipt of [
    { ...progress.receipt, job: { ...input.job, jobId: newId(0x8b10) } },
    { ...progress.receipt, native: { ...progress.receipt.native, transactionId: randomUUID() } },
    { ...progress.receipt, native: { ...progress.receipt.native, epoch: progress.receipt.native.epoch + 1 } },
  ]) await expect(store.reconcileStepReceipt(f.pool, receipt))
    .rejects.toMatchObject({ code: 'identity_step_receipt_invalid' });
});

test('a real admitted job and a platform command alone do not admit an unregistered receiving owner', async () => {
  const input = await admittedReceivingJob(f);
  const before = await input.members();
  await expect(runCommand(f.pool, { partition: home(input.library.collection.id) }, async tx => {
    await store.admitHomeEffect(tx, { kind: 'structural', original: input.original, job: input.job });
    throw new Error('unregistered receiving effect was admitted');
  })).rejects.toMatchObject({ code: 'identity_effect_stale' });
  await expect(runCommand(f.pool, { partition: home(input.library.collection.id) }, async tx => {
    await store.admitHomeEffect(tx, {
      kind: 'follow-count', original: input.original, terminal: input.terminal, epoch: input.job.epoch,
    });
    return noEffect(null);
  })).rejects.toMatchObject({ code: 'identity_effect_stale' });
  expect(await input.members()).toEqual(before);
});
