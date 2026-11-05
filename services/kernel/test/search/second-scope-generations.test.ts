import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  allocateDiscovery,
  assertDiscoveryProducerCoverage,
  DiscoveryProducerCoverageError,
  SECOND_SCOPE_PUBLIC_METADATA_KINDS,
  discoveryCapabilityMatches,
  discoveryCapabilityWitnesses,
  classifyDiscoveryMetadataProducers,
  DiscoveryPopulationCutChangedError,
  advanceDiscovery,
  DISCOVERY_LIVE_GENERATIONS_SQL,
} from '../../src/search/generations.ts';
import type { DiscoveryMetadataProducer } from '../../src/search/discovery-api.ts';
import type { DiscoveryRegistry } from '../../src/search/discovery.ts';
import { nativeDiscoveryRegistry } from '../../src/search/account-discovery.ts';
import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import { resolveDiscoveryOwnerAdapters } from '../../src/search/composition.ts';
import { createDiscoverySearch } from '../../src/search/discovery-service.ts';
import { CollectionDiscoveryReadinessError } from '../../src/search/collection-discovery.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import type { DiscoveryProducerEntry } from '../../src/search/index.ts';

test('a generation with missing public metadata producers is rejected before allocation', async () => {
  let connections = 0;
  const pool = {
    connect: async () => {
      connections += 1;
      throw new Error('incomplete producer coverage reached allocation I/O');
    },
  } as unknown as Pool;
  const registry = {
    entries: [
      { kind: 'account', owner: 'accounts' },
      { kind: 'subject', owner: 'semantic' },
    ],
  } as unknown as DiscoveryRegistry;

  await expect(allocateDiscovery(pool, 'search', registry, SECOND_SCOPE_PUBLIC_METADATA_KINDS)).rejects.toMatchObject({
    missingKinds: [...SECOND_SCOPE_PUBLIC_METADATA_KINDS],
    unsupportedKinds: [],
    duplicateKinds: [],
  });
  expect(connections).toBe(0);
});

