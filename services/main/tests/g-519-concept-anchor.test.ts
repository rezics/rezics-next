import { expect, test } from 'bun:test';
import type { ResourceQuery } from '../../../model/definitions/filter-document-v1.ts';
import { conceptQuery } from '../../../apps/web/features/concept/state.ts';
import { CONCEPT_FACET, conceptWorksFilter } from '../src/modules/concept-page/contract.ts';
import { compileQuery, QueryRejected } from '../src/modules/query/compile.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uuid = (n: number) => id(n).slice(-36);
const book = 'https://schema.org/Book';
const page = (filter: ResourceQuery['filter']): ResourceQuery => ({ context: 'global', scope: { kind: 'all' },
  sort: 'newest', page: { size: 20 }, filter });
const refusal = (filter: ResourceQuery['filter']) => {
  try { compileQuery(page(filter)); }
  catch (error) {
    if (error instanceof QueryRejected) return error.refusal;
    throw error;
  }
  return null;
};

test('G-519 an anchored match-any Filter is the page Concept and any of the additions', () => {
  expect(compileQuery(page({ all: [
    { facet: 'concept', all: [id(1)] },
    { facet: 'concept', any: [id(2), id(3)] },
    { facet: 'concept', none: [id(4)] },
    { facet: 'type', any: [book] },
  ] }))).toMatchObject({ template: 'concept-works', concept: id(1),
    request: { match: 'any', include: [id(2), id(3)], exclude: [id(4)], type: book } });
  // A one-value `any` is also an anchor, including when it follows the additions.
  expect(compileQuery(page({ all: [
    { facet: 'concept', any: [id(2), id(3)] }, { facet: 'concept', any: [id(1)] },
  ] }))).toMatchObject({ concept: id(1), request: { match: 'any', include: [id(2), id(3)] } });
  // Additions that match all stay one required set beside the page Concept.
  expect(compileQuery(page({ all: [
    { facet: 'concept', all: [id(1)] }, { facet: 'concept', all: [id(2), id(3)] },
  ] }))).toMatchObject({ concept: id(1), request: { match: 'all', include: [id(2), id(3)] } });
  // Match all of the page and its additions is still one Condition.
  expect(compileQuery(page({ all: [
    { facet: 'concept', all: [id(1), id(2)] }, { facet: 'concept', none: [id(4)] },
  ] }))).toMatchObject({ concept: id(1), request: { match: 'all', include: [id(2)], exclude: [id(4)] } });
});

test('G-519 a multi-value Concept any with no anchor is a typed refusal', () => {
  expect(refusal({ all: [{ facet: 'concept', any: [id(1), id(2)] }] })).toBe('unsupported_query_shape');
  expect(refusal({ all: [
    { facet: 'concept', any: [id(1), id(2)] }, { facet: 'concept', none: [id(4)] },
  ] })).toBe('unsupported_query_shape');
  expect(refusal({ all: [
    { facet: 'concept', any: [id(1), id(2)] }, { facet: 'concept', any: [id(3), id(4)] },
  ] })).toBe('unsupported_query_shape');
  // Discover's top-rated shelf has no page Concept and still matches any of one Condition.
  expect(compileQuery({ ...page({ all: [{ facet: 'concept', any: [id(1), id(2)] }] }), sort: 'top-rated',
    profile: 'filter-document-v2', ratingContext: id(9) })).toMatchObject({
    request: { role: 'filter', sort: 'top-rated', match: 'any', include: [id(1), id(2)] } });
});

test('G-519 the echoed Concept page Filter is the Filter the web emits', () => {
  const echoed = conceptWorksFilter(id(1), [id(2), id(3)], [id(4)], 'any');
  const emitted = conceptQuery({ concept: uuid(1), scope: { kind: 'global' }, include: [uuid(2), uuid(3)],
    exclude: [uuid(4)], match: 'any' }).filter;
  expect(emitted).toEqual({ all: [
    { facet: 'concept', all: [id(1)] },
    { facet: 'concept', any: [id(2), id(3)] },
    { facet: 'concept', none: [id(4)] },
  ] });
  if (!emitted || !('all' in emitted)) throw new Error('Concept Query has no Filter');
  expect({ all: emitted.all.map(condition => 'facet' in condition
    ? { ...condition, facet: CONCEPT_FACET } : condition) }).toEqual(echoed);
  expect(compileQuery(page(emitted))).toMatchObject({ concept: id(1),
    request: { match: 'any', include: [id(2), id(3)], exclude: [id(4)] } });
  expect(compileQuery(page(echoed))).toMatchObject({ concept: id(1),
    request: { match: 'any', include: [id(2), id(3)], exclude: [id(4)] } });
});
