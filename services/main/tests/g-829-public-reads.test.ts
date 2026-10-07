import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import { canReadCompositionWork } from '../src/modules/composition/disclosure-read.ts';
import { readWorkWholes } from '../src/modules/composition/read.ts';
import { openApiOperations as lexiconOperations } from '../src/routes/lexicon.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const value = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

test('G-829: Work composition reads share public disclosure, preserve private grants and hide absent/protected Works', async () => {
  const work = id();
  let rows = [{ main: value(id()), public: value('true') }];
  let grants = 0, granted = false;
  const deps = { access: { canReadWork: async () => { grants++; return granted; } } } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.local/v1/works'), {},
    { dataEpoch: 'one', sequence: '1' });
  session.query = async query => {
    expect(query).toContain('rv:catalogueVisible true');
    expect(query).toContain('rv:PublicationSelection');
    expect(query).toContain('rv:protectionHead');
    expect(query).toContain('rv:ErasedRevision');
    return rows;
  };
  expect(await canReadCompositionWork(session, work)).toBe(true);
  expect(grants).toBe(0);
  rows[0]!.public = value('false');
  expect(await canReadCompositionWork(session, work)).toBe(false);
  session.principal = { issuer: 'account', subject: 'reader' } as never;
  session.options.actingSubject = id();
  expect(await canReadCompositionWork(session, work)).toBe(false);
  granted = true;
  expect(await canReadCompositionWork(session, work)).toBe(true);
  rows = [];
  expect(await canReadCompositionWork(session, work)).toBe(false);
});

test('G-829: wholes scan beyond a hidden batch and never expose trailing private occurrences or a cursor', async () => {
  const resource = id(), visible = id();
  const rows = Array.from({ length: 104 }, (_, index) => ({ whole: uri(index === 102 ? visible : id()),
    main: uri(id()), structure: uri(id()), occurrence: uri(id()), segment: value('01'), order: value('01') }));
  const revisions = new Map(rows.map(row => [row.whole.value, id()]));
  const graph = new FusekiClient('http://graph.invalid');
  const summaryBatches: string[][] = [], exactBatches: string[][] = [], hydrated: string[][] = [];
  let scans = 0, scalarProbes = 0, privateGrantProbes = 0;
  graph.query = async query => {
    let bindings: NonNullable<SparqlResult['results']>['bindings'];
    if (query.includes('SELECT ?main ?public')) {
      scalarProbes++;
      // Only the contained Work uses the scalar header proof. Candidate Works
      // must pass the actual summary and exact-head resolver below.
      expect(query).toContain(`<${resource}>`);
      bindings = [{ main: uri(id()), public: value('true') }];
    } else if (query.includes('SELECT ?whole ?main ?structure')) {
      expect(query).toContain('LIMIT 101');
      if (scans === 1) expect(query).toContain(`FILTER(?key > "${rows[100]!.whole.value}|${rows[100]!.occurrence.value}")`);
      bindings = scans++ === 0 ? rows.slice(0, 101) : rows.slice(101);
    } else {
      const resources = [...new Set([...query.matchAll(/VALUES \?r \{([^}]+)\}/g)].flatMap(match =>
        [...match[1]!.matchAll(/<([^>]+)>/g)].map(match => match[1]!)))];
      expect(resources.length).toBeGreaterThan(0);
      expect(resources.length).toBeLessThanOrEqual(64);
      if (query.includes('SELECT ?epoch ?sequence ?hold')) {
        summaryBatches.push(resources);
        bindings = resources.map(work => ({ epoch: value('one'), sequence: value('1'), r: uri(work),
          type: value('work'), work: uri(work), head: uri(revisions.get(work)!),
          public: value(String(work === visible)), erased: value('false'),
          label: { ...value(work === visible ? 'Visible whole' : 'Private whole'), 'xml:lang': 'en' } }));
      } else if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) {
        exactBatches.push(resources);
        expect(resources).toEqual([visible]);
        bindings = ['https://schema.org/CreativeWork', 'https://schema.org/Book'].map(type => ({
          epoch: value('one'), sequence: value('1'), r: uri(visible),
          revision: uri(revisions.get(visible)!), type: uri(type) }));
      } else throw new Error(`Unexpected wholes disclosure query: ${query}`);
    }
    return { results: { bindings } };
  };
  const deps = { environment: { fuseki: graph, objectDirectory: '.temp/public-reads',
    lineage: { dataEpoch: 'one', routingEpoch: 'one' } },
    access: { canReadWork: async () => {
      privateGrantProbes++;
      throw new Error('Anonymous candidates cannot obtain a private grant');
    } }, media: { store: { avatarRows: async (resources: readonly string[]) => {
      hydrated.push([...resources]);
      return { rows: new Map(), generation: { dataEpoch: 'media', sequence: '1' } };
    } } },
  } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request('http://main.local/v1/works'), {},
    { dataEpoch: 'one', sequence: '1' });
  const page = await readWorkWholes(session, resource, { limit: 1 });
  expect(scans).toBe(2);
  expect(scalarProbes).toBe(1);
  expect(privateGrantProbes).toBe(0);
  expect(summaryBatches.map(batch => batch.length)).toEqual([64, 37, 3]);
  expect(summaryBatches.flat()).toEqual(rows.map(row => row.whole.value));
  expect(exactBatches).toEqual([[visible]]);
  expect(hydrated).toEqual([[visible]]);
  expect(page.wholes.map(item => item.work)).toEqual([visible]);
  expect(page.next).toBeNull();
  expect(page).not.toHaveProperty('count');
  for (const row of rows.filter(row => row.whole.value !== visible)) {
    expect(JSON.stringify(page)).not.toContain(row.occurrence.value);
    expect(JSON.stringify(page)).not.toContain(row.whole.value);
  }
});

