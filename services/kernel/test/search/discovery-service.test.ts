import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Access } from '../../src/request/access.ts';
import type { PublicFilterSource } from '../../src/semantic/public-filter-source-contract.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import { createDiscoverySearch, createRetainedDiscoverySearch } from '../../src/search/discovery-service.ts';
import type { DiscoveryKey, DiscoveryReadContext } from '../../src/search/discovery.ts';
import type { PublicDiscoveryConsumerOperations } from '../../src/search/public-filter-consumer-contract.ts';
import { installPublicFilterCoveragePage } from '../../src/search/public-filter-coverage-page.ts';

// Lifecycle regressions, authored without running the deferred native campaign. The
// installed opener is an explicit unit double; it is not Source population evidence.
const id = '018f0000-0000-7000-8000-00a000000001';
const key: DiscoveryKey = { owner: 'accounts', kind: 'account', route: 160, id };
const missing = '018f0000-0000-7000-8000-00a000000002';
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

function fixture() {
  const calls: string[] = [];
  const consumer = {
    physicalTarget: 'discovery-unit',
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
  let refuseFinal = false;
  let refuseOwner = false;
  let holdOwner: Promise<void> | undefined;
  let disposed = false;
  installPublicFilterCoveragePage(operations, () => {
    calls.push('open');
    return {
      async capture() {
        calls.push('capture');
        return { status: 'captured', queried, repair: { consumer, job: 'job' }, cost };
      },
      query: unused,
      async queryDiscovery() {
        calls.push('query');
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
      async consume() {
        calls.push('consume');
      },
      async finish() {
        calls.push('final');
        if (refuseFinal) throw new Error('Changed original cut');
      },
      async dispose() {
        if (!disposed) {
          calls.push('dispose');
          disposed = true;
        }
      },
      failure() {
        return { status: 'unavailable', reason: 'observation_lost', cost };
      },
    };
  });
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
          await holdOwner;
          if (refuseOwner) throw new Error('Owner unavailable');
          calls.push('owner-end');
          return {
            partition,
            position: 7n,
            accounts: [{ id, accountKind: 'actor', handle: null, displayName: 'Reader', revision: 3n }],
          };
        },
      },
      async hydrate(ids) {
        calls.push('hydrate');
        return new Map(
          ids
            .filter((value) => value === id)
            .map((id) => [
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
            ]),
        );
      },
      labels: { en: 'Accounts' },
      icon: 'account',
    },
  });
  // These dependencies are unreachable in the empty native-window/unit owner path.
  // Any future accidental use must fail, rather than granting permissive authority.
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
    asOf: async () => {
      calls.push('as-of');
      return '2026-11-02T00:00:00.000Z';
    },
  };
  const request = { representation: 'discovery-v1' as const, sort: 'id' as const, limit: 1 };
  return {
    calls,
    context,
    config,
    request,
    refuseFinal() {
      refuseFinal = true;
    },
    refuseOwner() {
      refuseOwner = true;
    },
    holdOwner(value: Promise<void>) {
      holdOwner = value;
    },
  };
}

test('retained projection and positional primary batch precede the same native final and close', async () => {
  const f = fixture();
  const read = await createRetainedDiscoverySearch(f.config)('anonymous', f.request, f.context);
  expect(f.calls).toEqual(['open', 'capture', 'query', 'consume', 'as-of']);
  const page = await read.search();
  expect(page.hits).toEqual([]);
  page.kinds.values.length = 0;
  await expect(read.search()).rejects.toThrow('one search');
  expect(await read.currentPrimaryCandidates([key, { ...key, id: missing }, key])).toEqual([true, false, true]);
  expect(f.calls.filter((value) => value === 'owner-start')).toHaveLength(1);
  expect(f.calls.filter((value) => value === 'hydrate')).toHaveLength(1);
  await read.finish();
  await read.close();
  expect(f.calls.slice(-3)).toEqual(['final', 'dispose', 'close-observation']);
  await expect(read.search()).rejects.toThrow('no longer open');
  expect(() => read.currentPrimaryCandidates([])).toThrow('no longer open');
});

