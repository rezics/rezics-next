import { expect, test } from 'bun:test';
import { admitFilter, parseFilter, type FilterRelease, type OwnerLeaf } from '@rezics/filter';
import {
  compileCurrentFilter,
  compileCurrentOwnerFilter,
  currentClauseKey,
  currentOwnerClauseKey,
  type CurrentNativeLeaf,
  type CurrentOwnerFilterPlan,
} from '../../src/search/current-filter-plan.ts';
import type { RelationFacetMatch } from '../../src/search/source.ts';

const book = { type: { in: ['schema:Book'] } };
const presence: OwnerLeaf = { owner: { presence: true } };
const state: OwnerLeaf = {
  owner: { state: { profileId: 'book', stateSetId: 'reading', in: ['planned', 'finished'] } },
};
const release: FilterRelease = {
  types: { 'schema:Book': { facets: [] } },
  properties: {},
  filters: { 'owner/present': { filter: presence } },
};
const native = (leaf: OwnerLeaf): CurrentNativeLeaf => ({ kind: 'owner', leaf });

test('mixed native plans deduplicate exact pins and preserve unknown through the shared Boolean interpreter', () => {
  const equivalent: OwnerLeaf = {
    owner: { state: { in: ['finished', 'planned'], stateSetId: 'reading', profileId: 'book' } },
  };
  const filter = admitFilter(
    parseFilter({ or: [{ and: [book, { not: state }] }, { and: [equivalent, { saved: 'owner/present' }] }] }),
    release,
    { owner: true },
  );
  const plan: CurrentOwnerFilterPlan = compileCurrentOwnerFilter(filter);
  const catalogue = { kind: 'catalogue', clause: { facet: 'type', values: ['schema:Book'] } } as const;
  expect(plan.leaves).toEqual([catalogue, native(state), native(presence)]);
  expect([...plan.indices]).toEqual(plan.leaves.map((leaf, index) => [currentOwnerClauseKey(leaf), index]));
  expect([...plan.positive]).toEqual([0, 1, 2]);
  expect(currentOwnerClauseKey(native(state))).toBe(currentOwnerClauseKey(native(equivalent)));
  expect(currentOwnerClauseKey(catalogue)).toBe(JSON.stringify(['catalogue', currentClauseKey(catalogue.clause)]));
  expect(plan.evaluate(Object.freeze([true, 'not_proven', false]))).toBe('not_proven');
  expect(plan.evaluate([false, 'not_proven', false])).toBe(false);
  expect(plan.evaluate([true, false, false])).toBe(true);
  expect(plan.evaluate([false, true, true])).toBe(true);
  const negated = compileCurrentOwnerFilter({ not: { and: [state, { not: presence }] } });
  expect([...negated.positive]).toEqual([1]);
  expect(negated.evaluate(['not_proven', false])).toBe('not_proven');

  // Even a true OR branch requires a complete, exact evidence vector for all leaves.
  const alternative = compileCurrentOwnerFilter({ or: [book, presence] });
  const hole: RelationFacetMatch[] = [true];
  hole.length = 2;
  for (const malformed of [[true], [true, false, true], hole, [true, undefined], [true, 'unknown'], [true, 1]])
    expect(() => alternative.evaluate(malformed as readonly RelationFacetMatch[])).toThrow('Malformed');
});

test('owner keys retain every family pin while catalogue compilation rejects all owners before I/O', () => {
  const owners: OwnerLeaf[] = [
    presence,
    state,
    { owner: { state: { profileId: 'film', stateSetId: 'reading', in: ['planned', 'finished'] } } },
    { owner: { state: { profileId: 'book', stateSetId: 'watching', in: ['planned', 'finished'] } } },
    { owner: { state: { profileId: 'book', stateSetId: 'reading', in: ['planned'] } } },
    { owner: { label: { id: '018f0000-0000-7000-8000-00b00000000a' } } },
    { owner: { label: { id: '018f0000-0000-7000-8000-00b00000000b' } } },
    { owner: { session: { profileId: 'book', lifecycle: 'active' } } },
    { owner: { session: { profileId: 'film', lifecycle: 'active' } } },
    { owner: { session: { profileId: 'book', lifecycle: 'completed' } } },
    { owner: { session: { profileId: 'book', lifecycle: 'abandoned' } } },
    { owner: { holding: { profileId: 'book' } } },
    { owner: { holding: { profileId: 'film' } } },
    { owner: { holding: { profileId: 'book', kind: 'physical' } } },
    { owner: { holding: { profileId: 'book', status: 'owned' } } },
    { owner: { holding: { profileId: 'book', kind: 'physical', status: 'owned' } } },
  ];
  const plan = compileCurrentOwnerFilter({ or: owners });
  expect(plan.leaves).toEqual(owners.map(native));
  expect(plan.indices.size).toBe(owners.length);
  for (const owner of owners) {
    const expanded = admitFilter(parseFilter({ or: [book, { not: owner }] }), release, { owner: true });
    expect(() => compileCurrentFilter(expanded)).toThrow('owner');
  }
  const expanded = admitFilter(parseFilter({ saved: 'owner/present' }), release, { owner: true });
  expect(compileCurrentOwnerFilter(expanded).leaves).toEqual([native(presence)]);
  expect(() => compileCurrentFilter(expanded)).toThrow('owner');
  for (const compile of [compileCurrentFilter, compileCurrentOwnerFilter]) {
    expect(() => compile({ saved: 'owner/present' })).toThrow('admitted, expanded');
    expect(() => compile({ or: [book, { not: { saved: 'owner/present' } }] })).toThrow('admitted, expanded');
  }
});
