import { expect } from 'bun:test';

/** Selected reads retain the opening query budget and recheck only consumed
 * inputs. A closing pass cannot discover a new relation or grow with inventory. */
export function assertSelectedQueryCost(queries: readonly string[], openingLimit: number) {
  const closing = queries.findIndex((query, index) => index > 0 && query === queries[0]);
  expect(closing).toBeGreaterThan(0);
  const opening = queries.slice(0, closing), fence = queries.slice(closing);
  expect(opening.length).toBeLessThanOrEqual(openingLimit);
  expect(fence.length).toBeLessThanOrEqual(opening.length);
  const retained = [...opening];
  for (const query of fence) {
    const index = retained.indexOf(query);
    expect(index, 'a final fence must repeat a bounded opening input').toBeGreaterThanOrEqual(0);
    retained.splice(index, 1);
  }
}
