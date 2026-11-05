import { expect, test } from 'bun:test';
import { resumeIdentityEpochJob, waitIdentityEpochPublished } from '../../src/semantic/identity-epoch-coordinator.ts';
import { createIdentityCoordinatorFixture } from './support/identity-epoch-coordinator.ts';

test('actual fixed native coordinator publishes the same admitted job once and replay preserves custody', async () => {
  const f = await createIdentityCoordinatorFixture({ poolMax: 1 });
  try {
    const { job } = await f.admitRealCrossHomeMergeWithAllRoleFacts();
    expect((await f.readJob(job))!.state).not.toBe('published');
    await resumeIdentityEpochJob(f.pool, job);
    await waitIdentityEpochPublished(f.pool, job);
    const published = (await f.readJob(job))!;
    expect(published.ref).toEqual(job);
    expect(published.state).toBe('published');
    expect(published.mapping?.state).toBe('complete');
    expect(published.participants['search-canonical-index']?.state).toBe('complete');
    expect(published.participants['library-private-follow-counts']?.state).toBe('complete');
    expect(await f.nativePublicationCount(job)).toBe(1);
    await f.assertRealCanonicalEffectsAndImmutableOriginals(job);
    await resumeIdentityEpochJob(f.pool, job);
    await waitIdentityEpochPublished(f.pool, job);
    expect((await f.readJob(job))!.ref).toEqual(job);
    expect(await f.nativePublicationCount(job)).toBe(1);
    expect(f.operationBackendIds().size).toBeLessThanOrEqual(1);
  } finally {
    await f.close();
  }
}, 180_000);
