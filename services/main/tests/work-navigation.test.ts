import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import { AnswerRecordValidator, type AnswerContract } from '../../../scripts/api/answer-record.ts';
import { workHeaderNavigation } from '../src/modules/work/read-header.ts';
import { workHeader } from '../src/modules/work/read-contract.ts';
import { catalogueNavigation, navigationOperation } from '../src/modules/query/navigation-contract.ts';
import { template as versions } from '../src/modules/query/templates/work-versions.schema.ts';
import { template as adoptions } from '../src/modules/query/templates/work-adoptions.schema.ts';
import { TEMPLATE_COST } from '../src/modules/query/template-schema.ts';

const contract = new AnswerRecordValidator(JSON.parse(readFileSync('generated/openapi/main/public.json', 'utf8')) as AnswerContract);
const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000123';

test('Work navigation covers every legacy link and native releases and realizations with registered operations', () => {
  const { links, navigation } = workHeaderNavigation(work);
  expect(Object.keys(navigation)).toEqual(Object.keys(links));
  expect(Object.keys(navigation)).toHaveLength(10);
  expect(Value.Check(catalogueNavigation, navigation)).toBe(true);
  for (const [name, href] of Object.entries(links)) {
    const operation = navigation[name as keyof typeof navigation];
    expect(contract.operationId(operation.method, operation.href)).toBe(operation.operationId);
    expect(operation.href).not.toMatch(/[#{}]/);
    if (href.includes('#')) {
      expect(operation.kind).toBe('query');
      if (operation.kind !== 'query') throw new Error('Query anchor requires a POST operation');
      expect<string>(operation.request.query).toBe(`https://rezics.com/query/${href.split('#')[1]}`);
      expect(operation.request.parameters.roots).toEqual([work]);
      const template = operation.request.query === versions.query ? versions : adoptions;
      expect(Value.Check(template.request, operation.request)).toBe(true);
      expect(operation.request.limit).toBe(TEMPLATE_COST.page);
      expect(operation.responseProfile).toBe('query-v1');
    } else {
      expect(operation).toMatchObject({ kind: 'resource', method: 'GET', href });
      expect(operation).not.toHaveProperty('request');
      expect(href).toContain(work.slice(-36));
    }
  }
  expect(navigation.ratings).toMatchObject({ href: `/v1/resources/${work.slice(-36)}/ratings`,
    operationId: 'getV1ResourcesByResourceRatings', responseProfile: 'work-rating-read-v1' });
  expect(navigation.credits.responseProfile).toBe('template-result-v1');
  for (const name of ['classifications', 'history', 'metadata', 'editions', 'releases', 'realizations'] as const)
    expect(navigation[name].responseProfile).toBeNull();
});

test('Navigation schema refuses query anchors as GET targets and preserves exact native Work request admission', () => {
  const { navigation } = workHeaderNavigation(work);
  expect(Value.Check(navigationOperation, { ...navigation.ratings, href: '/v1/query#work-versions' })).toBe(false);
  expect(Value.Check(navigationOperation, { ...navigation.versions, method: 'GET' })).toBe(false);
  expect(Value.Check(navigationOperation, { ...navigation.versions,
    request: { ...navigation.versions.request, revision: 2 } })).toBe(false);
  expect(Value.Check(navigationOperation, { ...navigation.versions,
    request: { ...navigation.versions.request, parameters: { roots: ['provider:external-work'] } } })).toBe(false);
  expect(Value.Check(navigationOperation, { ...navigation.versions,
    request: { ...navigation.versions.request, converter: 'provider-mapper' } })).toBe(false);
  const other = 'https://rezics.com/id/00000000-0000-4000-8000-000000000456';
  expect(workHeaderNavigation(other).navigation.versions.request.parameters.roots).toEqual([other]);
  expect(navigation.versions.request.parameters.roots).toEqual([work]);
});

test('The published Work header schema admits the emitted navigation and preserves legacy optional fields', () => {
  const header = { profile: 'work-read-v1', id: work, revision: work, mainVersion: work,
    title: { value: 'Work', language: 'en', direction: 'ltr', basis: 'requested' },
    cover: { kind: 'fallback', policy: 'default', key: work, resourceType: 'work' },
    types: [], tagline: null, completionStatus: null, chapterCount: null, wordCount: null, lastUpdatedAt: null,
    disclosure: 'public', publicationState: 'unpublished', originalTitle: null, metadataRevision: null,
    description: null, descriptionObligations: { status: 'unassessed' }, mainVersionRevision: work,
    mainVersionLabel: null, selectedLanguage: null, sourcePosition: { dataEpoch: 'epoch', sequence: '1' },
    ...workHeaderNavigation(work),
  } satisfies Static<typeof workHeader>;
  expect(Value.Check(workHeader, header)).toBe(true);
  const legacy: Static<typeof workHeader> = { ...header, links: { ...header.links } };
  delete legacy.navigation;
  delete legacy.links.releases;
  delete legacy.links.realizations;
  expect(Value.Check(workHeader, legacy)).toBe(true);
  expect(Value.Check(workHeader, { ...header, navigation: { ...header.navigation,
    versions: { ...header.navigation.versions, method: 'GET' } } })).toBe(false);
});
