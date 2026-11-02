import { afterAll, expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import type { Release } from '@rezics/definitions';
import type { Access } from '../../src/request/access.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import type {
  PublicDiscoveryConsumerOperations,
  PublicFilterConsumerJob,
  PublicFilterQueriedObservation,
} from '../../src/search/public-filter-consumer-contract.ts';
import * as consumer from '../../src/search/public-filter-consumer.ts';
import * as definitions from '../../src/semantic/definitions.ts';
import * as indices from '../../src/search/indices.ts';
import { createDefaultPublicFilterRuntime } from '../../src/search/public-runtime.ts';

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
const digest = `sha256:${'a'.repeat(64)}`;
const release = { types: { 'schema:Thing': {} } } as Release;
const context = () => ({ deadline: Date.now() + 10_000 });
const plan = { filterDocument: undefined, text: undefined, sort: 'id' as const, size: 1, pageSize: 1 };

type Factory = PublicDiscoveryConsumerOperations & {
  closed: number;
  observations: Set<string>;
  repairs: number;
};

const factories: Factory[] = [];
let active = 1;
const factory = spyOn(consumer, 'createPublicFilterConsumerOperations').mockImplementation(async (config) => {
  const observations = new Set<string>();
  let closed = 0;
  let repairs = 0;
  const lost = () => ({ status: 'unavailable' as const, reason: 'observation_lost' as const, cost });
  const native: Factory = {
    observations,
    get closed() {
      return closed;
    },
    get repairs() {
      return repairs;
    },
    async capture() {
      if (closed) return lost();
      const observation = `observation-${observations.size}`;
      observations.add(observation);
      const queried = queriedOf(config.physicalTarget, observation);
      return { status: 'captured', queried, repair: { consumer: queried.consumer, job: observation }, cost };
    },
    async captureDiscovery() {
      throw new Error('unexpected mixed capture');
    },
    async queryDiscovery() {
      throw new Error('unexpected mixed query');
    },
    async query(queried) {
      if (closed || !observations.has(queried.snapshot.observation)) return lost();
      return {
        status: 'queried',
        queried,
        execution: 'execution',
        start: { observation: 'start' },
        result: { hits: [], total: { value: 0, relation: 'eq' as const } },
        window: { positions: [], examined: 0, exhausted: false },
        cost,
      };
    },
    async repairStep(job) {
      if (closed) return lost();
      repairs += 1;
      return { status: repairs === 1 ? 'progress' : 'settled', job, cost };
    },
    async readStatus() {
      return lost();
    },
    async closeObservation(queried) {
      observations.delete(queried.snapshot.observation);
    },
    async close() {
      if (closed) return;
      closed += 1;
      observations.clear();
    },
  };
  factories.push(native);
  return native;
});
const activeRelease = spyOn(definitions, 'activeRelease').mockImplementation(async () => ({
  digest,
  head: 1,
  release,
}));
const readRelease = spyOn(definitions, 'readRelease').mockImplementation(async () => release);
const generations = spyOn(indices, 'subjectGenerations').mockImplementation(async () => ({
  generations: [active],
  active,
}));

afterAll(() => {
  factory.mockRestore();
  activeRelease.mockRestore();
  readRelease.mockRestore();
  generations.mockRestore();
});

function queriedOf(physicalTarget: string, observation: string): PublicFilterQueriedObservation {
  return {
    consumer: {
      physicalTarget,
      incarnation: 'incarnation',
      consumerGeneration: '1',
      projectionGeneration: '1',
      meaningDigest: digest,
      readDefinition: 'definition',
    },
    snapshot: { kind: 'prepared', observation, build: 'build', generation: 1n },
  };
}

function runtime() {
  return createDefaultPublicFilterRuntime({
    pool: { connect: async () => ({}), query: async () => ({ rows: [] }) } as unknown as Pool,
    routeKey: new Uint8Array(32),
    access: { authorize: async () => false, authenticate: async () => ({ kind: 'anonymous' }) } as unknown as Access,
    search: { request: async () => ({ status: 200, body: {} }), bulk: async () => ({}) } as OpenSearch,
    prefix: 'unit-',
    clock: () => new Date(),
  });
}

test('a Subject continuation and multistep repair survive request cleanup; explicit exhaustion and runtime shutdown release actual native resources without an unbounded factory history', async () => {
  const publicRuntime = runtime();
  const first = await publicRuntime.bindRequest({ plan, snapshot: 'prepared' }, context());
  expect(first.capture.status).toBe('captured');
  if (first.capture.status !== 'captured') throw new Error('capture required');
  const queried = first.capture.queried;
  expect((await first.operations.query(queried, context())).status).toBe('queried');
  await first.operations.close();
  expect(factories).toHaveLength(1);
  expect(factories[0]!.closed).toBe(0);
  expect(factories[0]!.observations.size).toBe(1);

  const resumed = await publicRuntime.resumeRequest(queried, context());
  expect(resumed).not.toBe(first.operations);
  expect((await resumed.query(queried, context())).status).toBe('queried');
  await publicRuntime.bindRequest({ plan, snapshot: 'prepared' }, context());
  expect(factories).toHaveLength(1);

  const job: PublicFilterConsumerJob = first.capture.repair;
  expect((await publicRuntime.repair(job, context())).status).toBe('progress');
  expect((await publicRuntime.repair(job, context())).status).toBe('settled');
  expect(factories).toHaveLength(1);
  expect(factories[0]!.repairs).toBe(2);
  expect(factories[0]!.closed).toBe(0);

  await resumed.closeObservation(queried, context());
  expect(factories[0]!.observations.size).toBe(0);
  expect((await resumed.query(queried, context())).status).toBe('unavailable');
  await resumed.close();

  active = 2;
  const replaced = await publicRuntime.bindRequest({ plan, snapshot: 'prepared' }, context());
  expect(factories).toHaveLength(2);
  expect(factories[0]!.closed).toBe(1);
  expect(factories[1]!.closed).toBe(0);
  await replaced.operations.close();

  await publicRuntime.close();
  await publicRuntime.close();
  expect(factories.map((item) => item.closed)).toEqual([1, 1]);
});
