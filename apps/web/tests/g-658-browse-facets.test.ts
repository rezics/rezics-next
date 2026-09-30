import { describe, expect, test } from 'bun:test';
import { facetRegistry } from '../../../packages/model/src/generated/facets.ts';
import { browseFacets } from '../features/zones/browse-state.ts';

/** Current Facet names from the generated admitted-Facet registry (`GET /v1/facets`). */
const admitted = new Set<string>(Object.values(facetRegistry).filter(facet => facet.current).map(facet => facet.name));

/**
 * `status` and `length` are composition statistics Main's browse still filters
 * by. They are not admitted Facets yet. Every other browse name must be one.
 */
const compositionStatistics = new Set(['status', 'length']);

describe('G-658 browse Facets', () => {
  test('the browse list is type, Tags, status and length', () => {
    expect([...browseFacets]).toEqual(['concept', 'status', 'length', 'type']);
  });

  test('a browse name absent from the admitted Facet registry fails', () => {
    expect(browseFacets.filter(name => !admitted.has(name) && !compositionStatistics.has(name))).toEqual([]);
  });
});
