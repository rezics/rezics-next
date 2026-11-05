import { expect, test } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import { searchFilterWithScope } from '../src/search/advanced-scope';
import { discoveryRequest } from '../src/search/search-request';
import { searchLoaderDeps } from '../src/search/search-params';
import { refinementHref } from '../src/search/refinement/model';
import {
  canonicalLanguageTag,
  canonicalResourceLanguageValues,
  RESOURCE_LANGUAGE_PROPERTY,
  RESOURCE_LANGUAGE_SELECTION_LIMIT,
  resourceLanguageRefinement,
  withoutResourceLanguageSelection,
} from '../src/search/language-refinement';
import type { RefinementProperty } from '../src/search/refinement/model';
import type { FacetState } from '../src/search/refinement/request';

const languageProperty: RefinementProperty = {
  property: RESOURCE_LANGUAGE_PROPERTY,
  labels: { en: 'Language' },
  mode: 'values',
  datatype: 'string',
  units: [],
};
const as_of = '2026-11-03T00:00:00.000Z';
const scope = { kind: 'realm' as const, id: '00000000-0000-4000-8000-000000000001' };
const ratingPopulation = '00000000-0000-4000-8000-000000000002';
const languages = ['ja', 'zh-Hant', 'pt-BR', 'es-419'];

function record(params: URLSearchParams) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const current = result[key];
    result[key] = current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value];
  }
  return result;
}

test('resource languages canonicalize, round-trip as one OR filter and leave the Boolean tree and other state intact', () => {
  expect(canonicalLanguageTag('zh-hant')).toBe('zh-Hant');
  expect(canonicalLanguageTag('pt-br')).toBe('pt-BR');
  expect(canonicalLanguageTag('x-private')).toBeUndefined();
  expect(canonicalResourceLanguageValues(['PT-br', 'pt-BR', 'ja', 'es-419', 'bad code'])).toEqual([
    'pt-BR',
    'ja',
    'es-419',
    'bad code',
  ]);
  expect(searchLoaderDeps({ 'f.schema:inLanguage': ['PT-br', 'bad code'] }).facets[RESOURCE_LANGUAGE_PROPERTY]).toEqual(
    ['pt-BR', 'bad code'],
  );
  expect(RESOURCE_LANGUAGE_SELECTION_LIMIT).toBe(64);

  const condition: FilterDocument = {
    and: [
      { not: { statement: { property: RESOURCE_LANGUAGE_PROPERTY, in: ['de'] } } },
      { or: [{ statement: { property: 'schema:genre', in: ['mystery'] } }, { type: { in: ['schema:Book'] } }] },
    ],
  };
  const href = refinementHref(
    'en',
    'Mira',
    {
      type: 'schema:Book',
      facetValues: { [RESOURCE_LANGUAGE_PROPERTY]: languages, 'schema:genre': ['mystery'] },
      languages: ['en', 'fr'],
      kinds: ['article', 'video'],
      condition,
      filter: searchFilterWithScope(undefined, scope),
      resourceScope: scope,
      ratingPopulation,
    },
    'rating',
  );
  const roundTrip = searchLoaderDeps(record(new URL(href, 'https://search.test').searchParams));
  expect(roundTrip.facets[RESOURCE_LANGUAGE_PROPERTY]).toEqual(languages);
  expect(roundTrip.type).toBe('schema:Book');
  expect(roundTrip.kinds).toEqual(['article', 'video']);
  expect(roundTrip.languages).toEqual(['en', 'fr']);
  expect(roundTrip.resourceScope).toEqual(scope);
  expect(roundTrip.ratingPopulation).toBe(ratingPopulation);
  expect(roundTrip.sort).toBe('rating');
  expect(roundTrip.condition).toEqual(condition);
  expect(roundTrip.cursor).toBeUndefined();

  const request = discoveryRequest(roundTrip, ['ja']);
  const clauses = (request.filter as { and: FilterDocument[] }).and;
  expect(clauses).toContainEqual(condition);
  expect(clauses).toContainEqual({ statement: { property: RESOURCE_LANGUAGE_PROPERTY, in: languages } });
  expect(clauses).toContainEqual({ type: { in: ['schema:Book'] } });
  expect(clauses).toContainEqual({ kind: { in: ['article', 'video'] } });
  expect(request.languages).toEqual(['en', 'fr']);

  const optionContext = withoutResourceLanguageSelection(roundTrip);
  expect(optionContext.facets).not.toHaveProperty(RESOURCE_LANGUAGE_PROPERTY);
  expect(optionContext.facets['schema:genre']).toEqual(['mystery']);
  expect(optionContext.condition).toEqual(condition);
  expect(optionContext.resourceScope).toEqual(scope);
  const optionClauses = (discoveryRequest(optionContext, ['ja']).filter as { and: FilterDocument[] }).and;
  expect(optionClauses).toContainEqual(condition);
  expect(optionClauses).not.toContainEqual({ statement: { property: RESOURCE_LANGUAGE_PROPERTY, in: languages } });
});

