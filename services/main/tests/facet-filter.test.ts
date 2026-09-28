import { expect, test } from 'bun:test';
import { checkedFilter, FILTER_LIMITS, InvalidFilter, type Condition, type FilterGroup, type FilterRefusal }
  from '../src/modules/facets/schema.ts';

const id = (n: number) => `https://rezics.com/id/019d0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const definition = id(1), lead = `${id(2)}/role/lead`, work = `${id(2)}/role/work`;
const appearance = (where: FilterGroup): Condition => ({ facet: 'relation', bind: { definition, role: work }, where });
const gender = (values: string[]): Condition => ({ facet: 'statement', any: values,
  bind: { predicate: 'https://rezics.com/vocab/gender', relationDefinition: 'https://rezics.com/definition/gender-v1' } });

function refusal(filter: unknown): FilterRefusal | null {
  try { checkedFilter(filter as FilterGroup); return null; }
  catch (error) { if (error instanceof InvalidFilter) return error.refusal; throw error; }
}

test('Facets: a Filter over admitted Facets is admitted and names its exact DefinitionRefs', () => {
  // The contract's example: a female lead in one appearance, read with every Condition bound to it.
  expect(checkedFilter({ all: [
    { facet: 'type', any: ['https://schema.org/Book'] },
    { facet: 'concept', any: [id(3)], interpretation: { definition: id(4) } },
    { facet: 'author', any: [id(5), { provider: 'open-library', namespace: 'author', key: 'OL21594A' }] },
    { facet: 'language', none: ['ja'] },
    { facet: 'rating', bind: { ratingContext: id(6) }, range: { min: '7.5' } },
    appearance({ all: [{ facet: 'role', any: [lead] }, gender([id(7)])] }),
  ] })).toEqual(['author', 'concept', 'language', 'rating', 'relation', 'role', 'statement', 'type']
    .map(name => `https://rezics.com/definition/facet-${name}-v1`));
  expect(checkedFilter({ any: [{ facet: 'https://rezics.com/definition/facet-realm-v1', any: [id(8)] }] }))
    .toEqual(['https://rezics.com/definition/facet-realm-v1']);
});

test('Facets: an inexpressible Filter is a typed refusal, never an empty result', () => {
  expect(refusal({ all: [{ facet: 'kind', any: ['https://schema.org/Book'] }] })).toBe('unknown_facet');
  expect(refusal({ all: [{ facet: 'https://rezics.com/definition/facet-type-v9', any: ['x'] }] })).toBe('unknown_facet');
  // Occurrence Facets describe one co-participant; Resource Facets describe the queried Work.
  expect(refusal({ all: [{ facet: 'role', any: [lead] }] })).toBe('misplaced_facet');
  expect(refusal({ all: [appearance({ all: [{ facet: 'type', any: ['https://schema.org/Book'] }] })] }))
    .toBe('misplaced_facet');
  expect(refusal({ all: [{ facet: 'type', any: ['https://schema.org/Book'], where: { all: [] } }] }))
    .toBe('misplaced_facet');
  expect(refusal({ all: [{ facet: 'type', range: { min: '1' } }] })).toBe('operator_not_admitted');
  expect(refusal({ all: [{ facet: 'contributor', all: [id(1), id(2)] }] })).toBe('operator_not_admitted');
  expect(refusal({ all: [{ facet: 'type', any: ['https://schema.org/Book'], none: ['https://schema.org/Recipe'] }] }))
    .toBe('invalid_filter');
  expect(refusal({ all: [{ facet: 'language', any: ['English'] }] })).toBe('invalid_value');
  expect(refusal({ all: [{ facet: 'rating', bind: { ratingContext: id(6) }, range: { min: '11' } }] })).toBe('invalid_value');
  expect(refusal({ all: [{ facet: 'rating', bind: { ratingContext: id(6) }, range: { min: '8', max: '7' } }] }))
    .toBe('invalid_value');
  expect(refusal({ all: [{ facet: 'author', any: [{ provider: 'wikidata', namespace: 'author', key: 'Q1' }] }] }))
    .toBe('invalid_value');
  expect(refusal({ all: [{ facet: 'type', any: ['https://schema.org/Book', 'https://schema.org/Book'] }] }))
    .toBe('invalid_value');
  expect(refusal({ all: [{ facet: 'rating', range: { min: '7' } }] })).toBe('invalid_binding');
  expect(refusal({ all: [{ facet: 'type', bind: { ratingContext: id(6) }, any: ['https://schema.org/Book'] }] }))
    .toBe('invalid_binding');
  expect(refusal({ all: [{ facet: 'type', any: ['https://schema.org/Book'], interpretation: { definition: id(4) } }] }))
    .toBe('qualifier_not_admitted');
  expect(refusal({ all: [{ facet: 'concept', any: [id(3)], applicability: [id(9)] }] })).toBe('qualifier_not_admitted');
  expect(refusal({ all: [] })).toBe('invalid_filter');
  expect(refusal({ not: [{ facet: 'type', any: ['https://schema.org/Book'] }] })).toBe('invalid_filter');
  expect(refusal({ all: [{ facet: 'type', any: ['https://schema.org/Book'], sense: id(3) }] })).toBe('invalid_filter');
});

test('Facets: admission bounds a Filter before any graph read', () => {
  const type = { facet: 'type', any: ['https://schema.org/Book'] };
  expect(refusal({ all: Array.from({ length: FILTER_LIMITS.nodes + 1 }, () => type) })).toBe('filter_too_large');
  let nested: FilterGroup = { all: [type] };
  for (let depth = 1; depth < FILTER_LIMITS.depth; depth++) nested = { any: [nested] };
  expect(refusal(nested)).toBeNull();
  expect(refusal({ all: [nested] })).toBe('filter_too_large');
  expect(refusal({ all: [appearance({ all: Array.from({ length: 5 }, (_, n) => gender([id(20 + n)])) })] }))
    .toBe('filter_too_large');
  expect(refusal({ all: [{ facet: 'type', any: Array.from({ length: 17 }, (_, n) => `https://schema.org/T${n}`) }] }))
    .toBe('invalid_value');
});
