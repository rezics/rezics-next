import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AnswerRecordValidator, type AnswerContract } from '../../../scripts/api/answer-record.ts';
import { personaNames, type PersonaSession } from '../support/personas.ts';
import { assertNoHidden, jsonAnswer, openReleaseMediaFixture, pagePath, releaseQuery, workPath,
  type BusinessPage, type NavigationOperation } from './support/catalogue-release-media.ts';

setDefaultTimeout(180_000);
let prepared: Awaited<ReturnType<typeof openReleaseMediaFixture>>;
let contract: AnswerRecordValidator;
beforeAll(async () => {
  prepared = await openReleaseMediaFixture();
  contract = new AnswerRecordValidator(JSON.parse(readFileSync('generated/openapi/main/public.json', 'utf8')) as AnswerContract);
});
afterAll(async () => { if (prepared) await prepared.sessions.close(); });

interface Header {
  id: string; links: Record<string, string>;
  navigation: Record<string, NavigationOperation>;
}
interface QueryShape {
  id: string; state: 'ready' | 'unsupported'; facets: string[];
  method: 'POST'; href: '/v1/query'; requestProfile: 'filter-document-v1';
  maxPageSize: number; refusal?: string;
}
interface FacetDiscovery {
  profile: 'facets-v1';
  facets: Array<{ id: string; name: string; current: boolean; within?: string }>;
  /** Definition currency is separate from a query shape's actual executability. */
  queryShapes: QueryShape[];
}

