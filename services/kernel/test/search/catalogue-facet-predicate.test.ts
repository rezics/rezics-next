import { expect, test } from 'bun:test';
import { releaseDigest } from '@rezics/definitions';
import { hasExactPublicFilterMeaning } from '../../src/search/public-filter-meaning.ts';
import { FilterError, FILTER_LIMITS, walkFilter, type FilterRelease } from '@rezics/filter';
import { catalogueFacetPredicate } from '../../src/search/catalogue-facet-predicate.ts';

const release = (types: string[]): FilterRelease => ({
  types: Object.fromEntries(types.map((type) => [type, {}])),
  properties: {},
});

test('the default catalogue facet predicate covers every pinned concrete type in stable order', () => {
  expect(catalogueFacetPredicate(release(['schema:Movie', 'schema:Book']), undefined)).toEqual({
    kind: 'predicate', predicate: { type: { in: ['schema:Book', 'schema:Movie'] } },
  });
});

test('a 65-type catalogue uses bounded existing OR and type leaves without truncation', () => {
  const types = Array.from({ length: 65 }, (_, index) => `ex:Type${String(index).padStart(3, '0')}`);
  const result = catalogueFacetPredicate(release([...types].reverse()), undefined);
  if (result.kind !== 'predicate') throw new Error('Expected a complete type predicate');
  const leaves = [...walkFilter(result.predicate)].filter((node) => 'type' in node);
  expect(leaves).toHaveLength(2);
  expect(leaves.flatMap((node) => 'type' in node ? node.type.in : [])).toEqual(types);
  expect(leaves.every((node) => 'type' in node && node.type.in.length <= FILTER_LIMITS.in)).toBe(true);
});

test('an explicit predicate retains its exact user meaning even with an empty catalogue', () => {
  const predicate = { type: { in: ['schema:Book'] } };
  const result = catalogueFacetPredicate(release([]), predicate);
  expect(result.kind === 'predicate' && result.predicate === predicate).toBe(true);
});

test('a catalogue without concrete types is explicit configuration state rather than an unfiltered query', () => {
  expect(catalogueFacetPredicate(release([]), undefined)).toEqual({ kind: 'empty' });
});

test('a catalogue outside the existing AST or value-byte bounds is refused rather than truncated', () => {
  const types = Array.from({ length: FILTER_LIMITS.in * FILTER_LIMITS.leaves + 1 }, (_, index) => `ex:T${index}`);
  expect(() => catalogueFacetPredicate(release(types), undefined)).toThrow(FilterError);
  expect(() => catalogueFacetPredicate(release([`ex:${'a'.repeat(129)}`]), undefined)).toThrow(FilterError);
});

test('release-only Source meanings retain the concrete-type projectability requirement', () => {
  const empty = release([]);
  expect(hasExactPublicFilterMeaning({ release: empty, digest: releaseDigest(empty) })).toBe(false);
  const concrete = release(['schema:Book']);
  expect(hasExactPublicFilterMeaning({ release: concrete, digest: releaseDigest(concrete) })).toBe(true);
});
