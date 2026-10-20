import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import type { ResourceQuery } from '../../../model/definitions/filter-document-v1.ts';
import { facetList, facetQueryShape } from '../src/modules/facets/contract.ts';
import { facetListBody, facetListTag, resolveFacet } from '../src/modules/facets/registry.ts';
import { RELEASE_QUERY_COST } from '../src/modules/facets/release-contract.ts';
import { releaseGroupPattern } from '../src/modules/facets/release-query.ts';
import { compileQuery, QueryRejected } from '../src/modules/query/compile.ts';

const list: Static<typeof facetList> = JSON.parse(facetListBody);
const shape = list.queryShapes!.find(item => item.id === 'release-works-v1')!;
const query: ResourceQuery = { context: 'global', scope: { kind: 'all' }, sort: 'newest',
  page: { size: RELEASE_QUERY_COST.pageSize }, filter: { all: [{ facet: 'release', where: { all: [
    { facet: 'releaseLanguage', any: ['en'] }, { facet: 'releaseCompleteness', any: ['complete'] },
    { facet: 'releasePlatform', any: ['Windows'] }, { facet: 'releaseStatus', any: ['official'] },
    { facet: 'releaseTranslator', any: ['https://rezics.com/id/00000000-0000-4000-8000-000000000123'] },
  ] } }] } };

test('Facet discovery retains admitted definitions and describes the real filter-document request and continuation bounds', () => {
  expect(Value.Check(facetList, list)).toBe(true);
  expect(list.queryShapes).toBeArray();
  const { queryShapes: _shapes, ...legacyList } = list;
  expect(Value.Check(facetList, legacyList)).toBe(true);
  expect(facetListTag).toBe(`"${list.digest}"`);
  expect(shape).toMatchObject({ id: 'release-works-v1', method: 'POST', href: '/v1/query',
    requestProfile: 'filter-document-v1', maxPageSize: RELEASE_QUERY_COST.pageSize,
    continuation: { request: 'page.continuation', response: 'result.nextCursor' } });
  for (const name of ['release', 'releaseLanguage', 'releasePlatform', 'releaseStatus', 'releaseCompleteness', 'releaseTranslator']) {
    const facet = resolveFacet(name)!;
    expect(facet.current).toBe(true);
    expect(list.facets).toContainEqual(facet);
    expect(shape.facets).toContain(facet.id);
  }
  // requestProfile describes the protocol; filter-document-v1 has no profile field.
  expect(query).not.toHaveProperty('profile');
  const compiled = compileQuery(query);
  expect(compiled.template).toBe('release-works');
  if (compiled.template !== 'release-works') throw new Error('Expected existing release query owner');
  expect(compiled.request.limit).toBe(shape.maxPageSize);
  expect(compiled.facets).toEqual(expect.arrayContaining(shape.facets));
  const continued = compileQuery({ ...query, page: { size: 2, continuation: 'opaque-server-cursor' } });
  expect(continued).toMatchObject({ template: 'release-works', request: { limit: 2, cursor: 'opaque-server-cursor' } });
  expect(() => compileQuery({ ...query, page: { size: shape.maxPageSize + 1 } })).toThrow(QueryRejected);
  expect(() => compileQuery({ ...query, filter: { all: [{ facet: 'releaseLanguage', any: ['en'] }] } })).toThrow(QueryRejected);
});

test('Ready release discovery composes the installed exact-revision translator planner and preserves explicit unsupported states', () => {
  expect(shape.state).toBe('ready');
  expect(shape).not.toHaveProperty('refusal');
  const compiled = compileQuery(query);
  if (compiled.template !== 'release-works') throw new Error('Expected installed release query owner');
  const pattern = releaseGroupPattern(compiled.request.groups[0]!, '?release', 'navigation');
  expect(pattern).toContain('?coveragenavigation rv:realization ?textnavigation_4 ; rv:revision ?textRevisionnavigation_4');
  expect(pattern).toContain('rv:realizationTranslators(?textStatenavigation_4, ?textnavigation_4, ?work)');
  expect(pattern).not.toContain('?textnavigation_4 rv:head');
  expect(Value.Check(facetQueryShape, { ...shape, state: 'unsupported' })).toBe(false);
  expect(Value.Check(facetQueryShape, { ...shape, state: 'unsupported', refusal: 'Execution owner unavailable' })).toBe(true);
  expect(Value.Check(facetQueryShape, { ...shape, refusal: 'Execution owner unavailable' })).toBe(false);
  expect(Value.Check(facetQueryShape, { ...shape, profile: 'filter-document-v1' })).toBe(false);
});
