import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { uuidToSid } from '@rezics/model/address/sid';
import type { SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { resourceRoutes } from '../../../services/main/src/routes/resources.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';
import { RV } from '../../../services/main/src/modules/work/activate.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const space = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
const foreign = 'https://example.org/non-native/日本語';
const missing = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const literal = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });
const rows = (bindings: NonNullable<SparqlResult['results']>['bindings']) => ({ results: { bindings } });

test('G-971/VIEW08: summary batches report page visibility and addresses while transport fences stay constant', async () => {
  const queries: string[] = [];
  const mediaBatches: string[][] = [];
  const names: string[][] = [];
  const fuseki = { async query(query: string) {
    queries.push(query);
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?epoch ?sequence WHERE'))
      return rows([{ epoch: literal('epoch'), sequence: literal('7') }]);
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const values = query.match(/VALUES \?r \{([^}]+)\}/)?.[1] ?? '';
      return rows([work, space].filter(ref => values.includes(`<${ref}>`)).map(ref => ({
        epoch: literal('epoch'), sequence: literal('7'), r: uri(ref),
        type: literal(ref === work ? 'work' : 'space'), public: literal('true'),
        ...(ref === work ? { work: uri(work), head: uri(work) } : {}),
        label: { ...literal(ref === work ? 'A Work' : 'A Realm Space'), 'xml:lang': 'en' },
      })));
    }
    if (query.includes('SELECT DISTINCT ?resource ?space ?disclosure'))
      return rows([{ resource: uri(space), space: uri(space), disclosure: uri(RV + 'Public') }]);
    if (query.includes('SELECT ?resource ?space ?site'))
      return rows([{ resource: uri(space), space: uri(space), site: literal('false') }]);
    throw new Error(`Unexpected summary query: ${query}`);
  } };
  const deps = {
    environment: { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: '1' },
      addresses: { currents: async (holders: string[]) => { names.push(holders); return new Map(); } } },
    media: { store: { avatarRows: async (targets: string[], context: string) => {
      expect(context).toBe(DEFAULT_MEDIA_CONTEXT);
      mediaBatches.push(targets);
      return { rows: new Map(), generation: { dataEpoch: 'epoch', sequence: '4' } };
    } } },
  } as unknown as MainWorkDependencies;
  const app = new Elysia().use(resourceRoutes(deps.environment.fuseki, deps));
  const batch = async (resources: string[]) => {
    queries.length = 0; mediaBatches.length = 0; names.length = 0;
    const response = await app.handle(new Request('http://main.test/v1/resources/summaries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'resource-summary-batch-v1', resources }),
    }));
    expect(response.status).toBe(200);
    return response.json();
  };
  for (const size of [1, 16, 64]) {
    const body = await batch(Array.from({ length: size }, () => work));
    expect(body.cost).toEqual({ graphQueries: 1, mediaQueries: 1, accessChecks: 0, accessQueries: 0 });
    expect(queries).toHaveLength(4);
    expect(mediaBatches).toEqual([[work]]);
    expect(names).toEqual([[work]]);
    expect(body.summaries).toHaveLength(size);
    expect(body.summaries.every((summary: { status: string }) => summary.status === 'available')).toBe(true);
  }
  const mixed = await batch([work, space, foreign, missing, work]);
  expect(mixed.cost).toEqual({ graphQueries: 4, mediaQueries: 1, accessChecks: 0, accessQueries: 0 });
  expect(queries).toHaveLength(7);
  expect(mediaBatches).toEqual([[work, space]]);
  expect(names).toEqual([[work, space]]);
  expect(mixed.summaries).toMatchObject([
    { reference: work, status: 'available', type: 'work' },
    { reference: space, status: 'available', type: 'space',
      address: { prefix: '/r/', key: uuidToSid(space.slice(-36)), slugSource: 'A Realm Space' } },
    { reference: foreign, status: 'unavailable' },
    { reference: missing, status: 'unavailable' },
    { reference: work, status: 'available', type: 'work' },
  ]);
  expect(mixed.summaries[2]).toEqual({ reference: foreign, status: 'unavailable' });
  expect(mixed.summaries[3]).toEqual({ reference: missing, status: 'unavailable' });
  expect(queries.every(query => !query.includes(foreign))).toBe(true);
});
