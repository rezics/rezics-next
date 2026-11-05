import { expect, test } from 'bun:test';
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
    expect(job!.participants['library-private-follow-counts']).toBeNull();
    await expect(f.publish(input.job)).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
    expect((await f.readJob(input.job))!.state).not.toBe('published');
    expect(f.operationBackendIds().size).toBeLessThanOrEqual(1);
  } finally {
    await f.close();
  }
}, 180_000);
