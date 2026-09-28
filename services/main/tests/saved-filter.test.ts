import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FilterDocument } from '../../../model/definitions/filter-document-v1.ts';
import { CONCEPT_FACET, conceptFilter } from '../src/modules/concept-page/contract.ts';
import { resolveFacet } from '../src/modules/facets/registry.ts';
import { QueryRejected } from '../src/modules/query/compile.ts';
import { admitSavedFilter, SavedFilterInvalid } from '../src/modules/saved-filter/admit.ts';
import { homeAvailable, homeFeedConditions } from '../src/modules/saved-filter/feed.ts';

const id = (n: number) => `https://rezics.com/id/019d0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ref = (name: string) => resolveFacet(name)!.id;
const refusal = (run: () => unknown) => {
  try { run(); } catch (error) {
    if (error instanceof QueryRejected || error instanceof SavedFilterInvalid) return error.refusal;
    throw error;
  }
  return null;
};

test('G-431: a Saved Filter keeps the exact Facet versions it was admitted as', () => {
  const admitted = admitSavedFilter({ all: [{ facet: 'concept', any: [id(1)] }, { facet: 'language', any: ['en', 'ja'] }] });
  expect(admitted.document).toEqual({ all: [{ facet: ref('concept'), any: [id(1)] },
    { facet: ref('language'), any: ['en', 'ja'] }] });
  expect(admitted.facets).toEqual([ref('concept'), ref('language')].sort());
  // An exact DefinitionRef stays as named.
  expect(admitSavedFilter(admitted.document).document).toEqual(admitted.document);
});

test('G-431: a Saved Filter needs a Condition, admitted Facets and the Query budget', () => {
  expect(refusal(() => admitSavedFilter({ all: [] }))).toBe('invalid_filter');
  expect(refusal(() => admitSavedFilter([]))).toBe('invalid_filter');
  expect(refusal(() => admitSavedFilter({ all: [{ facet: 'genre', any: [id(1)] }] }))).toBe('unknown_facet');
  expect(refusal(() => admitSavedFilter({ all: [{ facet: 'language', any: ['not a tag'] }] }))).toBe('invalid_value');
  const wide = { all: Array.from({ length: 33 }, (_, n) => ({ facet: 'concept', any: [id(n)] })) };
  expect(refusal(() => admitSavedFilter(wide))).toBe('filter_too_large');
});

test('G-431: following a Concept stores the same one-Condition Filter the Concept page lists', () => {
  const concept = id(7);
  expect(admitSavedFilter(conceptFilter(concept)).document).toEqual(conceptFilter(concept));
  const migration = readFileSync(join(import.meta.dir, '../migrations/access/840_saved_filter.sql'), 'utf8');
  // The trigger builds `{"all":[{"facet":<CONCEPT_FACET>,"any":[<concept>]}]}` with this exact DefinitionRef.
  expect(migration).toContain(`'facet', '${CONCEPT_FACET}', 'any', jsonb_build_array(concept)`);
  expect(migration.match(/https:\/\/rezics\.com\/definition\/facet-[a-z]+-v\d+/g)!.every(item => item === CONCEPT_FACET))
    .toBe(true);
});

test('G-431: Home executes Concept, language and community Conditions in full', () => {
  expect(homeFeedConditions(conceptFilter(id(1)) as FilterDocument)).toEqual({ concepts: [id(1)], languages: [], realms: [] });
  expect(homeFeedConditions({ all: [{ facet: ref('concept'), any: [id(1), id(2), id(3)] },
    { facet: 'language', any: ['zh-Hans'] }, { facet: 'realm', all: [id(9)] }] }))
    .toEqual({ concepts: [id(1), id(2), id(3)], languages: ['zh-Hans'], realms: [id(9)] });
});

test('G-431: a filter Home cannot show in full is a typed refusal, never an empty tab', () => {
  const cases: [FilterDocument, string][] = [
    [{ any: [{ facet: 'concept', any: [id(1)] }] }, 'unsupported_query_shape'],
    [{ all: [{ all: [{ facet: 'concept', any: [id(1)] }] }] }, 'unsupported_query_shape'],
    [{ all: [{ facet: 'concept', none: [id(1)] }] }, 'unsupported_query_shape'],
    [{ all: [{ facet: 'concept', all: [id(1), id(2)] }] }, 'unsupported_query_shape'],
    [{ all: [{ facet: 'concept', any: [id(1)] }, { facet: 'concept', any: [id(2)] }] }, 'unsupported_query_shape'],
    [{ all: [{ facet: 'concept', any: [id(1)], interpretation: { definition: id(2) } }] }, 'unsupported_query_shape'],
    [{ all: [{ facet: 'concept', any: ['urn:example:concept'] }] }, 'unsupported_query_shape'],
    [{ all: [{ facet: 'type', any: ['https://schema.org/Book'] }] }, 'unsupported_query_shape'],
    // The feed reads at most three Concepts; a Saved Filter cannot widen it.
    [{ all: [{ facet: 'concept', any: [id(1), id(2), id(3), id(4)] }] }, 'query_budget_exceeded'],
    [{ all: [] }, 'invalid_query'],
  ];
  for (const [document, expected] of cases) {
    expect(refusal(() => homeFeedConditions(document))).toBe(expected);
    expect(homeAvailable(document)).toBe(false);
  }
});
