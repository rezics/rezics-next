import { expect, mock, test } from 'bun:test';

const INTERVAL = 60_000;
const generation = {
  prefix: 'intent-',
  generation: 1,
  uuid: '00000000-0000-4000-8000-000000000001',
  incarnation: '1',
  state: 'active',
  kinds: [] as string[],
};
const secondGeneration = {
  ...generation,
  generation: 2,
  uuid: '00000000-0000-4000-8000-000000000002',
  incarnation: '2',
};
type RelayControl = {
  paused: boolean;
  stopped: boolean;
  hold: boolean;
  concurrency: number | undefined;
  consumers: string[];
  reached: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
};
type ReceiverControl = { generation: number; nextCalls: number };
const created: RelayControl[] = [];
const receiverInstances: ReceiverControl[] = [];
let availableGenerations = [generation];
let failProjectionGeneration: number | undefined;
let holdMaintenance = false;
let maintenanceReached = Promise.withResolvers<void>();
let maintenanceRelease = Promise.withResolvers<void>();

mock.module('../../src/search/account-discovery.ts', () => ({
  nativeDiscoveryRegistry: async () => {
    if (holdMaintenance) {
      holdMaintenance = false;
      maintenanceReached.resolve();
      await maintenanceRelease.promise;
    }
    return { ownerAdapters: { review: { readiness: 'ready' } } };
  },
  createDiscoveryProjection: ({ target }: { target: { generation: number } }) => {
    if (failProjectionGeneration === target.generation) throw new Error('Controlled projection failure');
    return {
      target,
      async hasMetadataPopulation() {
        return true;
      },
    };
  },
  registerRetiredErasure: async () => {},
  copyLocator: () => ({}),
}));
mock.module('../../src/search/generations.ts', () => ({
  discoveryConsumer: (prefix: string, n: number) => `search_${prefix.replaceAll('-', '_')}discovery_g${n}`,
  advanceDiscovery: async () => {},
  discoveryGenerations: async () => availableGenerations,
}));
mock.module('../../src/search/indexer.ts', () => ({
  createDiscoveryIndexer: (_pool: unknown, _projection: unknown, consumer: string) => ({
    consumer,
    run: async () => ({ status: 'busy' }),
  }),
  createSubjectIndexer: () => ({ consumer: 'search_intent_subjects_g1', run: async () => ({ status: 'busy' }) }),
}));
mock.module('../../src/events/relays.ts', () => ({
  relayConcurrencyForPool(pool: { options?: { max?: number } }) {
    const max = pool.options?.max ?? 10;
    if (!Number.isInteger(max) || max < 1) return 1;
    return max <= 1 ? 1 : Math.min(4, max - 1);
  },
  startRelays(
    _pool: unknown,
    relays: { consumer: string }[],
    options: { paused?: boolean; concurrency?: number } = {},
  ) {
    const relay: RelayControl = {
      paused: options.paused ?? false,
      stopped: false,
      hold: false,
      concurrency: options.concurrency,
      consumers: relays.map(({ consumer }) => consumer),
      reached: Promise.withResolvers(),
      release: Promise.withResolvers(),
    };
    created.push(relay);
    return {
      async pause() {
        relay.paused = true;
        relay.reached.resolve();
        if (relay.hold) await relay.release.promise;
      },
      resume() {
        if (!relay.stopped && relay.paused) relay.paused = false;
      },
      async stop() {
        relay.stopped = true;
        relay.paused = true;
        relay.release.resolve();
      },
    };
  },
}));
mock.module('../../src/search/review-discovery-receiving.ts', () => ({
  createReviewDiscoveryReceiving({ projection }: { projection: { target: { generation: number } } }) {
    const receiver = { generation: projection.target.generation, nextCalls: 0 };
    receiverInstances.push(receiver);
    return {
      async next() {
        receiver.nextCalls++;
      },
    };
  },
}));

const { startDiscoveryIndexing } = await import('../../src/search/runner.ts');

function resetFixture(generations = [generation]) {
  created.length = 0;
  receiverInstances.length = 0;
  availableGenerations = generations;
  failProjectionGeneration = undefined;
  holdMaintenance = false;
  maintenanceReached = Promise.withResolvers<void>();
  maintenanceRelease = Promise.withResolvers<void>();
}

function runner(poolMax: number, concurrency?: number) {
  return startDiscoveryIndexing({
    pool: { options: { max: poolMax } } as never,
    search: {} as never,
    source: {} as never,
    listing: {} as never,
    prefix: 'intent-',
    routeKey: new Uint8Array(32),
    intervalMs: INTERVAL,
    ...(concurrency === undefined ? {} : { concurrency }),
    reviewSource: {} as never,
  });
}

