import { expect, test } from 'bun:test';
import { admitFilter, FilterError, parseFilter, type FilterDocument, type FilterRelease } from '@rezics/filter';
import { compileCurrentFilter } from '../../src/search/current-filter-plan.ts';
import { admitFacets } from '../../src/search/facets.ts';
import { compileFilter } from '../../src/search/filter.ts';
import { readLiveFacets } from '../../src/search/live-facets.ts';
import type { SubjectSource } from '../../src/search/source.ts';

const release: FilterRelease = {
  types: { 'schema:Book': { facets: [] } },
  properties: {},
  filters: { 'owner/present': { filter: { owner: { presence: true } } } },
};
const book = { type: { in: ['schema:Book'] } };
const owners = [
  { owner: { presence: true } },
  { owner: { state: { profileId: 'book', stateSetId: 'set', in: ['planned'] } } },
  { owner: { label: { id: '018f0000-0000-7000-8000-00b00000000a' } } },
  { owner: { session: { profileId: 'book', lifecycle: 'completed' } } },
  { owner: { holding: { profileId: 'book', kind: 'physical', status: 'owned' } } },
];

function expressions(leaf: unknown): FilterDocument[] {
  return [leaf, { not: leaf }, { and: [book, { or: [book, { not: leaf }] }] }].map((input) =>
    admitFilter(parseFilter(input), release, { owner: true }),
  );
}

test('catalogue compilers explicitly reject each owner family including beneath NOT', () => {
  for (const leaf of owners) {
    for (const filter of expressions(leaf)) {
      for (const relationOverflow of [false, true])
        expect(() => compileFilter(filter, { prefix: 'f', relationOverflow })).toThrow('owner');
      expect(() => compileCurrentFilter(filter)).toThrow('owner');
    }
  }
  const expanded = admitFilter(parseFilter({ not: { saved: 'owner/present' } }), release, { owner: true });
  expect(() => compileFilter(expanded, { prefix: 'f' })).toThrow('owner');
  expect(() => compileCurrentFilter(expanded)).toThrow('owner');
});

test('catalogue facet admission rejects owner dependencies at every Boolean depth and after saved expansion', () => {
  for (const leaf of owners) {
    for (const filter of expressions(leaf))
      expect(() => admitFacets([{ property: 'type', size: 10 }], filter, release)).toThrow(FilterError);
  }
  for (const filter of [
    { saved: 'owner/present' },
    { not: { saved: 'owner/present' } },
    { or: [book, { saved: 'owner/present' }] },
  ]) {
    expect(() => admitFacets([{ property: 'type', size: 10 }], parseFilter(filter), release)).toThrow(FilterError);
  }
});

test('live facets reject negative owner filters before any source IO', async () => {
  let reads = 0;
  const source = new Proxy({} as SubjectSource, {
    get() {
      reads++;
      throw new Error('No private or catalogue source IO is allowed');
    },
  });
  for (const leaf of owners) {
    await expect(
      readLiveFacets({
        source,
        hits: [],
        clauses: new Map(),
        filter: expressions(leaf)[1]!,
        facets: [{ property: 'type', size: 10 }],
        release,
        complete: true,
      }),
    ).rejects.toBeInstanceOf(FilterError);
  }
  expect(reads).toBe(0);
});
