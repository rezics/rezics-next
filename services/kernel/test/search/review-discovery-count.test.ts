import { expect, test } from 'bun:test';
import type { ReviewDiscoveryCount } from '../../src/content/review-discovery.ts';
import { createReviewDiscoveryAdapter, type ContentReviewDiscoverySource } from '../../src/search/review-discovery.ts';

function source(count: ReviewDiscoveryCount): ContentReviewDiscoverySource {
  return { count: async () => count } as unknown as ContentReviewDiscoverySource;
}

test('Search retains Content count coverage and keeps incomplete totals unavailable', async () => {
  const current = {
    partition: 7,
    position: 42n,
    total: 3,
    coverage: 'complete',
    generation: 'ae85b67f-c265-4264-91b1-1bf4c21b86c2',
  } as const;
  expect(await createReviewDiscoveryAdapter(source(current)).count(7)).toEqual({ status: 'ready', value: current });
  expect(
    await createReviewDiscoveryAdapter(source({ partition: 7, position: 42n, unavailable: true })).count(7),
  ).toEqual({ status: 'ready', value: { partition: 7, position: 42n, unavailable: true } });
  const invalid = {
    partition: 7,
    position: 42n,
    total: 3,
    coverage: 'preparing',
    generation: current.generation,
  } as unknown as ReviewDiscoveryCount;
  await expect(createReviewDiscoveryAdapter(source(invalid)).count(7)).rejects.toThrow(
    'Invalid Content review discovery count',
  );
});
