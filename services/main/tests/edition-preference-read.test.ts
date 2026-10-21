import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createMainApp } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { EditionPreferenceStore } from '../src/modules/session/preference-store.ts';
import type { EditionChoice } from '../src/modules/session/preference-contract.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const work = id(1), actor = id(2), main = id(3), head = id(4);
const principal = { issuer: 'https://account.test', subject: 'reader' };
const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });

/** The graph answers are the existing Work facade owner's bounded fixture.
 * The route, Work basis/session fences and SQL preference reader remain real. */
function fixture(choice: EditionChoice | null = null, options: { revokeAfterRead?: boolean } = {}) {
  const state = { graphQueries: [] as string[], sql: [] as { text: string; values: unknown[] }[],
    verifies: 0, recoveryFences: 0, ownChecks: [] as string[], active: true };
  class Graph extends FusekiClient {
    override async commandHealth() {
      return { moduleVersion: 'fixture', instanceId: 'fixture', publicSearchWriteEpoch: '0',
        publicSearchWriteActive: false, profiles: { 'work-metadata-v1': 'metadata-profile' } };
    }
    override async query(query: string): Promise<SparqlResult> {
      state.graphQueries.push(query);
      if (query.includes('SELECT ?resource ?head WHERE')) {
        const resources = [...query.matchAll(/VALUES \?resource \{([^}]+)\}/g)].flatMap(match =>
          [...match[1]!.matchAll(/<([^>]+)>/g)].map(value => value[1]!));
        return { results: { bindings: resources.map(resource => ({ resource: uri(resource), head: uri(head) })) } };
      }
      if (query.includes('SELECT ?epoch ?sequence WHERE')) return { results: { bindings: [
        { epoch: literal('epoch'), sequence: literal('12') },
      ] } };
      if (query.includes('SELECT ?head ?main ?mainHead ?metadataHead ?publicationHead')) return { results: { bindings: [
        { head: uri(head), main: uri(main), mainHead: uri(id(5)), public: literal('true') },
      ] } };
      if (query.includes('SELECT ?structuredDecision ?structuredSource') || query.includes('SELECT ?selection ?language')) {
        return { results: { bindings: [] } };
      }
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r ?type ?work ?head')) return { results: { bindings: [
        { epoch: literal('epoch'), sequence: literal('12'), r: uri(work), type: literal('work'),
          work: uri(work), head: uri(head), public: literal('true'), label: { ...literal('Book'), 'xml:lang': 'en' } },
      ] } };
      if (query.includes('SELECT ?work ?head ?nameOwner') || query.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
        return { results: { bindings: [{ work: uri(work), head: uri(head), owningWork: uri(work), owningHead: uri(head) }] } };
      }
      throw new Error(`Unrecognized edition preference fixture query: ${query}`);
    }
  }
  const graph = new Graph('http://edition-preference-fixture.invalid');
  const pool = { query: async (text: string, values: unknown[]) => {
    state.sql.push({ text, values });
    if (!text.includes('FROM reader.edition_preference')) throw new Error('Unexpected preference SQL');
    if (options.revokeAfterRead) state.active = false;
    return { rows: choice ? [{ work, choice, version: '7' }] : [] };
  } } as unknown as Pool;
  const deps = {
    environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
      objectDirectory: '.temp/edition-preference-unused' },
    account: { verify: async (request: Request) => {
      state.verifies++;
      if (!request.headers.has('authorization')) throw new AccountAssertionDenied('Authentication is required');
      return principal;
    } },
    access: {
      assertRecoveryOpen: async () => { state.recoveryFences++; },
      activePrincipalId: async () => state.active ? actor : null,
      canReadAsBaselineMember: async (_principal: unknown, subject: string) => {
        state.ownChecks.push(subject); return subject === actor;
      },
      canReadWork: async (_principal: unknown, subject: string, resource: string) => subject === actor && resource === work,
    },
    editionPreferences: new EditionPreferenceStore(pool),
  } as unknown as MainWorkDependencies;
  const app = createMainApp(graph, deps);
  configureDisclosure(deps.environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  configureFixtureDisclosureAncestry(deps.environment, target => target.work ? { resource: target.work, head,
    ...(target.workRevision !== undefined ? { protectedRevision: target.workRevision } : {}) } : undefined);
  const get = (subject: string | null = actor, authenticated = true, extra = '') => {
    const query = new URLSearchParams(subject === null ? {} : { actingSubject: subject });
    return app.handle(new Request(`http://main.test/v1/me/edition-preferences/${work.slice(-36)}?${query}${extra}`, {
      headers: authenticated ? { authorization: 'Bearer reader' } : {},
    }));
  };
  return { state, get };
}

for (const [label, choice] of [
  ['empty', null],
  ['saved language', { language: 'en', edition: null }],
  ['saved release without a language', { language: null, edition: { kind: 'release', resource: id(8), revision: id(9) } }],
] as const) test(`full Main preference GET reads ${label} through the real store and Work fences`, async () => {
  const f = fixture(choice), response = await f.get();
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(body).toEqual(choice ? { work, ...choice, version: 7 } : null);
  expect(f.state.sql).toHaveLength(1);
  expect(f.state.sql[0]!.values).toEqual([principal.issuer, principal.subject, actor, [work]]);
  expect(f.state.graphQueries.some(query => query.includes('SELECT ?head ?main ?mainHead ?metadataHead ?publicationHead'))).toBe(true);
  expect(f.state.graphQueries.filter(query => query.includes('SELECT ?epoch ?sequence WHERE')).length).toBeGreaterThanOrEqual(2);
  expect(f.state.recoveryFences).toBeGreaterThan(0);
  expect(f.state.ownChecks).toEqual([actor, actor]);
  expect(f.state.verifies).toBe(3);
});

test('full Main preference GET withholds the saved choice when the principal is revoked during its read', async () => {
  const f = fixture({ language: 'en', edition: null }, { revokeAfterRead: true });
  const response = await f.get();
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: 'account_assertion_denied' });
  expect(f.state.sql).toHaveLength(1);
  expect(f.state.graphQueries.some(query => query.includes('SELECT ?head ?main ?mainHead ?metadataHead ?publicationHead'))).toBe(true);
});

for (const [label, subject, extra] of [
  ['missing actingSubject', null, ''], ['invalid actingSubject', 'invalid', ''],
  ['undeclared query', actor, '&unsupported=true'],
] as const) test(`full Main preference GET classifies ${label} before owner reads`, async () => {
  const f = fixture(), response = await f.get(subject, true, extra);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'invalid_request' });
  expect(f.state.verifies).toBe(0);
  expect(f.state.sql).toEqual([]);
  expect(f.state.graphQueries).toEqual([]);
});

test('full Main preference GET authenticates and checks the own Person before graph or saved choices', async () => {
  const visitor = fixture(), unauthenticated = await visitor.get(actor, false);
  expect(unauthenticated.status).toBe(401);
  expect(await unauthenticated.json()).toMatchObject({ code: 'account_assertion_denied' });
  expect(visitor.state.sql).toEqual([]); expect(visitor.state.graphQueries).toEqual([]);
  const foreign = fixture(), denied = await foreign.get(id(90));
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ code: 'progress_denied' });
  expect(foreign.state.sql).toEqual([]); expect(foreign.state.graphQueries).toEqual([]);
});