async function follow(person: PersonaSession, operation: NavigationOperation): Promise<Record<string, unknown>> {
  expect(operation.href).toMatch(/^\/v1\//);
  expect(operation.href).not.toMatch(/[#{}]/); // A discovery anchor is not a concrete HTTP target.
  expect(operation.operationId).toBe(contract.operationId(operation.method, operation.href));
  let response: Response;
  if (operation.kind === 'resource') {
    expect(operation.method).toBe('GET');
    expect(operation).not.toHaveProperty('request');
    response = await person.main(operation.method, operation.href);
  } else {
    expect(operation.kind).toBe('query');
    expect(operation.method).toBe('POST');
    expect(operation.href).toBe('/v1/query');
    expect(operation.operationId).toBe('postV1Query');
    expect(operation.request).toBeObject();
    response = await person.main(operation.method, operation.href, operation.request);
  }
  const answer = await jsonAnswer<Record<string, unknown>>(Promise.resolve(response));
  if (operation.responseProfile !== null) expect(answer.profile).toBe(operation.responseProfile);
  expect(contract.responseViolations({ label: 'discovered-operation', operationId: operation.operationId,
    method: operation.method, path: operation.href, status: response.status,
    ...(operation.kind === 'query' ? { body: operation.request } : {}), answer,
    headers: Object.fromEntries(response.headers.entries()) })).toEqual([]);
  assertNoHidden(answer, prepared.fixture);
  return answer;
}

async function headerNavigation(person: PersonaSession, work: string) {
  const header = await jsonAnswer<Header>(person.main('GET', workPath(work)));
  expect(header.id).toBe(work);
  expect(header.navigation).toBeObject();
  expect(Object.keys(header.navigation)).toEqual(expect.arrayContaining([
    'versions', 'classifications', 'adoptions', 'ratings', 'history', 'credits', 'metadata', 'editions', 'releases', 'realizations',
  ]));
  for (const [name, href] of Object.entries(header.links)) {
    const operation = header.navigation[name];
    expect(operation, `every advertised legacy link has a typed operation: ${name}`).toBeDefined();
    if (href.includes('#')) {
      const [path, anchor] = href.split('#');
      expect(path).toBe('/v1/query');
      expect(operation!.kind).toBe('query');
      if (operation!.kind !== 'query') throw new Error(`${name} is a POST query discovery anchor`);
      expect(operation!.request).toMatchObject({ profile: 'template-query-v1',
        query: `https://rezics.com/query/${anchor}`, revision: 1, parameters: { roots: [work] } });
    } else {
      expect(operation).toMatchObject({ kind: 'resource', method: 'GET', href });
      // Execute exactly what was advertised; never repair a known broken ratings path in the test.
      await jsonAnswer(person.main('GET', href));
    }
  }
  expect(header.navigation.ratings).toMatchObject({ kind: 'resource', method: 'GET', href: `/v1/resources/${work.slice(-36)}/ratings` });
  for (const operation of Object.values(header.navigation)) await follow(person, operation);
  assertNoHidden(header, prepared.fixture);
}

async function pageNavigation(person: PersonaSession, resource: string) {
  const page = await jsonAnswer<BusinessPage>(person.main('GET', pagePath(resource)));
  expect(page.navigation).toBeObject();
  for (const section of page.sections) {
    const operation = page.navigation[section.id];
    expect(operation, `section ${section.id} must be executable`).toBeDefined();
    if (!section.href.includes('#')) expect(operation).toMatchObject({ kind: 'resource', href: section.href });
  }
  for (const operation of Object.values(page.navigation)) await follow(person, operation);
  assertNoHidden(page, prepared.fixture);
}

async function executableFacets(person: PersonaSession) {
  const discovery = await jsonAnswer<FacetDiscovery>(person.main('GET', '/v1/facets'));
  expect(discovery.profile).toBe('facets-v1');
  const names = ['release', 'releaseLanguage', 'releasePlatform', 'releaseStatus', 'releaseCompleteness', 'releaseTranslator'];
  for (const name of names) expect(discovery.facets).toContainEqual(expect.objectContaining({ name, current: true }));
  expect(discovery.queryShapes).toBeArray();
  const shape = discovery.queryShapes.find(item => item.id === 'release-works-v1');
  expect(shape).toMatchObject({ state: 'ready', method: 'POST', href: '/v1/query', requestProfile: 'filter-document-v1' });
  expect(shape!.maxPageSize).toBeGreaterThanOrEqual(2);
  for (const name of names) {
    const facet = discovery.facets.find(item => item.name === name && item.current)!;
    expect(shape!.facets).toContain(facet.id); // Exact versions, not a client-side readiness guess.
  }
  for (const catalogue of prepared.fixture.catalogues) {
    const query = releaseQuery(catalogue.releases.map(release => release.id), catalogue.selection);
    const answer = await jsonAnswer<{ template: string; result: { items: Array<{ id: string; matchedReleases: string[] }> } }>(
      person.main(shape!.method, shape!.href, query));
    expect(answer.template).toBe('release-works-v1');
    expect(answer.result.items).toContainEqual(expect.objectContaining({ id: catalogue.work,
      matchedReleases: catalogue.matchingReleases }));
    assertNoHidden(answer, prepared.fixture);
    const invalid = { ...query, filter: { all: [{ facet: 'releaseTranslator', any: [catalogue.selection.translator] }] } };
    const refused = await jsonAnswer<{ code: string }>(person.main('POST', '/v1/query', invalid), 422);
    expect(refused.code).toBe('misplaced_facet'); // Must not turn an invalid scope into an empty success.
  }
  for (const unsupported of discovery.queryShapes.filter(item => item.state === 'unsupported')) {
    expect(unsupported.refusal).toBeTruthy();
  }
}

// Pending contract: run these ordinary failures alongside the six pending outcome cells.
for (const name of personaNames) test(`catalogue discovery navigation / ${name}: executes advertised methods, profiles and source-neutral query bounds`, async () => {
  const person = prepared.sessions[name];
  for (const catalogue of prepared.fixture.catalogues) await headerNavigation(person, catalogue.work);
  for (const resource of new Set(prepared.fixture.images.map(image => image.resource))) await pageNavigation(person, resource);
  await executableFacets(person);
});
