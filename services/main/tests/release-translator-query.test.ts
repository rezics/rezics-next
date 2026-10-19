import { expect, test } from 'bun:test';
import type { FilterCondition, ResourceQuery } from '../../../model/definitions/filter-document-v1.ts';
import { compileFacet } from '../../../model/compiler/facet.ts';
import { releaseTranslatorFacet } from '../../../model/definitions/facet-release-translator-v1.ts';
import { compileQuery } from '../src/modules/query/compile.ts';
import { InvalidFilter, checkedFilter } from '../src/modules/facets/schema.ts';
import { releaseGroupPattern } from '../src/modules/facets/release-query.ts';
import { resolveFacet } from '../src/modules/facets/registry.ts';
import { admitSavedFilter } from '../src/modules/saved-filter/admit.ts';
import { RELEASE_QUERY_COST } from '../src/modules/facets/release-contract.ts';
import { queryRoutes, resourceQueryV1 } from '../src/routes/query.ts';
import { Value } from 'typebox/value';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const translator: FilterCondition = { facet: 'releaseTranslator',any: [id(1)] };
const release: FilterCondition = { facet: 'release',where: { all: [
  { facet: 'releaseLanguage',any: ['en'] },{ facet: 'releasePlatform',any: ['Windows'] },
  { facet: 'releaseStatus',any: ['official'] },{ facet: 'releaseCompleteness',any: ['complete'] },translator,
] } };
const query: ResourceQuery = { context: 'global',scope: { kind: 'all' },sort: 'newest',
  filter: { all: [release] },page: { size: 2,continuation: 'sealed-owner-frontier' } };

test('releaseTranslator is an executable child of the existing release FilterDocument and saved pins', () => {
  const compiled = compileQuery(query);
  expect(compiled.template).toBe('release-works');
  if (compiled.template !== 'release-works') throw new Error('Expected release template');
  expect(compiled.request.cursor).toBe('sealed-owner-frontier');
  expect(compiled.request.limit).toBe(2);
  expect(compiled.facets).toContain(resolveFacet('releaseTranslator')!.id);
  expect(resolveFacet('releaseTranslator')).toMatchObject({ ...compileFacet(releaseTranslatorFacet),
    within: resolveFacet('release')!.id });
  const saved = admitSavedFilter(query.filter);
  expect(compileQuery({ ...query,filter: saved.document }).template).toBe('release-works');
  expect(JSON.stringify(saved.document)).toContain('facet-release-translator-v1');
  expect(RELEASE_QUERY_COST).toMatchObject({ candidateRows: 64,explanationRows: 9,matchedReleases: 8,groups: 3 });
});

test('translator belongs to the same Work coverage entry, immutable revision and release as the other children', () => {
  const pattern = releaseGroupPattern(release,'?release','selected');
  expect(pattern).toContain('?coverageselected <https://rezics.com/vocab/work> ?work');
  expect(pattern).toContain('?coverageselected <https://rezics.com/vocab/contentLanguage>');
  expect(pattern).toContain('?coverageselected <https://rezics.com/vocab/completeness>');
  expect(pattern).toContain('?coverageselected rv:realization ?textselected_4 ; rv:revision ?textRevisionselected_4');
  expect(pattern).toContain('?textRevisionselected_4 a rv:RealizationRevision ; rv:component ?textselected_4');
  expect(pattern).toContain('rv:realizationTranslators(?textStateselected_4, ?textselected_4, ?work)');
  expect(pattern).not.toContain('?textselected_4 rv:head');
  expect(pattern).toContain('?textselected_4 rv:protectionHead');
  expect(pattern).toContain('?textRevisionselected_4 a rv:ErasedRevision');
  expect(pattern.match(/&& false/g)).toHaveLength(2); // No translator inference for frozen aggregate v1/v2 coverage.
});

test('any/all/none stay inside a known exact realization; resource and foreign-group placement refuse', () => {
  for (const operator of ['any','all','none'] as const) {
    const condition: FilterCondition = { facet: 'release',where: { all: [
      { facet: 'releaseTranslator',[operator]: [id(1),id(2)] },
    ] } };
    expect(compileQuery({ ...query,filter: { all: [condition] } }).template).toBe('release-works');
    const pattern = releaseGroupPattern(condition,'?release','test');
    expect(pattern).toContain('BOUND(?translatorstest_0)');
    expect(pattern).toContain(operator === 'all' ? ' && CONTAINS' : ' || CONTAINS');
    if (operator === 'none') expect(pattern).toContain('&& !(');
  }
  expect(() => checkedFilter({ all: [translator] })).toThrow(InvalidFilter);
  expect(() => checkedFilter({ all: [{ facet: 'relation',bind: { definition: id(2),role: id(3) },
    where: { all: [translator] } }] })).toThrow(InvalidFilter);
  expect(Value.Check(resourceQueryV1,{ ...query,profile: 'filter-document-v1' })).toBe(false);
});

test('a resource-scope translator returns typed HTTP 422 before owner reads', async () => {
  const response = await queryRoutes({} as never,{} as never).handle(new Request('http://main.local/v1/query',{
    method: 'POST',headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...query,filter: { all: [translator] } }),
  }));
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: 'invalid_query',status: 422,
    title: 'misplaced_facet: releaseTranslator needs an occurrence' });
});
