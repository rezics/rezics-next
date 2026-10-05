import { expect, test } from 'bun:test';
import { DiscoveryRefreshWorker } from '../src/modules/discovery/refresh.ts';
import { discoveryGenerationCurrent, type DiscoveryRefreshStore } from '../src/modules/discovery/refresh-store.ts';
import { DISCOVERY_SOURCE_PROFILE } from '../src/modules/discovery/profile.ts';
import type { DiscoveryProjection } from '../src/modules/discovery/store.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

test('a slow catalog read defers enrollment while the refresh tick still claims a Work', async () => {
  const calls: string[] = [];
  const store = { purge: async () => { calls.push('purge'); },
    claim: async () => { calls.push('claim'); return null; } } as unknown as DiscoveryRefreshStore;
  const worker = new DiscoveryRefreshWorker({} as MainWorkDependencies, store, {} as DiscoveryProjection);
  (worker as unknown as { enroll: () => Promise<void> }).enroll = async () => {
    throw new WorkReadUnavailable('Work read deadline exceeded');
  };
  expect(await worker.tick()).toBe('idle');
  expect(calls).toEqual(['purge', 'claim']);
});

test('a saved discovery generation from the old source query rebuilds at the same relay position', () => {
  const position = { dataEpoch: 'epoch', sequence: '806' };
  const fence = { revision: '54', changed: false, generation: '0' };
  const prior = { source_epoch: 'epoch', source_sequence: '806', access_revision: '54',
    recovery_generation: '0', source_profile: null };
  expect(discoveryGenerationCurrent(prior, position, fence)).toBe(false);
  expect(discoveryGenerationCurrent({ ...prior, source_profile: DISCOVERY_SOURCE_PROFILE },
    position, fence)).toBe(true);
});

test('an Access source change not yet folded outdates the generation at its own revision', () => {
  const position = { dataEpoch: 'epoch', sequence: '806' };
  const prior = { source_epoch: 'epoch', source_sequence: '806', access_revision: '54',
    recovery_generation: '0', source_profile: DISCOVERY_SOURCE_PROFILE };
  expect(discoveryGenerationCurrent(prior, position,
    { revision: '54', changed: true, generation: '0' })).toBe(false);
  expect(discoveryGenerationCurrent(prior, position,
    { revision: '55', changed: false, generation: '0' })).toBe(false);
});
