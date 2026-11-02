import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import type { Access } from '../../src/request/access.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { createDefaultDiscoverySearch } from '../../src/search/default-discovery.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import { admitDiscoveryRequest, type MixedDiscoveryRequest } from '../../src/search/discovery-request.ts';
import { createDiscoverySearch } from '../../src/search/discovery-service.ts';
import { encodeDiscoveryCursor } from '../../src/search/cursor.ts';
import { installPublicFilterCoveragePage } from '../../src/search/public-filter-coverage-page.ts';
import type { DiscoveryReadContext, DiscoveryRegistry } from '../../src/search/discovery.ts';
import type {
  PublicCanonicalCaptureInput,
  PublicDiscoveryConsumerOperations,
  PublicFilterQueriedObservation,
} from '../../src/search/public-filter-consumer-contract.ts';
import type { PublicFilterSource } from '../../src/semantic/public-filter-source-contract.ts';
import * as accountDiscovery from '../../src/search/account-discovery.ts';
import * as definitions from '../../src/semantic/definitions.ts';
import * as hydration from '../../src/search/discovery-hydration.ts';

const now = 1_000;
const id = '018f0000-0000-7000-8000-00a000000001';
const keys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const unused = async (): Promise<never> => {
  throw new Error('Unexpected producer operation');
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function registry(): DiscoveryRegistry {
  return createDiscoveryRegistry({
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
          return {
            partition,
            position: 7n,
            accounts: [{ id, accountKind: 'actor', handle: null, displayName: 'Reader', revision: 3n }],
          };
        },
      },
      async hydrate(ids) {
        return new Map(
          ids
            .filter((value) => value === id)
            .map((value) => [
              value,
              {
                id: value,
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
}

function liveRequest(): MixedDiscoveryRequest & {
  filter: { kind: { in: string[] } };
  languages: string[];
  properties: string[];
  kindPage: { limit: number; cursor?: string };
} {
  return {
    representation: 'discovery-v1',
    text: 'kokoro',
    filter: { kind: { in: ['account'] } },
    sort: 'relevance',
    limit: 1,
    languages: ['en', 'fr'],
    properties: ['schema:author'],
    kindPage: { limit: 1 },
  };
}

function mutate(request: ReturnType<typeof liveRequest>) {
  request.text = 'mutated';
  request.filter.kind.in[0] = 'schema:Person';
  request.filter.kind.in.push('schema:Book');
  request.languages.reverse();
  request.languages.push('de');
  request.properties.push('schema:datePublished');
  request.cursor = 'forged-cursor';
  request.kindPage.limit = 8;
  request.kindPage.cursor = 'forged-kind';
}

function fixture() {
  const held: Array<ReturnType<typeof deferred>> = [];
  const seen: MixedDiscoveryRequest[] = [];
  const plans: PublicCanonicalCaptureInput[] = [];
  const consumer = {
    physicalTarget: 'discovery-unit',
    incarnation: 'incarnation',
    consumerGeneration: '1',
    projectionGeneration: '1',
    meaningDigest: 'meaning',
    readDefinition: 'definition',
  };
  const queried: PublicFilterQueriedObservation = {
    consumer,
    snapshot: { kind: 'prepared', observation: 'observation', build: 'build', generation: 1n },
  };
  const operations = {
    capture: unused,
    captureDiscovery: unused,
    query: unused,
    queryDiscovery: unused,
    repairStep: unused,
    readStatus: unused,
    close: unused,
    async closeObservation() {},
  } as unknown as PublicDiscoveryConsumerOperations;
  let captureHold: ReturnType<typeof deferred> | undefined;
  installPublicFilterCoveragePage(operations, () => ({
    async capture(plan) {
      plans.push(structuredClone(plan));
      if (captureHold) await captureHold.promise;
      return { status: 'captured' as const, queried, repair: { consumer, job: 'job' }, cost: {} };
    },
    query: unused,
    async queryDiscovery() {
      return {
        status: 'queried' as const,
        queried,
        execution: 'execution',
        start: { observation: 'start' },
        result: {
          hits: [
            {
              key: { owner: 'accounts' as const, kind: 'account' as const, route: 160, id },
              index: 'discovery-unit',
              sourcePosition: '7',
              revision: '3',
              matched: [],
              sort: [id],
            },
          ],
        },
        window: { positions: [0], examined: 1, exhausted: true },
        cost: {},
      };
    },
    async consume() {},
    async finish() {},
    async dispose() {},
    failure() {
      return { status: 'unavailable' as const, reason: 'observation_lost' as const, cost: {} };
    },
  }));
  const current = registry();
  const search = createDiscoverySearch({
    consumer: operations,
    source: new Proxy({} as PublicFilterSource, {
      get() {
        throw new Error('Unexpected Source read');
      },
    }),
    keys,
    async resolve(request) {
      seen.push(structuredClone(request));
      const hold = held.shift();
      if (hold) await hold.promise;
      return { registry: current, release: bundledRelease, digest: bundledDigest };
    },
    now: () => now,
    asOf: async () => '2026-11-02T00:00:00.000Z',
  });
  const context: DiscoveryReadContext = {
    access: new Proxy({} as Access, {
      get() {
        throw new Error('Unexpected Access read');
      },
    }),
    actor: { kind: 'anonymous' },
    deadline: now + 30_000,
  };
  return {
    search,
    context,
    current,
    seen,
    plans,
    holdResolve() {
      const gate = deferred();
      held.push(gate);
      return gate;
    },
    holdCapture() {
      captureHold = deferred();
      return captureHold;
    },
  };
}

test('a discovery invocation owns its request before release resolution', async () => {
  const f = fixture();
  const request = liveRequest();
  const gate = f.holdResolve();
  const pending = f.search('anonymous', request, f.context);
  await Promise.resolve();
  mutate(request);
  gate.resolve();
  const page = await pending;
  expect(f.seen[0]).toMatchObject({
    text: 'kokoro',
    filter: { kind: { in: ['account'] } },
    languages: ['en', 'fr'],
    properties: ['schema:author'],
  });
  expect(f.seen[0]).not.toHaveProperty('cursor');
  expect(f.seen[0]?.kindPage).toEqual({ limit: 1 });
  expect(f.plans[0]).toMatchObject({
    boost: 'kokoro',
    filterDocument: { kind: { in: ['account'] } },
  });
  expect(page.kinds.values[0]).toMatchObject({ id: 'account', count: { kind: 'account', value: 1, exact: false } });

  const next = liveRequest();
  mutate(next);
  await f.search('anonymous', next, f.context);
  expect(f.seen[1]).toMatchObject({
    text: 'mutated',
    filter: { kind: { in: ['schema:Person', 'schema:Book'] } },
    languages: ['fr', 'en', 'de'],
    properties: ['schema:author', 'schema:datePublished'],
    cursor: 'forged-cursor',
  });
});

test('capture-time mutation cannot change continuation selection or authenticated binding', async () => {
  const f = fixture();
  const request = liveRequest();
  const capture = f.holdCapture();
  const pending = f.search('anonymous', request, f.context);
  await Promise.resolve();
  mutate(request);
  capture.resolve();
  const page = await pending;
  expect(f.plans).toHaveLength(1);
  expect(f.plans[0]).toMatchObject({ boost: 'kokoro', filterDocument: { kind: { in: ['account'] } } });
  expect(page.kinds.values[0]).toMatchObject({ count: { kind: 'account', value: 1, exact: false } });

  const original = liveRequest();
  const admitted = admitDiscoveryRequest(original, f.current, bundledRelease);
  const registryDigest = createHash('sha256')
    .update(
      canonicalize(
        f.current.entries.map((entry) => ({
          owner: entry.owner,
          kind: entry.kind,
          domains: entry.domains,
          metadata: entry.metadata,
        })),
      )!,
    )
    .digest('hex');
  const consumer = {
    physicalTarget: 'discovery-unit',
    incarnation: 'incarnation',
    consumerGeneration: '1',
    projectionGeneration: '1',
    meaningDigest: 'meaning',
    readDefinition: 'definition',
  };
  const cursor = await encodeDiscoveryCursor(
    keys,
    { operation: 'subjects.search.discovery-v1', principal: 'anonymous', request: admitted.bindingRequest },
    {
      release: bundledDigest,
      registry: registryDigest,
      queried: {
        consumer,
        snapshot: { kind: 'prepared', observation: 'observation', build: 'build', generation: 1n },
      },
      after: [],
      retained: { execution: 'execution', consumed: 1 },
    },
    now,
  );
  const continued = liveRequest();
  continued.cursor = cursor;
  const gate = f.holdResolve();
  const continuation = f.search('anonymous', continued, f.context);
  await Promise.resolve();
  mutate(continued);
  continued.cursor = 'forged-cursor';
  gate.resolve();
  const next = await continuation;
  expect(next.hits).toHaveLength(1);
  expect(f.plans).toHaveLength(1);
});

test('malformed discovery requests stay on the existing invalid and unsupported boundaries', async () => {
  const f = fixture();
  const reject = async (request: MixedDiscoveryRequest, code: string, pointer: string) => {
    try {
      await f.search('anonymous', request, f.context);
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemError);
      expect(error).toMatchObject({ code, errors: [{ pointer }] });
    }
  };
  await reject({ representation: 'discovery-v1', languages: 'en' as never }, 'invalid_request', '/languages');
  await reject({ representation: 'discovery-v1', kindPage: {} as never }, 'invalid_request', '/kindPage/limit');
  await reject({ representation: 'discovery-v1', text: '-kokoro' }, 'unsupported_query', '/text');
  await reject(
    { representation: 'discovery-v1', filter: { kind: { in: ['absent'] } } },
    'unsupported_query',
    '/filter/kind/in/0',
  );
});

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test('default discovery owns hydration languages before activeRelease', async () => {
  const languages: Array<readonly string[] | undefined> = [];
  const gate = deferred();
  spies.push(
    spyOn(definitions, 'activeRelease').mockImplementation(async () => {
      await gate.promise;
      return { digest: bundledDigest, head: 1, release: bundledRelease };
    }),
    spyOn(accountDiscovery, 'nativeDiscoveryRegistry').mockImplementation(async (_pool, _routeKey, _subjects, options) => {
      languages.push(options?.languages ? [...options.languages] : options?.languages);
      throw new Error('owned languages recorded');
    }),
    spyOn(hydration, 'createNativeDiscoveryRegistry').mockImplementation((options) => {
      languages.push(options.languages ? [...options.languages] : options.languages);
      throw new Error('owned languages recorded');
    }),
  );
  const discovery = createDefaultDiscoverySearch({
    pool: { query: async () => ({ rows: [] }), options: { connectionString: '' } } as unknown as Pool,
    routeKey: new Uint8Array(32).fill(1),
    access: new Proxy({} as Access, {
      get() {
        throw new Error('Unexpected Access read');
      },
    }),
    search: {
      request: async () => ({ status: 503, body: {} }),
      bulk: async () => ({ errors: true }),
    },
    prefix: 'own-',
    clock: () => new Date(now),
    keys,
  });
  try {
    const request = liveRequest();
    const pending = discovery.open('anonymous', request, {
      access: new Proxy({} as Access, {
        get() {
          throw new Error('Unexpected Access read');
        },
      }),
      actor: { kind: 'anonymous' },
      deadline: now + 30_000,
    });
    await Promise.resolve();
    mutate(request);
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'index_not_ready' });
    expect(languages).toEqual([['en', 'fr']]);
  } finally {
    await discovery.close();
  }
});
