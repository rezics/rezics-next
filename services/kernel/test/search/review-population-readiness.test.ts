import { expect, test } from 'bun:test';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import { classifyDiscoveryMetadataProducers } from '../../src/search/generations.ts';

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
  for (const state of ['preparing', 'unavailable', 'ready'] as const) {
    const producers = createDiscoveryProducerEntry({
      pool: {} as never,
      routeKey: new Uint8Array(32),
      access: {} as never,
      reviewSource: source(state),
    });
    expect(await producers.metadataProducers.review?.readiness()).toBe(state);
  }
  const preparing = createDiscoveryProducerEntry({
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

test('review population readiness treats an Access deadline as preparing', async () => {
  const producers = createDiscoveryProducerEntry({
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
