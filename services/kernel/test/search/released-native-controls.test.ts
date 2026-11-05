import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { KERNEL_WORK_MODULES } from '../support/default-work-modules.ts';
import { createReleasedDiscoveryFixture, type ReleasedDiscoveryFixture } from '../support/released-discovery.ts';

let fixture: ReleasedDiscoveryFixture;
beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
  await fixture.setup.openFeatures(['search']);
}, 120_000);
afterAll(async () => {
  await fixture?.close();
}, 180_000);

const context = () => ({ deadline: Date.now() + 10_000 });
const request = {
  plan: { filterDocument: undefined, text: undefined, sort: 'id' as const, size: 1 },
  snapshot: 'pit' as const,
};

test('the ordinary released fixture selects the actual owned child and retains all default Search services', async () => {
  expect(fixture.search!.workerKind).toBe('owned-child');
  const stats = await fixture.search!.workerStats();
  expect(stats.searchStarterInvocations).toBe(1);
  // The runner slot owns only indexing; default retention/erasure starters also execute.
  expect(stats.startedServices.search).toBeGreaterThan(stats.searchStarterInvocations);
});

test('the released native fixture keeps original Source publication unavailable instead of supplying custody or readiness', async () => {
  const native = fixture.search!;
  // This is the real factory, using the released definitions and installed Access. Its
  // missing original Source window must remain a production unready answer.
  const publication = await native.preparePublication(1, context());
  expect(publication).toMatchObject({ status: 'unready', reason: 'source_pending' });
  const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { limit: 1 });
  expect(response.status).toBe(503);
  expect(response.body.code).toBe('index_not_ready');
  expect(response.headers.get('retry-after')).toBeTruthy();
  expect(response.body).not.toHaveProperty('subjects');
  expect(response.body).not.toHaveProperty('job');
}, 30_000);

test('freshness cannot turn a missing current native generation into zero lag or Source readiness', async () => {
  const native = fixture.search!;
  await native.indexing('paused');
  try {
    await expect(native.freshness()).rejects.toThrow('current generation is unavailable');
    // A diagnostic read neither publishes a generation nor manufactures original Source evidence.
    expect(await native.preparePublication(1, context())).toMatchObject({
      status: 'unready',
      reason: 'source_pending',
    });
  } finally {
    await native.indexing('running');
  }
}, 30_000);

test('request and response barriers hold actual same-prefix engine I/O without replacing the native answer', async () => {
  const native = fixture.search!;
  await native.indexing('paused');
  try {
    for (const phase of ['request', 'response'] as const) {
      const barrier = native.barrier({
        phase,
        method: 'GET',
        path: `/_resolve/index/${native.indexPrefix}subjects*?expand_wildcards=all`,
      });
      let completed = false;
      const pending = Promise.allSettled([native.bindRequest(request, context())]).then((result) => {
        completed = true;
        return result[0]!;
      });
      try {
        await Promise.race([
          barrier.reached,
          pending.then(() => {
            throw new Error('Native operation completed before its transport boundary');
          }),
        ]);
        expect(completed).toBe(false);
      } finally {
        barrier.release();
      }
      const result = await pending;
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('An unavailable Source acquired a native observation');
      expect(result.reason).toMatchObject({ code: 'index_not_ready' });
    }
  } finally {
    await native.indexing('running');
  }
}, 60_000);

test('SIGKILL observes actual child exit and restarts the same world without a new prefix, capture or rebuild', async () => {
  const native = fixture.search!;
  const prefix = native.indexPrefix;
  const original = await native.workerStats();
  const names = KERNEL_WORK_MODULES.map(({ name }) => name);
  expect(original.defaultModules).toEqual(names);
  expect(original.registeredModules).toEqual(names);
  for (const name of names) expect(original.registrationCounts[name]).toBe(1);
  expect(original.searchStarterInvocations).toBe(1);

  // Search pause/resume runs the captured starter inside the same SDK. Crash must
  // instead close its real process and restart the default composition from scratch.
  await native.indexing('paused');
  await native.indexing('running');
  expect((await native.workerStats()).searchStarterInvocations).toBe(2);
  expect(await native.crash()).toEqual({ code: null, signal: 'SIGKILL' });
  await expect(native.workerStats()).rejects.toThrow();
  const restarted = await native.restart();
  expect(restarted.defaultModules).toEqual(names);
  expect(restarted.registeredModules).toEqual(names);
  expect(restarted.searchStarterInvocations).toBe(1);
  expect(native.indexPrefix).toBe(prefix);
  await expect(native.restart()).rejects.toThrow('Restart requires confirmed actual worker exit');

  // A locator alone neither creates a durable preparation nor confers completeness.
  expect(await native.readPreparation(randomUUID())).toBeNull();
  expect(await native.preparePublication(1, context())).toMatchObject({
    status: 'unready',
    reason: 'source_pending',
  });
}, 180_000);

test('the existing owned child receives explicit shared fixture instants and retains them across same-world restart', async () => {
  // Semantic owns this additive controller and request forwarding. Keep this native regression
  // attached to the existing shared fixture while its producer lands independently.
  const clock = Reflect.get(fixture, 'clock') as {
    now(): Date;
    freeze(): Date;
    advanceBy(milliseconds: number): Date;
  };
  expect(clock).toBeDefined();
  const native = fixture.search!;
  const prefix = native.indexPrefix;
  const frozen = clock.freeze();
  const flushThroughRequest = async () => {
    const response = await fixture.request('anonymous', 'GET', '/v1/definitions/active');
    expect(response.status).toBe(200);
  };
  await flushThroughRequest();
  expect((await native.workerStats()).clockInstant).toBe(frozen.getTime());
  expect(clock.freeze().getTime()).toBe(frozen.getTime());
  const advanced = clock.advanceBy(1_234);
  await flushThroughRequest();
  expect((await native.workerStats()).clockInstant).toBe(advanced.getTime());
  await native.indexing('paused');
  await native.indexing('running');
  expect((await native.workerStats()).clockInstant).toBe(advanced.getTime());

  expect(await native.crash()).toEqual({ code: null, signal: 'SIGKILL' });
  const restarted = await native.restart();
  expect(restarted.clockInstant).toBe(advanced.getTime());
  expect(native.indexPrefix).toBe(prefix);
  expect(clock.now().getTime()).toBe(advanced.getTime());
  const next = clock.advanceBy(1);
  await flushThroughRequest();
  expect((await native.workerStats()).clockInstant).toBe(next.getTime());
}, 180_000);
