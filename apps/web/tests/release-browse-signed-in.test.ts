import { expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import { FusekiClient, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { configureDisclosure, DisclosureStore,
  type DisclosureTarget } from '../../../services/main/src/modules/disclosure/read.ts';
import { RV } from '../../../services/main/src/modules/work/activate.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { queryRoutes } from '../../../services/main/src/routes/query.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seed = { work: id(1), head: id(2), main: id(3), release: id(4), realm: id(5), space: id(6), realmHead: id(7) };
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
const control = { epoch: literal('epoch'), sequence: literal('1') };
type Row = NonNullable<SparqlResult['results']>['bindings'][number];

function catalogue() {
  const graph = new FusekiClient('http://graph.invalid');
  const unexpectedQueries: string[] = [];
  // Keep the production transport's call/byte ledger and mock only graph data.
  const transport = spyOn(globalThis, 'fetch').mockImplementation((async (_input: RequestInfo | URL, options?: RequestInit) => {
    const query = String(options?.body ?? '');
    let rows: Row[];
    if (query.includes('SELECT ?epoch ?sequence WHERE')) rows = [control];
    else if (query.includes('SELECT ?space ?realmRevision')) rows = [{
      space: uri(seed.space), realmRevision: uri(seed.realmHead), disclosure: uri(`${RV}Public`),
    }];
    else if (query.includes('RestoreCutover')) rows = [];
    else if (query.includes('SELECT DISTINCT ?work ?head ?main ?epochOrder ?sequence')) rows = [{
      work: uri(seed.work), head: uri(seed.head), main: uri(seed.main),
      epochOrder: literal('0'), sequence: literal('1'),
    }];
    else if (query.includes('SELECT DISTINCT ?work WHERE')) rows = [{ work: uri(seed.work) }];
    else if (query.includes('SELECT ?work ?release WHERE')) rows = [{ work: uri(seed.work), release: uri(seed.release) }];
    else if (query.includes('SELECT ?epoch ?sequence ?hold ?r ?type')) rows = [{
      ...control, r: uri(seed.work), type: literal('work'), work: uri(seed.work), head: uri(seed.head),
      public: literal('true'), label: { ...literal('Starlit Crossing'), 'xml:lang': 'en' },
    }];
    else if (query.includes('SELECT ?work ?head ?nameOwner WHERE')) rows = [{
      work: uri(seed.work), head: uri(seed.head),
    }];
    else {
      unexpectedQueries.push(query);
      rows = [];
    }
    return Response.json({ results: { bindings: rows } });
  }) as typeof fetch);
  const pool = { query: async (sql: string, args: unknown[]) => {
    expect(sql).toContain('requested AS');
    const targets = JSON.parse(String(args[0])) as (DisclosureTarget & { ordinal: number })[];
    return { rows: targets.map(target => ({ ordinal: target.ordinal, open: true,
      restricted: false, assessments: [], nameVisible: true })) };
  } } as unknown as Pool;
  const environment = { fuseki: graph, objectDirectory: '.temp',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, new DisclosureStore(pool));
  const work = { environment, account: { verify: async () => ({ issuer: 'account', subject: 'reader' }) },
    access: { assertRecoveryOpen: async () => undefined },
    platformAccess: { require: async () => { throw new Error('Public catalogue read requested a platform grant'); } },
  } as unknown as MainWorkDependencies;
  return { app: queryRoutes(graph, work), unexpectedQueries, restore: () => transport.mockRestore() };
}

for (const realmScope of [false, true]) {
  test(`release-filtered ${realmScope ? 'Realm' : 'global'} catalogue shows the same Work signed out and signed in`, async () => {
    const fixture = catalogue();
    const query = { context: realmScope ? { realm: seed.realm } : 'global',
      scope: realmScope ? { kind: 'realm', realm: seed.realm } : { kind: 'all' },
      sort: 'newest', page: { size: 20 }, filter: { all: [{ facet: 'release', where: { all: [
        { facet: 'releaseLanguage', any: ['en'] }, { facet: 'releasePlatform', any: ['Switch'] },
      ] } }] } };
    try {
      const results: unknown[] = [];
      for (const signedIn of [false, true]) {
        const response = await fixture.app.handle(new Request('http://main.test/v1/query', {
          method: 'POST', headers: { 'content-type': 'application/json',
            ...(signedIn ? { authorization: 'Bearer reader' } : {}) }, body: JSON.stringify(query),
        }));
        const body = await response.json();
        expect(fixture.unexpectedQueries).toEqual([]);
        expect({ signedIn, status: response.status, problem: body.code }).toEqual({
          signedIn, status: 200, problem: undefined,
        });
        expect(body).toMatchObject({ profile: 'query-v1', template: 'release-works-v1', result: {
          profile: 'release-works-v1', items: [{ id: seed.work, title: { value: 'Starlit Crossing' },
            matchedReleases: [seed.release] }],
        } });
        results.push(body.result);
      }
      expect(results[1]).toEqual(results[0]);
    } finally {
      fixture.restore();
    }
  });
}
