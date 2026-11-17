import { expect, test } from 'bun:test';
import { classifyDiscoveryMetadataProducers } from '../../src/search/discovery-readiness.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import { discoveryCapabilityWitnesses } from '../../src/search/generations.ts';
import { DiscoveryReviewInvalidationPendingError } from '../../src/search/operation-outcomes.ts';

test('review population readiness follows native pageWithCut and omits a preparing producer', async () => {
  const page = (state: 'ready' | 'preparing' | 'unavailable') => ({
    state,
    partition: 0,
    position: 0n,
    reviews: [],
    next: null,
    ...(state === 'ready' ? {} : { missing: 'lifecycle-invalidation' }),
  });
  const source = (state: 'ready' | 'preparing' | 'unavailable') =>
    ({
      pageWithCut: async () => page(state),
      read: async () => {
        throw new Error('readiness must not read reviews');
      },
    }) as never;
  const clock = () => new Date();
  for (const state of ['preparing', 'unavailable', 'ready'] as const) {
    const producers = createDiscoveryProducerEntry({
      clock,
      pool: {} as never,
      routeKey: new Uint8Array(32),
      access: {} as never,
      reviewSource: source(state),
    });
    expect(producers.metadataProducers.review?.pageCapabilityWitness).toBeUndefined();
    expect(await producers.metadataProducers.review?.readiness()).toBe(state);
  }
  const preparing = createDiscoveryProducerEntry({
    clock,
    pool: {} as never,
    routeKey: new Uint8Array(32),
    access: {} as never,
    reviewSource: source('preparing'),
  });
  const classification = await classifyDiscoveryMetadataProducers({
    review: preparing.metadataProducers.review!,
  });
  expect(classification.availableKinds).toEqual([]);
  expect(classification.omittedKinds).toContainEqual({ kind: 'review', state: 'preparing' });
});

test('the production entry opts only native status probes out of capability page fences', () => {
  const { metadataProducers } = createDiscoveryProducerEntry({
    clock: () => new Date(),
    pool: {} as never,
    routeKey: new Uint8Array(32),
    access: {} as never,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32)]]) },
  });
  expect(metadataProducers.review?.pageCapabilityWitness).toBe('none');
  expect(metadataProducers.collection?.pageCapabilityWitness).toBe('none');
  expect(metadataProducers.space?.pageCapabilityWitness).toBeUndefined();
});

test('a pending lifecycle invalidation blocks the first Review population page', async () => {
  const producers = createDiscoveryProducerEntry({
    clock: () => new Date(),
    pool: {} as never,
    routeKey: new Uint8Array(32),
    access: {} as never,
    reviewSource: {
      pageWithCut: async () => ({
        state: 'preparing',
        partition: 0,
        position: 0n,
        reviews: [],
        next: null,
        missing: 'lifecycle-invalidation',
      }),
      read: async () => {
        throw new Error('preparing pages must not read reviews');
      },
    } as never,
  });
  expect(await discoveryCapabilityWitnesses({ review: producers.metadataProducers.review! })).toEqual({});
  await expect(producers.metadataProducers.review!.page(0, null, null, 100)).rejects.toBeInstanceOf(
    DiscoveryReviewInvalidationPendingError,
  );
});

test('review population readiness treats an Access deadline as preparing', async () => {
  const producers = createDiscoveryProducerEntry({
    clock: () => new Date(),
    pool: {} as never,
    routeKey: new Uint8Array(32),
    access: {} as never,
    reviewSource: {
      pageWithCut: async () => {
        throw new AccessUnavailableError('deadline');
      },
      read: async () => {
        throw new Error('readiness must not read reviews');
      },
    } as never,
  });
  expect(await producers.metadataProducers.review?.readiness()).toBe('preparing');
});
