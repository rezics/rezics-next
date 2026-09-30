import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import type { ResourceQuery, FilterCondition } from '../../../model/definitions/filter-document-v1.ts';
import { compileQuery, QueryRejected } from '../src/modules/query/compile.ts';
import { checkedFilter, InvalidFilter } from '../src/modules/facets/schema.ts';
import { facetDefinition } from '../src/modules/facets/contract.ts';
import { resolveFacet } from '../src/modules/facets/registry.ts';
import { releaseGroupPattern, releaseWorkConditions } from '../src/modules/facets/release-query.ts';
import { releaseWorksPage, RELEASE_QUERY_COST } from '../src/modules/facets/release-contract.ts';
import { admitSavedFilter } from '../src/modules/saved-filter/admit.ts';
import { fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { withReleaseQueryBudget } from '../src/modules/facets/release-read.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const children: FilterCondition[] = [
  { facet: 'releaseLanguage', any: ['en'] }, { facet: 'releasePlatform', any: ['Windows'] },
  { facet: 'releaseCompleteness', any: ['complete'] },
  { facet: 'releaseStatus', any: ['official', 'unofficial'] },
];
const group: FilterCondition = { facet: 'release', where: { all: children } };
const base: ResourceQuery = { context: 'global', scope: { kind: 'all' }, sort: 'newest',
  page: { size: 20 }, filter: { all: [group] } };
const compiled = () => {
  const result = compileQuery(base);
  if (result.template !== 'release-works') throw new Error('Wrong template');
  return result;
};

test('G851: release group compiles one bound node and includes every child in admission', () => {
  expect(compiled()).toMatchObject({ template: 'release-works', graphReads: 2, request: { groups: [group] } });
  expect(compiled().facets).toHaveLength(5);
  const pattern = releaseGroupPattern(group, '?oneRelease', 'group');
  for (const predicate of ['contentLanguage', 'platform', 'completeness', 'releaseStatus']) {
    expect(pattern).toContain(`?oneRelease <https://rezics.com/vocab/${predicate}>`);
  }
  expect(pattern).toContain('rv:work|rv:coverageWork|rv:coverage/rv:work ?coveredWork');
  expect(pattern).toContain('?coveragegroup <https://rezics.com/vocab/work> ?work');
  expect(pattern).toContain('?coveragegroup <https://rezics.com/vocab/contentLanguage>');
  expect(pattern).toContain('?coveragegroup <https://rezics.com/vocab/completeness>');
  expect(pattern).toContain('release-v1');
  expect(pattern).toContain('release-v2');
  expect(pattern).toContain('release-v3');
  expect(pattern).not.toContain('legacyRelease');
  expect(pattern).toContain('?covered_publicSelection');
  for (const facet of ['release', ...children.map(child => child.facet), 'releaseTerritory']) {
    expect(Value.Check(facetDefinition, resolveFacet(facet))).toBe(true);
  }
});

test('G851: release children belong only to their declared release group', () => {
  expect(() => checkedFilter({ all: [children[0]!] })).toThrow(InvalidFilter);
  const relation = { facet: 'relation', bind: { definition: id(1), role: id(2) },
    where: { all: [children[0]!] } };
  expect(() => checkedFilter({ all: [relation] })).toThrow(InvalidFilter);
  expect(() => checkedFilter({ all: [{ facet: 'release', where: { all: [
    { facet: 'statement', any: [id(1)], bind: { predicate: id(2), relationDefinition: id(3) } },
  ] } }] })).toThrow(InvalidFilter);
  expect(() => compileQuery({ ...base, filter: { all: [{ ...relation, where: { all: [
    { facet: 'role', any: [id(3)] },
  ] } }] } })).toThrow(QueryRejected);
});

test('G851: related dispatch follows the step kind and includes all declared target types', () => {
  const facet = resolveFacet('release')!;
  const related = facet.path.at(-1)!;
  if (related.kind !== 'related') throw new Error('Missing related step');
  const name = facet.name;
  try {
    facet.name = 'editionGroup';
    related.types.push('https://rezics.com/vocab/OtherRelease');
    expect(compiled().template).toBe('release-works');
    expect(releaseGroupPattern(group, '?release', 'types')).toContain(
      'VALUES ?releaseTypetypes { <https://rezics.com/vocab/Release> <https://rezics.com/vocab/OtherRelease> }');
  } finally { facet.name = name; related.types.pop(); }
});