test('bounded count-free facet state keeps absent and malformed selections removable across honest readiness states', () => {
  const values = [
    ...languages.map((value) => ({ value, labels: { en: value, ja: `label:${value}` } })),
    ...['de', 'fr', 'ko', 'en', 'it', 'ar', 'ru', 'hi'].map((value) => ({ value, labels: { en: value } })),
  ];
  const ready: FacetState = {
    status: 'ready',
    page: { as_of, facets: [{ property: RESOURCE_LANGUAGE_PROPERTY, values, next: 'opaque-next' }] },
  };
  const model = resourceLanguageRefinement([languageProperty], ['PT-br', 'pt-BR', 'de-CH', 'bad code'], ready);
  expect(model).toMatchObject({
    applicability: 'applicable',
    readiness: 'ready',
    asOf: as_of,
    actions: { select: true, remove: true, clear: true, continue: true, retry: false },
  });
  expect(model.options).toHaveLength(12);
  expect(model.selected).toEqual([
    { value: 'pt-BR', canonical: 'pt-BR', present: true, needsRepair: false },
    { value: 'de-CH', canonical: 'de-CH', present: false, needsRepair: false },
    { value: 'bad code', canonical: undefined, present: false, needsRepair: true },
  ]);
  expect(model.options.find((entry) => entry.value === 'pt-BR')).toMatchObject({
    selected: true,
    current: true,
    needsRepair: false,
  });
  expect(model.options.find((entry) => entry.value === 'bad code')).toMatchObject({
    selected: true,
    current: false,
    needsRepair: true,
  });
  expect(JSON.stringify(model)).not.toMatch(/"(?:count|total)"/);

  const partial = resourceLanguageRefinement([languageProperty], ['ja'], ready, true, 'partial');
  expect(partial).toMatchObject({
    applicability: 'partial',
    readiness: 'ready',
    actions: { select: true, continue: true },
  });

  for (const status of ['preparing', 'unavailable', 'invalid', 'restart', 'refused', 'withheld'] as const) {
    const failed = resourceLanguageRefinement([languageProperty], ['ja'], { status });
    expect(failed.readiness).toBe(status);
    expect(failed.actions.select).toBe(false);
    expect(failed.actions.remove).toBe(true);
    expect(failed.actions.retry).toBe(['preparing', 'unavailable', 'invalid', 'restart'].includes(status));
  }
  const missing = resourceLanguageRefinement([], ['ja'], { status: 'refused' });
  expect(missing).toMatchObject({
    applicability: 'not-applicable',
    readiness: 'not-applicable',
    actions: { select: false, remove: true, clear: true, continue: false, retry: false },
  });
  expect(resourceLanguageRefinement([], ['ja'], { status: 'unavailable' }, false)).toMatchObject({
    applicability: 'unknown',
    readiness: 'unavailable',
    actions: { select: false, remove: true, clear: true, continue: false, retry: true },
  });
});
