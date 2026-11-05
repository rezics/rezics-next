import { expect, spyOn, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Access } from '../../src/request/access.ts';
import type { PublicFilterSource } from '../../src/semantic/public-filter-source-contract.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import { createRetainedDiscoverySearch } from '../../src/search/discovery-service.ts';
import type { DiscoveryKey, DiscoveryReadContext } from '../../src/search/discovery.ts';
import type { PublicDiscoveryConsumerOperations } from '../../src/search/public-filter-consumer-contract.ts';
import { installPublicFilterCoveragePage } from '../../src/search/public-filter-coverage-page.ts';

// This installed opener is an explicit lifecycle unit double. It establishes no
// native coverage, population, admission, physical funding or product acceptance.
const id = '018f0000-0000-7000-8000-00a000000001';
const key: DiscoveryKey = { owner: 'accounts', kind: 'account', route: 160, id };
const unused = async (): Promise<never> => {
  throw new Error('Unexpected producer operation');
};
const cost = {
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
};
function gate() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function fixture() {
  const calls: string[] = [];
  const ownerStarted = gate(),
    owner = gate(),
    finalStarted = gate(),
    final = gate();
  let holdFinal = false;
  let disposed = false;
  const consumer = {
    physicalTarget: 'discovery-lifetime-unit',
    incarnation: 'incarnation',
    consumerGeneration: '1',
    projectionGeneration: '1',
    meaningDigest: 'meaning',
    readDefinition: 'definition',
  };
  const queried = {
    consumer,
    snapshot: { kind: 'prepared' as const, observation: 'observation', build: 'build', generation: 1n },
  };
  const operations: PublicDiscoveryConsumerOperations = {
    capture: unused,
    captureDiscovery: unused,
    query: unused,
    queryDiscovery: unused,
    repairStep: unused,
    readStatus: unused,
    close: unused,
    async closeObservation() {
      calls.push('close-observation');
    },
  };
  installPublicFilterCoveragePage(operations, () => ({
    async capture() {
      return { status: 'captured', queried, repair: { consumer, job: 'job' }, cost };
    },
    query: unused,
    async queryDiscovery() {
      return {
        status: 'queried',
        queried,
        execution: 'execution',
        start: { observation: 'start' },
        result: { hits: [] },
        window: { positions: [], examined: 0, exhausted: true },
        cost,
      };
    },
    async consume() {},
    async finish() {
      calls.push('final');
      finalStarted.resolve();
      if (holdFinal) await final.promise;
    },
    async dispose() {
      if (!disposed) {
        disposed = true;
        calls.push('dispose');
      }
    },
    failure() {
      return { status: 'unavailable', reason: 'observation_lost', cost };
    },
  }));
  const registry = createDiscoveryRegistry({
    release: bundledRelease,
    semantic: {
      source: { read: unused, count: unused },
      hydrate: unused,
      icons: Object.fromEntries(Object.keys(bundledRelease.types).map((kind) => [kind, 'catalogue'])),
    },
    accounts: {
      source: {
        count: unused,
        page: unused,
        async read(partition) {
          calls.push('owner-start');
          ownerStarted.resolve();
          await owner.promise;
          calls.push('owner-end');
          return {
            partition,
            position: 7n,
            accounts: [{ id, accountKind: 'actor', handle: null, displayName: 'Reader', revision: 3n }],
          };
        },
      },
      async hydrate() {
        calls.push('hydrate');
        return new Map([
          [
            id,
            {
              id,
              accountKind: 'actor' as const,
              handle: null,
              displayName: 'Reader',
              automated: false,
              operatorId: null,
              avatar: null,
              verifiedAgent: null,
            },
          ],
        ]);
      },
      labels: { en: 'Accounts' },
      icon: 'account',
    },
  });
  const source = new Proxy({} as PublicFilterSource, {
    get() {
      throw new Error('Unexpected Source read');
    },
  });
  const access = new Proxy({} as Access, {
    get() {
      throw new Error('Unexpected Access read');
    },
  });
  const context: DiscoveryReadContext = { access, actor: { kind: 'anonymous' }, deadline: Date.now() + 30_000 };
  const config = {
    consumer: operations,
    source,
    keys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) },
    resolve: async () => ({ registry, release: bundledRelease, digest: 'release' }),
    now: Date.now,
    asOf: async () => '2026-11-02T00:00:00.000Z',
  };
  return {
    calls,
    ownerStarted,
    owner,
    finalStarted,
    final,
    context,
    config,
    request: { representation: 'discovery-v1' as const, sort: 'id' as const, limit: 1 },
    holdFinal() {
      holdFinal = true;
    },
  };
}