test('finish waits for the in-flight original primary batch and forbids another batch', async () => {
  const f = fixture();
  let release!: () => void;
  f.holdOwner(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const read = await createRetainedDiscoverySearch(f.config)('anonymous', f.request, f.context);
  const batch = read.currentPrimaryCandidates([key]);
  const final = read.finish();
  expect(() => read.currentPrimaryCandidates([])).toThrow('no longer open');
  expect(f.calls).not.toContain('final');
  release();
  expect(await batch).toEqual([true]);
  await final;
  await read.close();
  expect(f.calls.indexOf('final')).toBeGreaterThan(f.calls.indexOf('hydrate'));
});

test('abandonment disposes without a final or publication and close is idempotent', async () => {
  const f = fixture();
  const read = await createRetainedDiscoverySearch(f.config)('anonymous', f.request, f.context);
  await read.close();
  await read.close();
  expect(f.calls).not.toContain('final');
  expect(f.calls.filter((value) => value === 'dispose')).toHaveLength(1);
  expect(f.calls.filter((value) => value === 'close-observation')).toHaveLength(1);
  expect(() => read.finish()).toThrow('no longer open');
});

test('terminal refusal and dependent-owner refusal both dispose the original', async () => {
  for (const failure of ['terminal', 'owner'] as const) {
    const f = fixture();
    const read = await createRetainedDiscoverySearch(f.config)('anonymous', f.request, f.context);
    if (failure === 'terminal') f.refuseFinal();
    else {
      f.refuseOwner();
      await expect(read.currentPrimaryCandidates([key])).rejects.toThrow('Owner unavailable');
    }
    await expect(read.finish()).rejects.toThrow();
    await read.close();
    expect(f.calls.slice(-2)).toEqual(['dispose', 'close-observation']);
    expect(f.calls.filter((value) => value === 'final')).toHaveLength(failure === 'terminal' ? 1 : 0);
  }
});

test('completed public search composes the retained native operation', async () => {
  const f = fixture();
  expect((await createDiscoverySearch(f.config)('anonymous', f.request, f.context)).next).toBeNull();
  expect(f.calls).toEqual(['open', 'capture', 'query', 'consume', 'as-of', 'final', 'dispose', 'close-observation']);
});

test('invalid full keys fail before owner I/O and late operations cannot reuse a retained page', async () => {
  const f = fixture();
  const read = await createRetainedDiscoverySearch(f.config)('anonymous', f.request, f.context);
  await expect(read.currentPrimaryCandidates([{ ...key, route: 161 }])).rejects.toThrow();
  expect(f.calls).not.toContain('owner-start');
  await expect(read.finish()).rejects.toThrow();
  await read.close();
});

test('projection failure closes the original before open rejects', async () => {
  const f = fixture();
  const config = {
    ...f.config,
    asOf: async () => {
      throw new Error('Metadata unavailable');
    },
  };
  await expect(createRetainedDiscoverySearch(config)('anonymous', f.request, f.context)).rejects.toMatchObject({
    code: 'index_not_ready',
  });
  expect(f.calls.slice(-2)).toEqual(['dispose', 'close-observation']);
  expect(f.calls).not.toContain('final');
});

test('expired retained execution cannot dispatch an owner batch or publish', async () => {
  const f = fixture();
  const context = { ...f.context, deadline: Date.now() - 1 };
  const read = await createRetainedDiscoverySearch(f.config)('anonymous', f.request, context);
  expect(() => read.currentPrimaryCandidates([key])).toThrow();
  await expect(read.search()).rejects.toMatchObject({ code: 'index_not_ready' });
  await read.close();
  expect(f.calls).not.toContain('owner-start');
  expect(f.calls).not.toContain('final');
  expect(f.calls.slice(-2)).toEqual(['dispose', 'close-observation']);
});
