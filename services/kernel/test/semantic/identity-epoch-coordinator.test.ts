import { expect, test } from 'bun:test';
import { resumeIdentityEpochJob, waitIdentityEpochPublished } from '../../src/semantic/identity-epoch-coordinator.ts';
import { createIdentityCoordinatorFixture } from './support/identity-epoch-coordinator.ts';

test('failed fixed receiving resumes the original admitted job through native publication once', async () => {
  const f = await createIdentityCoordinatorFixture({ poolMax: 1 });
  try {
    const { job, redirected, terminal } = await f.admitRealCrossHomeMergeWithAllRoleFacts();
    expect((await f.readJob(job))!.state).not.toBe('published');
    const failure = f.armTransientSourceSupportFailure();
    await f.startCoordinator();
    await failure.reached;
    failure.release();
    await expect(waitIdentityEpochPublished(f.pool, job)).rejects.toMatchObject({
      code: 'identity_epoch_unavailable',
    });
    expect(f.sourceSupportFailureSeen()).toBe(true);

    // The terminal SDK history remains immutable; explicit resume appends a deterministic segment
    // which continues the native job's saved cursor and participant receipts.
    await resumeIdentityEpochJob(f.pool, job);
    await waitIdentityEpochPublished(f.pool, job);
    const published = (await f.readJob(job))!;
    expect(published.ref).toEqual(job);
    expect(published.state).toBe('published');
    expect(published.mapping?.state).toBe('complete');
    expect(published.participants['search-canonical-index']?.state).toBe('complete');
    expect(published.participants['library-private-follow-counts']?.state).toBe('complete');
    expect(await f.nativePublicationCount(job)).toBe(1);
    const effects = await f.assertRealCanonicalEffectsAndImmutableOriginals(job);
    expect(effects.mapping).toMatchObject({ state: 'mapped', original: redirected, terminal, epoch: job.epoch });
    expect(effects.redirect).toEqual({ subjectId: terminal, requestedSubjectId: redirected });
    expect(effects.canonical?.subject.id).toBe(terminal);
    expect(effects.originalAfter).toEqual(effects.originalBefore);
    await resumeIdentityEpochJob(f.pool, job);
    await waitIdentityEpochPublished(f.pool, job);
    expect((await f.readJob(job))!.ref).toEqual(job);
    expect(await f.nativePublicationCount(job)).toBe(1);
    expect(f.operationBackendIds().size).toBeLessThanOrEqual(1);
  } finally {
    await f.close();
  }
}, 180_000);
