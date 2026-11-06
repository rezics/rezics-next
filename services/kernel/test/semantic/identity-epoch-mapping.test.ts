import { expect, test } from 'bun:test';
import { stepLibraryIdentityEpoch } from '../../src/library/identity-epoch-participant.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import { createIdentityMappingFixture } from './support/identity-epoch-mapping.ts';

test('native mapping drains actual admitted cross-home effects with real receipt custody but cannot publish missing participants', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const input = await f.admitMerge();
    const progress = await f.drainMapping(input.job, 512);
    expect(progress.length).toBeGreaterThan(0);
    const final = progress.at(-1)!;
    expect(final.job).toEqual(input.job);
    expect(final.state).toBe('complete');
    expect(final.receipt.step).toBe('mapping');
    expect(final.receipt.version).toBe(1);
    for (const row of progress) {
      expect(row.frontier.after.length).toBeLessThanOrEqual(8);
      expect(Buffer.byteLength(JSON.stringify(row.frontier))).toBeLessThanOrEqual(2048);
    }
    for (const original of input.redirectedOriginals)
      expect(await f.nativeDirectRedirect(original)).toBe(input.survivor);
    const ack = await identityEpochStore().reconcileStepReceipt(f.pool, final.receipt);
    expect(ack).toEqual(final);
    const job = await f.readJob(input.job);
    expect(job!.mapping!.state).toBe('complete');
    expect(job!.participants['search-canonical-index']).toBeNull();
    const library = await stepLibraryIdentityEpoch(f.pool, input.job);
    expect(library.state).toBe('complete');
    expect(library.receipt.step).toBe('library-private-follow-counts');
    const libraryAck = await identityEpochStore().reconcileStepReceipt(f.pool, library.receipt);
    expect(libraryAck.state).toBe('complete');
    expect((await f.readJob(input.job))!.participants['library-private-follow-counts']?.state).toBe('complete');
    await expect(f.publish(input.job)).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
    expect((await f.readJob(input.job))!.state).not.toBe('published');
    expect(f.operationBackendIds().size).toBeLessThanOrEqual(1);
  } finally {
    await f.close();
  }
}, 180_000);

test('account-agent verify mapping drains from original Access source for linked agent subjects', async () => {
  const f = await createIdentityMappingFixture({ poolMax: 1 });
  try {
    const input = await f.admitAccountAgentVerify();
    expect(input.source.input.receipt).toEqual(input.receipt);
    expect(input.source.input.intent.kind).toBe('merge');
    const progress = await f.drainMapping(input.job, 512);
    expect(progress.at(-1)).toMatchObject({
      job: input.job,
      state: 'complete',
      receipt: { step: 'mapping', version: 1 },
    });
    const job = await f.readJob(input.job);
    expect(job!.mapping!.state).toBe('complete');
    expect(job!.receipt).toEqual(input.receipt);
    await expect(f.publish(input.job)).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
  } finally {
    await f.close();
  }
}, 180_000);