// Complete GET inventory: a new route needs an explicit disclosure classification
// and its public-fixture request in the integration test (or a personal-state owner).
export const publicGetRoutes = [
  '/v1/resources/:resource/discussion', '/v1/resources/:resource/parts',
  '/v1/resources/:resource/wholes', '/v1/resources/:resource/relations',
  '/v1/resources/:resource/rating-contexts', '/v1/resources/:resource/ratings',
  '/v1/resources/:resource/reviews', '/v1/compositions/:id',
  '/v1/resources/:resource/page', '/v1/resources/:resource/statements',
  '/v1/compositions/:id/revisions/:revision', '/v1/compositions/:id/seals/:seal',
  '/v1/compositions/:id/occurrences/:occurrence', '/v1/collections/:id',
  '/v1/collections/:id/works',
  '/v1/collections/:id/name', '/v1/collections/:id/revisions/:revision',
] as const;

test('G-829 class guard: every resource/composition/Collection GET has an explicit public or personal disclosure contract', () => {
  const graph = new FusekiClient('http://graph.invalid');
  const app = createMainApp(graph, { environment: { fuseki: graph, objectDirectory: '.temp/g-829',
    lineage: { dataEpoch: 'one', routingEpoch: 'one' } }, account: {} as never, access: {} as never });
  const gets = app.routes.filter(route => route.method === 'GET'
    && /^\/v1\/(resources\/:resource\/|compositions\/|collections\/)/.test(route.path)).map(route => route.path);
  expect(gets.sort()).toEqual([...publicGetRoutes,
    '/v1/resources/:resource/continuities',
    '/v1/compositions/:id/stages/:stage',
    '/v1/compositions/:id/occurrences/:occurrence/progress',
  ].sort());
});


test('G-829 class guard: the complete lexicon GET inventory permits optional bearer access', () => {
  const graph = new FusekiClient('http://graph.invalid');
  const app = createMainApp(graph, { environment: { fuseki: graph, objectDirectory: '.temp/g-829',
    lineage: { dataEpoch: 'one', routingEpoch: 'one' } }, account: {} as never, access: {} as never });
  const gets = app.routes.filter(route => route.method === 'GET' && route.path.startsWith('/v1/lexicon/'))
    .map(route => route.path.replace(/:([a-z]+)/g, '{$1}')).sort();
  expect(gets).toEqual(Object.keys(lexiconOperations).sort());
  for (const operation of Object.values(lexiconOperations)) expect(operation.get.bearer).toBe(false);
  expect(lexiconOperations['/v1/lexicon/presentations'].post).toEqual({ exposure: 'platform:platform-admin', rateLimitFamily: 'write', bearer: true, idempotencyKey: true });
});
