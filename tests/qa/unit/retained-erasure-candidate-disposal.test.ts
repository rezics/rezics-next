import { expect, test } from 'bun:test';
import { createRetainedErasureCandidateDisposal,
  type RetainedErasureCleanupAction } from '../fault-recovery/retained-erasure-recovery-fixture.ts';

test('candidate disposal is idempotent and leaves sibling, source, and shared native resources alone', async () => {
  const owned = new Set([
    'after-account.pool', 'after-account.graph', 'after-account.postgres',
    'after-account.volume', 'after-account.data', 'after-account.objects',
    'after-authority.pool', 'source.pool', 'shared.native', 'historical.backup',
  ]);
  const attempts = new Map<string, number>();
  const actions: RetainedErasureCleanupAction[] = [
    'after-account.pool', 'after-account.graph', 'after-account.postgres',
    'after-account.volume', 'after-account.data', 'after-account.objects',
  ].map(resource => ({ resource, run: () => {
    attempts.set(resource, (attempts.get(resource) ?? 0) + 1);
    owned.delete(resource);
  } }));
  const dispose = createRetainedErasureCandidateDisposal(actions);

  await dispose();
  await dispose();

  expect([...owned].sort()).toEqual([
    'after-authority.pool', 'historical.backup', 'shared.native', 'source.pool',
  ]);
  expect([...attempts.values()]).toEqual([1, 1, 1, 1, 1, 1]);
});

test('partial candidate cleanup attempts every action and leaves failures for final fixture cleanup', async () => {
  const allocations = new Set(['candidate.pool', 'candidate.graph', 'candidate.postgres',
    'candidate.volume', 'candidate.data', 'candidate.objects']);
  const attempts = new Map<string, number>();
  let graphRemovalFails = true;
  const remove = (resource: string): RetainedErasureCleanupAction => ({ resource, run: () => {
    attempts.set(resource, (attempts.get(resource) ?? 0) + 1);
    if (resource === 'candidate.graph' && graphRemovalFails)
      throw new Error('container removal failed');
    allocations.delete(resource);
  } });
  const disposeCandidate = createRetainedErasureCandidateDisposal(
    [...allocations].map(remove),
  );

  await expect(disposeCandidate()).rejects.toThrow('retained erasure candidate cleanup failed');
  expect(allocations).toEqual(new Set(['candidate.graph']));
  expect(attempts.size).toBe(6);

  graphRemovalFails = false;
  const finalFixtureCleanup = createRetainedErasureCandidateDisposal([...allocations].map(remove));
  await finalFixtureCleanup();

  expect(allocations.size).toBe(0);
  expect(attempts.get('candidate.graph')).toBe(2);
});