test('expiry retains the original until a dispatched owner settles, including refusal', async () => {
  for (const refuses of [false, true]) {
    const now = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(now);
    const timers = spyOn(globalThis, 'setTimeout');
    const f = fixture();
    const read = await createRetainedDiscoverySearch(f.config)('anonymous', f.request, f.context);
    try {
      const batch = read.currentPrimaryCandidates([key]);
      void batch.catch(() => {});
      await f.ownerStarted.promise;
      clock.mockReturnValue(f.context.deadline + 1);
      const expire = timers.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
      expect(typeof expire).toBe('function');
      if (typeof expire !== 'function') throw new Error('Missing retained deadline timer');
      expire();
      await Promise.resolve();
      expect(f.calls).not.toContain('dispose');
      expect(f.calls).not.toContain('close-observation');
      expect(f.calls).not.toContain('final');
      const closing = read.close();
      void closing.catch(() => {});
      if (refuses) f.owner.reject(new Error('Owner refused'));
      else f.owner.resolve();
      await expect(batch).rejects.toMatchObject(refuses ? { message: 'Owner refused' } : { code: 'index_not_ready' });
      await closing.catch(() => {});
      expect(f.calls.slice(-2)).toEqual(['dispose', 'close-observation']);
      expect(f.calls.filter((call) => call === 'dispose')).toHaveLength(1);
      expect(f.calls).not.toContain('final');
    } finally {
      f.owner.resolve();
      await read.close().catch(() => {});
      timers.mockRestore();
      clock.mockRestore();
    }
  }
});

test('finish awaiting an owner cannot publish a late callback even before the timer runs', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now());
  const f = fixture();
  const read = await createRetainedDiscoverySearch(f.config)('anonymous', f.request, f.context);
  try {
    const batch = read.currentPrimaryCandidates([key]);
    const finishing = read.finish();
    void batch.catch(() => {});
    void finishing.catch(() => {});
    await f.ownerStarted.promise;
    clock.mockReturnValue(f.context.deadline + 1);
    f.owner.resolve();
    await expect(batch).rejects.toMatchObject({ code: 'index_not_ready' });
    await expect(finishing).rejects.toMatchObject({ code: 'index_not_ready' });
    expect(f.calls).not.toContain('final');
    expect(f.calls.slice(-2)).toEqual(['dispose', 'close-observation']);
  } finally {
    f.owner.resolve();
    await read.close();
    clock.mockRestore();
  }
});

test('caller mutation cannot extend the retained original deadline', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now());
  const f = fixture();
  const deadline = f.context.deadline;
  const read = await createRetainedDiscoverySearch(f.config)('anonymous', f.request, f.context);
  try {
    f.context.deadline += 60_000;
    clock.mockReturnValue(deadline + 1);
    await expect(read.search()).rejects.toMatchObject({ code: 'index_not_ready' });
    expect(() => read.currentPrimaryCandidates([key])).toThrow();
    expect(f.calls).not.toContain('owner-start');
  } finally {
    await read.close();
    clock.mockRestore();
  }
});

test('a final that completes after the original deadline cannot authorize publication', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now());
  const f = fixture();
  f.holdFinal();
  const read = await createRetainedDiscoverySearch(f.config)('anonymous', f.request, f.context);
  try {
    await read.search();
    const finishing = read.finish();
    void finishing.catch(() => {});
    await f.finalStarted.promise;
    clock.mockReturnValue(f.context.deadline + 1);
    f.final.resolve();
    await expect(finishing).rejects.toMatchObject({ code: 'index_not_ready' });
    expect(f.calls).toEqual(['final', 'dispose', 'close-observation']);
  } finally {
    f.final.resolve();
    await read.close();
    clock.mockRestore();
  }
});
