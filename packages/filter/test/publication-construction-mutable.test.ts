import { expect, test } from 'bun:test';
import { admitFilter, createFilterConstruction, facetProperties, parseFilter, validateFilter } from '../src/filter.ts';
import { constructionFixture } from '../../definitions/test/support/publication-construction.ts';

test('same-object edits refresh patterns, qualifiers, bases, direct facets and untyped union in every raw entry point', () => {
  const release = constructionFixture(0, 64);
  const property = release.properties['grow:code']!;
  const typed = { and: [{ type: { in: ['grow:Root'] } }, { statement: { property: 'grow:code', in: ['A'] } }] };
  const untyped = { statement: { property: 'grow:code', in: ['A'] } };
  const assert = (filter: unknown, valid: boolean) => {
    expect(validateFilter(filter, release).length === 0).toBe(valid);
    if (valid) expect(admitFilter(parseFilter(filter), release)).toEqual(filter as any);
    else expect(() => admitFilter(parseFilter(filter), release)).toThrow();
  };
  assert(typed, true);
  assert(untyped, true);
  const owned = createFilterConstruction(release);
  (property.value as any).pattern = '^B$';
  assert(typed, false);
  assert(untyped, false);
  expect(owned.validateFilter(typed)).toEqual([]);
  (property.value as any).pattern = '^[A-Z]+$';
  const qualifier = property.qualifiers.at(-1)!;
  const qualified = {
    statement: { property: 'grow:code', in: ['A'], qualifiers: [{ property: qualifier, in: ['x'] }] },
  };
  assert(qualified, true);
  property.qualifiers.splice(0);
  assert(qualified, false);
  release.types['grow:Base'] = { ...structuredClone(release.types['grow:Root']!), bases: [], facets: ['grow:code'] };
  release.types['grow:Root']!.facets.splice(0);
  release.types['grow:Root']!.bases.push('grow:Base');
  assert(typed, true);
  expect(facetProperties(release, ['grow:Root'])).toEqual(['grow:code']);
  release.types['grow:Base']!.facets.splice(0);
  assert(typed, false);
  assert(untyped, false);
  expect(facetProperties(release, ['grow:Root'])).toEqual([]);
  let reads = 0;
  Object.defineProperty(release.types['grow:Base'], 'facets', {
    configurable: true,
    get() {
      reads++;
      return ['grow:code'];
    },
  });
  assert(typed, false);
  assert(untyped, false);
  expect(facetProperties(release, ['grow:Root'])).toEqual([]);
  expect(reads).toBe(0);
  Object.defineProperty(release.types['grow:Base'], 'facets', { configurable: true, value: new Array(1) });
  assert(typed, false);
  assert(untyped, false);
  delete release.types['grow:Base'];
  Object.setPrototypeOf(release.types, { 'grow:Base': { facets: ['grow:code'] } });
  assert(typed, false);
  assert(untyped, false);
});
