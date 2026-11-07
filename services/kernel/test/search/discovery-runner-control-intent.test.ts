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
const secondGeneration = { ...generation, generation: 2, uuid: 'g2', incarnation: '2' };
type RelayControl = {
  paused: boolean;
  stopped: boolean;
  hold: boolean;
  concurrency: number | undefined;
  consumers: string[];
  reached: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
};
const created: RelayControl[] = [];
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
    return {};
  },
  createDiscoveryProjection: ({ target }: { target: { generation: number } }) => {
    if (failProjectionGeneration === target.generation) throw new Error('Controlled projection failure');
    return {};
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
  relayConcurrencyForPool: (pool: { options?: { max?: number } }) =>
    Math.min(4, Math.max(1, (pool.options?.max ?? 10) - 1)),
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

const { startDiscoveryIndexing } = await import('../../src/search/runner.ts');

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
    pool: {} as never,
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

test('discovery relay ownership follows the supplied Pool across failure and generation retirement', async () => {
  created.length = 0;
  availableGenerations = [generation];
  const smallPool = runner(2);
  try {
    await smallPool.refresh();
    const installed = created[0]!;
    expect(installed).toMatchObject({ concurrency: 1, consumers: ['search_intent_discovery_g1'] });

    availableGenerations = [generation, secondGeneration];
    failProjectionGeneration = 2;
    await expect(smallPool.refresh()).rejects.toThrow('Controlled projection failure');
    expect(created).toHaveLength(1);
    expect(installed.stopped).toBe(false);

    failProjectionGeneration = undefined;
    await smallPool.refresh();
    expect(installed.stopped).toBe(true);
    expect(created[1]).toMatchObject({
      concurrency: 1,
      consumers: ['search_intent_discovery_g1', 'search_intent_discovery_g2'],
    });
    availableGenerations = [secondGeneration];
    await smallPool.refresh();
    expect(created[1]?.stopped).toBe(true);
    expect(created[2]).toMatchObject({ concurrency: 1, consumers: ['search_intent_discovery_g2'] });
  } finally {
    await smallPool.stop();
  }

  created.length = 0;
  availableGenerations = [generation];
  const configuredPool = runner(5, 2);
  try {
    await configuredPool.refresh();
    expect(created[0]?.concurrency).toBe(2);
  } finally {
    await configuredPool.stop();
  }
});