async function bounded<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture did not finish: ${name}`)), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('resume during an unresolved discovery pause wins after drains settle; stop stays terminal', async () => {
  resetFixture();
  const scheduled = new Set<ReturnType<typeof setTimeout>>();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  globalThis.setTimeout = new Proxy(originalSet, {
    apply(target, receiver, args: unknown[]) {
      const delay = args[1];
      if (delay !== 0 && delay !== INTERVAL)
        return Reflect.apply(target, receiver, args) as ReturnType<typeof setTimeout>;
      const callback = args[0] as (...cb: unknown[]) => unknown;
      let timer: ReturnType<typeof setTimeout>;
      timer = Reflect.apply(target, receiver, [
        (...cb: unknown[]) => {
          scheduled.delete(timer);
          return callback(...cb);
        },
        delay,
        ...args.slice(2),
      ]) as ReturnType<typeof setTimeout>;
      scheduled.add(timer);
      return timer;
    },
  });
  globalThis.clearTimeout = new Proxy(originalClear, {
    apply(target, receiver, args: unknown[]) {
      scheduled.delete(args[0] as ReturnType<typeof setTimeout>);
      return Reflect.apply(target, receiver, args);
    },
  });
  holdMaintenance = true;
  const runner = startDiscoveryIndexing({
    pool: { options: { max: 2 } } as never,
    search: {} as never,
    source: {} as never,
    listing: {} as never,
    prefix: 'intent-',
    routeKey: new Uint8Array(32),
    intervalMs: INTERVAL,
    concurrency: 2,
  });
  try {
    await bounded(maintenanceReached.promise, 'maintenance admitted');
    const pausing = runner.pause();
    let pauseSettled = false;
    void pausing.then(() => {
      pauseSettled = true;
    });
    runner.resume();
    runner.resume();
    await Promise.resolve();
    expect(pauseSettled).toBe(false);
    expect(scheduled.size).toBe(0);
    maintenanceRelease.resolve();
    await bounded(pausing, 'pause drain');
    await new Promise<void>((resolve) => originalSet(resolve, 0));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ paused: false, stopped: false });
    expect(scheduled.size).toBe(1);

    const relay = created[0]!;
    relay.hold = true;
    relay.reached = Promise.withResolvers();
    relay.release = Promise.withResolvers();
    const draining = runner.pause();
    await bounded(relay.reached.promise, 'relay pause admitted');
    runner.resume();
    runner.resume();
    const closing = runner.stop();
    expect(runner.stop()).toBe(closing);
    runner.resume();
    expect(scheduled.size).toBe(0);
    await bounded(Promise.all([draining, closing]), 'terminal drain');
    expect(created).toHaveLength(1);
    expect(relay).toMatchObject({ paused: true, stopped: true });
    runner.resume();
    await runner.refresh();
    expect(created).toHaveLength(1);
    expect(relay.stopped).toBe(true);
    expect(scheduled.size).toBe(0);
  } finally {
    await runner.stop();
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});

test('configured relay demand is capped by Pool capacity and generations share one relay owner', async () => {
  resetFixture([generation, secondGeneration]);
  const smallPool = runner(2, 2);
  try {
    await smallPool.refresh();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      concurrency: 1,
      consumers: ['search_intent_discovery_g1', 'search_intent_discovery_g2'],
    });

    const firstReceivers = [...receiverInstances];
    const oldNextCalls = firstReceivers.map(({ nextCalls }) => nextCalls);
    availableGenerations = [secondGeneration];
    await smallPool.refresh();
    expect(created).toHaveLength(2);
    expect(created[0]?.stopped).toBe(true);
    expect(created[1]).toMatchObject({ concurrency: 1, consumers: ['search_intent_discovery_g2'] });
    expect(firstReceivers.map(({ nextCalls }) => nextCalls)).toEqual(oldNextCalls);

    const remainingReceiver = receiverInstances.at(-1)!;
    const remainingCalls = remainingReceiver.nextCalls;
    availableGenerations = [];
    await smallPool.refresh();
    expect(created[1]?.stopped).toBe(true);
    expect(created).toHaveLength(2);
    expect(remainingReceiver.nextCalls).toBe(remainingCalls);
  } finally {
    await smallPool.stop();
  }

  resetFixture();
  const roomyPool = runner(5, 2);
  try {
    await roomyPool.refresh();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ concurrency: 2, consumers: ['search_intent_discovery_g1'] });
  } finally {
    await roomyPool.stop();
  }

  expect(() => runner(2, 0)).toThrow('concurrency must be a positive integer below the pool size');
});

test('failed generation preparation keeps the installed relay and receiver set owned', async () => {
  resetFixture();
  const discovery = runner(5, 2);
  try {
    await discovery.refresh();
    expect(created).toHaveLength(1);
    const installed = created[0]!;
    const receivers = [...receiverInstances];
    const nextCalls = receivers.map(({ nextCalls }) => nextCalls);

    availableGenerations = [generation, secondGeneration];
    failProjectionGeneration = secondGeneration.generation;
    await expect(discovery.refresh()).rejects.toThrow('Controlled projection failure');
    expect(created).toHaveLength(1);
    expect(installed.stopped).toBe(false);
    expect(receiverInstances).toEqual(receivers);
    expect(receivers.map(({ nextCalls }) => nextCalls)).toEqual(nextCalls);

    failProjectionGeneration = undefined;
    await discovery.refresh();
    expect(installed.stopped).toBe(true);
    expect(created).toHaveLength(2);
    expect(created[1]?.consumers).toEqual(['search_intent_discovery_g1', 'search_intent_discovery_g2']);
    expect(receiverInstances.slice(0, receivers.length).map(({ nextCalls }) => nextCalls)).toEqual(nextCalls);
  } finally {
    await discovery.stop();
  }
});