test('G851: each moved read attempt gets a fresh release ledger while debiting the request ledger', async () => {
  const parent = { signal: AbortSignal.timeout(10_000), callsLeft: 160, bytesLeft: 4 * 1024 * 1024 };
  await fusekiReadBudget.run(parent, async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await withReleaseQueryBudget(async () => {
        const budget = fusekiReadBudget.getStore()!;
        expect(budget.callsLeft).toBe(RELEASE_QUERY_COST.graphCalls);
        for (let call = 0; call < RELEASE_QUERY_COST.graphCalls; call++) budget.callsLeft--;
        expect(budget.callsLeft).toBe(0);
        expect(budget.signal.aborted).toBe(false);
      });
    }
  });
  expect(parent.callsLeft).toBe(160 - 4 * RELEASE_QUERY_COST.graphCalls);
});

test('G851: Saved Filters pin and round-trip the whole release group through shared Query admission', () => {
  const saved = admitSavedFilter(base.filter);
  expect(saved.facets).toEqual(compiled().facets);
  expect(saved.document).toEqual({ all: [{ ...group, facet: resolveFacet('release')!.id,
    where: { all: children.map(child => ({ ...child, facet: resolveFacet(child.facet)!.id })) } }] });
  const result = compileQuery({ ...base, filter: JSON.parse(JSON.stringify(saved.document)) });
  expect(result.template).toBe('release-works');
  expect(result.facets).toEqual(saved.facets);
});

test('G851: nested all/any and value all/none retain boolean meaning on one release', () => {
  const condition: FilterCondition = { facet: resolveFacet('release')!.id, where: { all: [
    { any: [{ facet: 'releaseLanguage', all: ['en', 'th'] }, { facet: 'releasePlatform', none: ['Switch'] }] },
    { facet: 'releaseTerritory', any: ['TH', '001'] },
  ] } };
  expect(compileQuery({ ...base, filter: { all: [condition] } }).template).toBe('release-works');
  expect(releaseGroupPattern(condition, '?release', 'group')).toContain(' || ');
  expect(releaseGroupPattern(condition, '?release', 'group')).toContain('!EXISTS');
  expect(() => compileQuery({ ...base, filter: { all: [{ facet: 'release', where: { all:
    Array.from({ length: 9 }, () => children[0]!),
  } }] } })).toThrow('groups too many Conditions');
  expect(() => compileQuery({ ...base, filter: { all: [group, { ...group, any: [id(1)] },
    { ...group, any: [id(2)] }, { ...group, any: [id(3)] }] } })).toThrow('budget');
});

test('G851: resource Conditions stay on the Work, unsupported combinations refuse explicitly', () => {
  const query = compileQuery({ ...base, filter: { all: [group, { facet: 'language', any: ['ja'] },
    { facet: 'type', any: ['https://schema.org/Book'] }, { facet: 'status', none: ['hiatus'] }] } });
  if (query.template !== 'release-works') throw new Error('Wrong template');
  expect(releaseWorkConditions(query.request, '?selectedContribution')).toContain('?work <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>');
  expect(releaseWorkConditions(query.request, '?selectedContribution')).toContain('BIND(?selectedContribution AS ?languageContribution)');
  expect(() => compileQuery({ ...base, text: { phrase: 'story' }, sort: 'relevance' })).toThrow(QueryRejected);
  expect(() => compileQuery({ ...base, sort: 'updated' })).toThrow(QueryRejected);
  expect(() => compileQuery({ ...base, page: { size: 21 } })).toThrow('bound');
  expect(() => compileQuery({ ...base, page: { size: 20, continuation: {} } })).toThrow('wrong form');
  expect(() => compileQuery({ ...base, scope: { kind: 'realm', realm: id(1) } })).toThrow('Realm Context');
  expect(compileQuery({ ...base, scope: { kind: 'realm', realm: id(1) }, context: { realm: id(1) } }).template)
    .toBe('release-works');
  expect(releaseWorksPage.properties.items.items.properties.matchedReleases).toMatchObject({ maxItems: 8 });
  expect(Number(RELEASE_QUERY_COST.explanationRows)).toBe(Number(RELEASE_QUERY_COST.matchedReleases) + 1);
  expect(compileQuery({ context: 'global', scope: { kind: 'all' }, sort: 'relevance',
    text: { phrase: 'story' }, filter: { all: [{ facet: 'language', any: ['th'] }] }, page: { size: 20 } }))
    .toMatchObject({ template: 'search', request: { language: 'th' } });
});
