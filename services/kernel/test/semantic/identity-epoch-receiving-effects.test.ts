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


test('an authentic native transaction cannot become receiving proof through the original-home structural branch', async () => {
  const input = await admittedReceivingJob(f);
  const before = await input.members();
  // A real command locator is deliberately NOT a receiving record. No fixture proof is inserted.
  const native = await runCommand(f.pool, { partition: home(input.original) }, async () => noEffect(null));
  const receiving = {
    kind: 'receiving' as const,
    original: input.original,
    job: input.job,
    effectKey: 'library-owner-rekey',
    receipt: {
      partition: native.partition,
      epoch: native.epoch,
      position: native.position,
      transactionId: native.transactionId,
    },
  };
  for (const partition of [home(input.original), home(input.library.collection.id)]) {
    for (const effect of [
      receiving,
      { ...receiving, job: { ...input.job, jobId: newId(0x8b20) } },
      { ...receiving, job: { ...input.job, epoch: input.job.epoch + 1n } },
      { ...receiving, effectKey: 'another-owner-rekey' },
      { ...receiving, receipt: { ...receiving.receipt, transactionId: randomUUID() } },
    ]) {
      await expect(runCommand(f.pool, { partition }, async tx => {
        await store.admitHomeEffect(tx, effect);
        return noEffect(null);
      })).rejects.toMatchObject({ code: 'identity_effect_stale' });
    }
  }
  expect(await input.members()).toEqual(before);
  expect((await store.readJob(f.pool, input.job))?.participants['library-private-follow-counts']).toBeNull();
  await expect(runCommand(f.pool, { partition: home(input.job.jobId) }, tx => store.publish(tx, input.job)))
    .rejects.toMatchObject({ code: 'identity_participants_incomplete' });
});

// Product receiving admission, rather than a fixture-written grant, is the regression boundary.
test('a committed source-specific receiving record admits only its exact home job owner and effect', async () => {
  const { prepareIdentityReceivingEffect, lookupIdentityReceivingEffect } =
    await import('../../src/semantic/identity-receiving-effects.ts');
  const input = await admittedReceivingJob(f);
  const effect = await prepareIdentityReceivingEffect(f.pool, {
    job: input.job, original: input.original, owner: input.library.collection.id,
    sourceId: input.library.collection.id, scope: input.original,
    effectKey: 'library-owner-rekey', disposition: 'NEW',
  });
  const before = await input.members();
  await runCommand(f.pool, { partition: effect.receipt.partition }, async tx => {
    const record = await lookupIdentityReceivingEffect(tx, effect);
    expect(record?.owner).toBe(input.library.collection.id);
    expect(record?.source.id).toBe(input.library.collection.id);
    await store.admitHomeEffect(tx, effect);
    return noEffect(null);
  });
  for (const invalid of [
    { ...effect, effectKey: 'wrong-effect' },
    { ...effect, original: input.terminal },
    { ...effect, job: { ...effect.job, epoch: effect.job.epoch + 1n } },
    { ...effect, job: { ...effect.job, jobId: newId(0x8b30) } },
    { ...effect, receipt: { ...effect.receipt, epoch: effect.receipt.epoch + 1 } },
    { ...effect, receipt: { ...effect.receipt, transactionId: randomUUID() } },
  ]) await expect(runCommand(f.pool, { partition: effect.receipt.partition }, async tx => {
    await store.admitHomeEffect(tx, invalid);
    return noEffect(null);
  })).rejects.toMatchObject({ code: 'identity_effect_stale' });
  await expect(runCommand(f.pool, { partition: home(input.original) }, async tx => {
    await store.admitHomeEffect(tx, effect);
    return noEffect(null);
  })).rejects.toMatchObject({ code: 'identity_effect_stale' });
  expect(await input.members()).toEqual(before);
  expect((await store.readJob(f.pool, input.job))?.participants['library-private-follow-counts']).toBeNull();
});

test('receiving source selection cannot be replaced with a different owner source or scope', async () => {
  const { prepareIdentityReceivingEffect } = await import('../../src/semantic/identity-receiving-effects.ts');
  const input = await admittedReceivingJob(f);
  const selected = {
    job: input.job, original: input.original, owner: input.library.collection.id,
    sourceId: input.library.collection.id, scope: input.original,
    effectKey: 'library-owner-rekey', disposition: 'NEW' as const,
  };
  for (const invalid of [
    { ...selected, owner: newId(0xac10) },
    { ...selected, sourceId: newId(0xac10) },
    { ...selected, scope: newId(0x8b40) },
    { ...selected, job: { ...input.job, jobId: newId(0x8b50) } },
    { ...selected, original: newId(0x8b60) },
  ]) await expect(prepareIdentityReceivingEffect(f.pool, invalid)).rejects.toMatchObject({
    code: 'identity_effect_stale',
  });
});
