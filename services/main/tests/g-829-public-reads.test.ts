import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import { canReadCompositionWork } from '../src/modules/composition/disclosure-read.ts';
import { readWorkWholes } from '../src/modules/composition/read.ts';
import { openApiOperations as lexiconOperations } from '../src/routes/lexicon.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const value = (value: string) => ({ type: 'literal', value });

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
  const rows = Array.from({ length: 104 }, (_, index) => ({ whole: value(index === 102 ? visible : id()),
    main: value(id()), structure: value(id()), occurrence: value(id()), segment: value('01'), order: value('01') }));
  const session = new WorkReadSession({} as MainWorkDependencies, new Request('http://main.local/v1/works'), {},
    { dataEpoch: 'one', sequence: '1' });
  let scans = 0;
  session.query = async query => {
    if (query.includes('SELECT ?main ?public')) return [{ main: value(id()),
      public: value(query.includes(`<${resource}>`) || query.includes(`<${visible}>`) ? 'true' : 'false') }];
    return scans++ === 0 ? rows.slice(0, 101) : rows.slice(101);
  };
  const page = await readWorkWholes(session, resource, { limit: 1 });
  expect(scans).toBe(2);
  expect(page.wholes.map(item => item.work)).toEqual([visible]);
  expect(page.next).toBeNull();
  expect(page).not.toHaveProperty('count');
  for (const row of rows.filter(row => row.whole.value !== visible)) {
    expect(JSON.stringify(page)).not.toContain(row.occurrence.value);
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
  '/v1/collections/:id/name', '/v1/collections/:id/revisions/:revision',
] as const;

test('G-829 class guard: every resource/composition/Collection GET has an explicit public or personal disclosure contract', () => {
  const graph = new FusekiClient('http://graph.invalid');
  const app = createMainApp(graph, { environment: { fuseki: graph, objectDirectory: '.temp/g-829',
    lineage: { dataEpoch: 'one', routingEpoch: 'one' } }, account: {} as never, access: {} as never });
  const gets = app.routes.filter(route => route.method === 'GET'
    && /^\/v1\/(resources\/:resource\/|compositions\/|collections\/)/.test(route.path)).map(route => route.path);
  expect(gets.sort()).toEqual([...publicGetRoutes,
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
  expect(lexiconOperations['/v1/lexicon/presentations'].post).toEqual({ bearer: true, idempotencyKey: true });
});
