import { expect, test } from 'bun:test';
import { DiscoveryRefreshWorker } from '../src/modules/discovery/refresh.ts';
import type { DiscoveryRefreshStore } from '../src/modules/discovery/refresh-store.ts';
import type { DiscoveryProjection } from '../src/modules/discovery/store.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

test('A3: graph diagnostic 100 does not block enrollment at Main stream cut 3', async () => {
  const worker = new DiscoveryRefreshWorker({ relayPosition: { read: async () => ({
    streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'epoch', sequence: '3',
  }) } } as unknown as MainWorkDependencies, {} as DiscoveryRefreshStore, {} as DiscoveryProjection);
  const caughtUp = (worker as unknown as { caughtUp(session: WorkReadSession): Promise<boolean> }).caughtUp;
  const session = { position: { dataEpoch: 'epoch', sequence: '100' } } as WorkReadSession;
  expect(await caughtUp.call(worker, session)).toBe(true);
});

test('A3: a different epoch still refuses the caught-up gate', async () => {
  const worker = new DiscoveryRefreshWorker({ relayPosition: { read: async () => ({
    streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: 'restored', sequence: '3',
  }) } } as unknown as MainWorkDependencies, {} as DiscoveryRefreshStore, {} as DiscoveryProjection);
  const caughtUp = (worker as unknown as { caughtUp(session: WorkReadSession): Promise<boolean> }).caughtUp;
  const session = { position: { dataEpoch: 'epoch', sequence: '100' } } as WorkReadSession;
  expect(await caughtUp.call(worker, session)).toBe(false);
});
