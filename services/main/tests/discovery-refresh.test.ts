import { expect, test } from 'bun:test';
import { DiscoveryRefreshWorker } from '../src/modules/discovery/refresh.ts';
import { discoveryGenerationCurrent, type DiscoveryRefreshStore } from '../src/modules/discovery/refresh-store.ts';
import { DISCOVERY_SOURCE_PROFILE } from '../src/modules/discovery/profile.ts';
import type { DiscoveryProjection } from '../src/modules/discovery/store.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { AlsoEnjoyedStore } from '../src/modules/also-enjoyed/store.ts';

test('discovery ticks fold co-reader logs on their schedule and advance one build batch every tick', async () => {
  const calls: string[] = [];
  const store = { purge: async () => {}, claim: async () => null } as unknown as DiscoveryRefreshStore;
  const alsoEnjoyed = { fold: async () => { calls.push('fold'); },
    refresh: async () => { calls.push('refresh'); } } as unknown as AlsoEnjoyedStore;
  const worker = new DiscoveryRefreshWorker({ alsoEnjoyed } as MainWorkDependencies, store, {} as DiscoveryProjection);
  (worker as unknown as { enroll: () => Promise<void> }).enroll = async () => {};
  expect(await worker.tick()).toBe('idle');
  expect(await worker.tick()).toBe('idle');
  expect(calls).toEqual(['fold', 'refresh', 'refresh']);
});

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
  const since = { generation: '0', wide: false, statements: [] };
  const prior = { source_epoch: 'epoch', source_sequence: '806',
    recovery_generation: '0', source_profile: null };
  expect(discoveryGenerationCurrent(prior, position, since)).toBe(false);
  expect(discoveryGenerationCurrent({ ...prior, source_profile: DISCOVERY_SOURCE_PROFILE },
    position, since)).toBe(true);
});

test('a judged Statement or a wide Access change folded after the basis outdates the generation', () => {
  const position = { dataEpoch: 'epoch', sequence: '806' };
  const prior = { source_epoch: 'epoch', source_sequence: '806',
    recovery_generation: '0', source_profile: DISCOVERY_SOURCE_PROFILE };
  expect(discoveryGenerationCurrent(prior, position,
    { generation: '0', wide: false, statements: ['https://rezics.com/id/statement'] })).toBe(false);
  expect(discoveryGenerationCurrent(prior, position,
    { generation: '0', wide: true, statements: [] })).toBe(false);
  expect(discoveryGenerationCurrent(prior, position,
    { generation: '1', wide: false, statements: [] })).toBe(false);
});
