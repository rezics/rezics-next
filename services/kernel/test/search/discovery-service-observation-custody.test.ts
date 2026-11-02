import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createDiscoverySearch } from '../../src/search/discovery-service.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import { admitDiscoveryRequest } from '../../src/search/discovery-request.ts';
import { encodeSearchCursor } from '../../src/search/cursor.ts';
import { installPublicFilterCoveragePage, type PublicFilterCoveragePage } from '../../src/search/public-filter-coverage-page.ts';
import type { DiscoveryReadContext, DiscoveryRegistry } from '../../src/search/discovery.ts';
import type {
  PublicDiscoveryConsumerOperations,
  PublicFilterConsumerJob,
  PublicFilterQueriedObservation,
} from '../../src/search/public-filter-consumer-contract.ts';
import type { PublicFilterSource } from '../../src/semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumer } from '../../src/semantic/public-filter-source-contract.ts';

const now = 1_000;
const keys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };

async function fixture(captureStatus: 'captured' | 'preparing' = 'captured', closeError?: Error) {
  let producerReads = 0;
  let hydrationCalls = 0;
  let publicSourceReads = 0;
  let captures = 0;
  let queries = 0;
  let closes = 0;
  const closedObservations: PublicFilterQueriedObservation[] = [];
  let repairs = 0;
  let asOfCalls = 0;
  const noRead = async (): Promise<never> => {
    producerReads++;
    throw new Error('unexpected current-source read');
  };
  const noHydrate = async (): Promise<never> => {
    hydrationCalls++;
    throw new Error('unexpected hydration');
  };
  const registry = createDiscoveryRegistry({
    release: bundledRelease,
    semantic: {
      source: { read: noRead, count: noRead },
      hydrate: noHydrate,
      icons: Object.fromEntries(Object.keys(bundledRelease.types).map((kind) => [kind, 'catalogue'])),
    },
    accounts: {
      source: { read: noRead, count: noRead, page: noRead },
      hydrate: noHydrate,
      labels: { en: 'Accounts' },
      icon: 'account',
    },
  });
  const oldConsumer: PublicFilterConsumer = {
    physicalTarget: 'subjects-g1',
    incarnation: 'incarnation-1',
    consumerGeneration: 'consumer-1',
    projectionGeneration: 'projection-1',
    meaningDigest: null,
    readDefinition: null,
  };
  const newConsumer: PublicFilterConsumer = { ...oldConsumer, physicalTarget: 'subjects-g2', incarnation: 'incarnation-2' };
  const queried: PublicFilterQueriedObservation = {
    consumer: newConsumer,
    snapshot: { kind: 'pit', observation: 'observation-2', pit: 'pit-2' },
  };
  const repair: PublicFilterConsumerJob = { consumer: newConsumer, job: 'repair-2' };
  const request = { representation: 'discovery-v1' as const, limit: 1, kindPage: { limit: 1 } };
  const admitted = admitDiscoveryRequest(request, registry, bundledRelease);
  const registryDigest = createHash('sha256')
    .update(
      canonicalize(
        registry.entries.map((entry) => ({
          owner: entry.owner,
          kind: entry.kind,
          domains: entry.domains,
          metadata: entry.metadata,
        })),
      )!,
    )
    .digest('hex');
  const cursor = await encodeSearchCursor(
    keys,
    {
      operation: 'subjects.search.discovery-v1.kinds',
      principal: 'anonymous',
      request: admitted.bindingRequest,
    },
    {
      generation: 1,
      after: [bundledDigest, registryDigest, registry.entries[0]!.kind, canonicalize(oldConsumer)!],
    },
    now,
  );
  const publicSource = new Proxy(
    {},
    {
      get() {
        publicSourceReads++;
        throw new Error('unexpected public source read');
      },
    },
  ) as PublicFilterSource;
  const consumer = {
    repairStep: async () => {
      repairs++;
      return {};
    },
    closeObservation: async (observation: PublicFilterQueriedObservation) => {
      closes++;
      closedObservations.push(observation);
      if (closeError) throw closeError;
    },
  } as unknown as PublicDiscoveryConsumerOperations;
  const coverage = {
    capture: async () => {
      captures++;
      return captureStatus === 'preparing'
        ? { status: 'preparing', repair, cost: {} }
        : { status: 'captured', queried, repair, cost: {} };
    },
    queryDiscovery: async () => {
      queries++;
      throw new Error('unexpected discovery query');
    },
    dispose: async () => {},
  } as unknown as PublicFilterCoveragePage;
  installPublicFilterCoveragePage(consumer, () => coverage);
  const search = createDiscoverySearch({
    consumer,
    source: publicSource,
    keys,
    resolve: async () => ({ registry, release: bundledRelease, digest: bundledDigest }),
    now: () => now,
    asOf: async () => {
      asOfCalls++;
      return 'as-of';
    },
  });
  return {
    search,
    request: { ...request, kindPage: { ...request.kindPage, cursor } },
    context: { access: {}, actor: { kind: 'anonymous' }, deadline: now + 30_000 } as DiscoveryReadContext,
    queried,
    closedObservations,
    counts: () => ({
      producerReads,
      hydrationCalls,
      publicSourceReads,
      captures,
      queries,
      closes,
      repairs,
      asOfCalls,
    }),
  };
}

test('a kind physical-generation mismatch closes only its fresh observation before reading candidates', async () => {
  const testCase = await fixture();
  await expect(testCase.search('anonymous', testCase.request, testCase.context)).rejects.toMatchObject({
    code: 'search_restart_required',
  });
  expect(testCase.counts()).toEqual({
    producerReads: 0,
    hydrationCalls: 0,
    publicSourceReads: 0,
    captures: 1,
    queries: 0,
    closes: 1,
    repairs: 0,
    asOfCalls: 0,
  });
  expect(testCase.closedObservations).toEqual([testCase.queried]);
});

test('a failed cleanup preserves the kind-cursor restart error', async () => {
  const testCase = await fixture('captured', new Error('cleanup failed'));
  await expect(testCase.search('anonymous', testCase.request, testCase.context)).rejects.toMatchObject({
    code: 'search_restart_required',
  });
  expect(testCase.counts().closes).toBe(1);
});

test('a preparing capture remains with native repair custody', async () => {
  const testCase = await fixture('preparing');
  await expect(testCase.search('anonymous', testCase.request, testCase.context)).rejects.toMatchObject({
    code: 'index_not_ready',
  });
  expect(testCase.counts()).toMatchObject({ captures: 1, queries: 0, closes: 0, repairs: 1 });
});
