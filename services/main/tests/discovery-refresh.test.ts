import { expect, test } from 'bun:test';
import { DiscoveryRefreshWorker } from '../src/modules/discovery/refresh.ts';
import type { DiscoveryRefreshStore } from '../src/modules/discovery/refresh-store.ts';
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