test('a registered kind from an owner without a generation producer remains explicitly unready', () => {
  let error: unknown;
  try {
    assertDiscoveryProducerCoverage(
      [
        { kind: 'account', owner: 'accounts' },
        { kind: 'subject', owner: 'semantic' },
        { kind: 'collection', owner: 'commerce' },
        { kind: 'review', owner: 'content' },
        { kind: 'space', owner: 'content' },
      ],
      SECOND_SCOPE_PUBLIC_METADATA_KINDS,
    );
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(DiscoveryProducerCoverageError);
  expect(error).toMatchObject({ missingKinds: [], unsupportedKinds: ['collection', 'review', 'space'] });
});

test('metadata producer absence and readiness omit only that kind from generation requirements', async () => {
  const producer = (kind: 'collection' | 'review' | 'space', readiness: unknown) =>
    ({
      kind,
      owner: kind === 'collection' ? 'commerce' : 'content',
      readiness: async () => readiness,
    }) as unknown as DiscoveryMetadataProducer;
  const available = producer('collection', 'ready');
  const classification = await classifyDiscoveryMetadataProducers({
    collection: available,
    review: producer('review', 'preparing'),
  });

  expect(classification).toEqual({
    availableKinds: ['collection'],
    omittedKinds: [
      { kind: 'review', state: 'preparing' },
      { kind: 'space', state: 'unavailable' },
    ],
    witnesses: {},
  });
  expect(() =>
    assertDiscoveryProducerCoverage(
      [
        { kind: 'account', owner: 'accounts' },
        { kind: 'subject', owner: 'semantic' },
        { kind: 'collection', owner: 'commerce' },
      ],
      classification.availableKinds,
      ['account', 'subject', ...classification.availableKinds],
    ),
  ).not.toThrow();
});

test('query registration omits unavailable kinds and waits for the published generation', async () => {
  const producer = (kind: 'collection' | 'review' | 'space', readiness: unknown) =>
    ({ kind, owner: kind === 'collection' ? 'commerce' : 'content', readiness: async () => readiness }) as unknown as
      DiscoveryMetadataProducer;
  const entry = {
    ownerAdapters: {
      collection: { readiness: 'ready', adapter: {} },
      review: { readiness: 'ready', adapter: {} },
      space: { readiness: 'ready', adapter: {} },
    },
    metadataProducers: {
      collection: producer('collection', 'ready'),
      review: producer('review', 'unavailable'),
      space: producer('space', {
        state: 'ready',
        generation: 'space-A',
        cut: 'space-cut-A',
        capabilities: { context: 'connected', media: 'connected', exposure: 'connected', 'source-fence': 'connected' },
      }),
    },
  } as unknown as DiscoveryProducerEntry;
  const resolved = await resolveDiscoveryOwnerAdapters(entry, ['collection']);

  expect(Object.keys(resolved.metadataProducers)).toEqual(['collection']);
  expect(resolved.omittedKinds).toMatchObject([
    { id: 'review', state: 'unavailable' },
    { id: 'space', state: 'preparing' },
  ]);
  expect(resolved.ownerAdapters.space).toEqual({ readiness: 'unavailable' });
});

test('default native owner readers register through the canonical slots without certifying population', async () => {
  let connections = 0;
  const pool = {
    connect: async () => {
      connections += 1;
      throw new Error('owner reader binding reached allocation I/O');
    },
  } as unknown as Pool;
  const routeKey = new Uint8Array(32);
  const producers = createDiscoveryProducerEntry({
    pool,
    routeKey,
    access: {} as never,
    reviewSource: {} as never,
  });
  const registry = await nativeDiscoveryRegistry(pool, routeKey, producers.subjects, {
    release: { types: {} } as never,
    ownerAdapters: producers.ownerAdapters,
    accounts: producers.accounts,
  });

  expect(registry.getOwnerAdapter('collection').owner).toBe('commerce');
  expect(registry.getOwnerAdapter('review').owner).toBe('content');
  expect(registry.getOwnerAdapter('space').owner).toBe('content');
  await expect(allocateDiscovery(pool, 'search', registry, SECOND_SCOPE_PUBLIC_METADATA_KINDS)).rejects.toBeInstanceOf(
    DiscoveryProducerCoverageError,
  );
  expect(connections).toBe(0);
});

test('default review population stays unready when the source has only the legacy key page', async () => {
  const producers = createDiscoveryProducerEntry({
    pool: {
      connect: async () => {
        throw new Error('readiness must not open a connection');
      },
    } as unknown as Pool,
    routeKey: new Uint8Array(32),
    access: {} as never,
    reviewSource: {} as never,
  });

  expect(await producers.metadataProducers.review?.readiness()).toBe('unavailable');
});

test('the installed Space capability survives JSON and cannot bind another physical target or producer epoch', async () => {
  let producerGeneration = 'native-A';
  const pool = {
    connect: async () => ({
      query: async () => ({
        rows: [
          {
            pending_install: '0',
            install_cut: 'installed',
            tuple_generation: 'native',
            tuple_cut: 'cut',
            required: '1',
            witnessed: '1',
            pending: '0',
            producer_generation: producerGeneration,
            producer_cut: 'same-position',
            producer_complete: true,
          },
        ],
      }),
      release() {},
    }),
  } as unknown as Pool;
  const entry = createDiscoveryProducerEntry({
    pool,
    routeKey: new Uint8Array(32),
    access: {} as never,
    reviewSource: {} as never,
  });
  const producers = { space: entry.metadataProducers.space! };
  const witnesses = await discoveryCapabilityWitnesses(producers);
  expect(witnesses.space).toMatchObject({ state: 'ready', capabilities: { 'source-fence': 'connected' } });
  const target = { prefix: 'search', generation: 1, uuid: 'physical-A', incarnation: 'allocation-A' };
  const binding = JSON.parse(
    JSON.stringify({
      physicalTarget: 'searchdiscovery-g1',
      uuid: target.uuid,
      incarnation: target.incarnation,
      witnesses,
    }),
  );
  expect(discoveryCapabilityMatches(target, binding, witnesses)).toBe(true);
  expect(discoveryCapabilityMatches({ ...target, uuid: 'physical-B' }, binding, witnesses)).toBe(false);
  expect(discoveryCapabilityMatches({ ...target, generation: 2 }, binding, witnesses)).toBe(false);
  expect(discoveryCapabilityMatches({ ...target, incarnation: 'allocation-B' }, binding, witnesses)).toBe(false);
  producerGeneration = 'native-B';
  const replacement = await discoveryCapabilityWitnesses(producers);
  expect(discoveryCapabilityMatches(target, binding, replacement)).toBe(false);
  // Numeric positions can return to the old value; the replaced epoch still differs.
  expect(replacement.space?.cut).toBe(witnesses.space?.cut);
  expect(replacement.space?.generation).not.toBe(witnesses.space?.generation);
});

test('a retired signed Review cut requests fresh population instead of retrying the opaque continuation', async () => {
  const producers = createDiscoveryProducerEntry({
    pool: {} as Pool,
    routeKey: new Uint8Array(32),
    access: {} as never,
    reviewSource: {
      pageWithCut: async () => ({
        state: 'changed',
        position: 7n,
        partition: 0,
        reviews: [],
        next: null,
        missing: 'cut-changed',
      }),
    } as never,
  });
  await expect(producers.metadataProducers.review!.page(0, null, null, 100)).rejects.toBeInstanceOf(
    DiscoveryPopulationCutChangedError,
  );
});

test('a later metadata reconciliation step resumes the committed raw frontier before indexed cleanup', async () => {
  const raw = { route: 160, id: '018f0000-0000-7000-8000-00a000000001' };
  const target = {
    prefix: 'search',
    generation: 1,
    uuid: 'physical',
    incarnation: 'allocation',
    state: 'reconciling',
    kinds: ['account'],
    capability: { physicalTarget: 'searchdiscovery-g1', uuid: 'physical', incarnation: 'allocation', witnesses: {} },
  };
  let frontier: unknown[] | undefined;
  let after: { route: number; id: string } | null = raw;
  const pool = {
    connect: async () => ({
      async query(sql: string, values?: unknown[]) {
        if (sql === DISCOVERY_LIVE_GENERATIONS_SQL) return { rows: [target] };
        if (sql.includes('SELECT partition_no AS partition,owner'))
          return {
            rows: [
              {
                partition: 10,
                owner: 'collection',
                after_route: after?.route ?? null,
                after_id: after?.id ?? null,
                continuation: null,
                position: '7',
                indexed: '0',
                reconcile_position: '7',
                native_complete: false,
                native_epoch: 1,
              },
            ],
          };
        if (sql.includes('SELECT index_uuid,incarnation::text,state'))
          return { rows: [{ index_uuid: target.uuid, incarnation: target.incarnation, state: target.state }] };
        if (sql.includes('native_complete=$8')) {
          frontier = values;
          after = values?.[5] ? { route: Number(values[4]), id: String(values[5]) } : null;
        }
        return { rows: [], rowCount: 1 };
      },
      release() {},
    }),
  } as unknown as Pool;
  let pages = 0;
  const next = { ...raw, id: raw.id.replace(/1$/, '2') };
  const producer: DiscoveryMetadataProducer = {
    kind: 'collection',
    owner: 'commerce',
    readiness: async () => 'ready',
    async page(partition, after, continuation, limit) {
      pages++;
      expect([partition, after, continuation, limit]).toEqual([10, pages === 1 ? raw : next, null, 100]);
      return {
        position: 7n,
        epoch: 1,
        next: pages === 1 ? next : null,
        continuation: null,
        keys: [],
        records: [],
      };
    },
    read: async () => {
      throw new Error('raw replay must precede indexed cleanup');
    },
    position: async () => 7n,
  };
  const account = { owner: 'accounts', kind: 'account' };
  const search = {
    async request(_method: string, path: string) {
      expect(path).toBe('/searchdiscovery-g1/_settings');
      return { status: 200, body: { 'searchdiscovery-g1': { settings: { index: { uuid: target.uuid } } } } };
    },
  } as unknown as OpenSearch;
  const options = {
    pool,
    search,
    prefix: target.prefix,
    listing: {} as never,
    registry: { entries: [account], get: () => account } as unknown as DiscoveryRegistry,
    metadataProducers: { collection: producer },
  };
  await advanceDiscovery(options);
  expect(pages).toBe(1);
  expect(frontier?.slice(4, 9)).toEqual([160, next.id, null, false, '7']);
  await advanceDiscovery(options);
  expect(pages).toBe(2);
  expect(frontier?.slice(4, 9)).toEqual([null, null, null, true, '7']);
});

test('the public reader preserves Collection typed readiness instead of returning empty discovery', async () => {
  const failure = new CollectionDiscoveryReadinessError('unavailable', 'partition');
  const search = createDiscoverySearch({
    resolve: async () => {
      throw failure;
    },
    consumer: {} as never,
    source: {} as never,
    keys: {} as never,
    now: Date.now,
    asOf: async () => new Date().toISOString(),
  });
  await expect(
    search(
      'anonymous',
      { representation: 'discovery-v1' },
      { actor: { kind: 'anonymous' }, access: {} as never, deadline: Date.now() + 10_000 },
    ),
  ).rejects.toBe(failure);
});
