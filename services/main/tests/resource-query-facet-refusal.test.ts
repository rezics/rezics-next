import { expect, test } from 'bun:test';
import type { Static } from 'typebox';
import type { FilterCondition, ResourceQuery } from '../../../model/definitions/filter-document-v1.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { facetList } from '../src/modules/facets/contract.ts';
import { facetListBody } from '../src/modules/facets/registry.ts';
import { FILTER_LIMITS } from '../src/modules/facets/schema.ts';
import { compileQuery, QueryRejected } from '../src/modules/query/compile.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { queryRoutes } from '../src/routes/query.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const discovery: Static<typeof facetList> = JSON.parse(facetListBody);
const shape = discovery.queryShapes!.find(item => item.id === 'release-works-v1')!;
const translator = discovery.facets.find(facet => facet.name === 'releaseTranslator' && facet.current)!;
const release = discovery.facets.find(facet => facet.name === 'release' && facet.current)!;
const base: ResourceQuery = { context: 'global', scope: { kind: 'all' }, sort: 'newest', page: { size: 2 } };

function rejected(query: ResourceQuery): QueryRejected {
  try { compileQuery(query); }
  catch (error) {
    expect(error).toBeInstanceOf(QueryRejected);
    if (!(error instanceof QueryRejected)) throw error;
    return error;
  }
  throw new Error('Expected Query admission to refuse this scope');
}

const misplaced: FilterCondition[] = [translator.name, translator.id].flatMap(facet =>
  (['any', 'all', 'none'] as const).map(operator => ({ facet, [operator]: [id(1)] })));
const foreign: FilterCondition = { facet: 'relation', bind: { definition: id(2), role: id(3) },
  where: { all: [{ facet: translator.id, none: [id(1)] }] } };

test('Advertised translator conditions retain precise placement refusals for resource and foreign occurrence scopes', () => {
  expect(shape).toMatchObject({ state: 'ready', method: 'POST', href: '/v1/query', requestProfile: 'filter-document-v1' });
  expect(shape.facets).toContain(translator.id);
  for (const condition of misplaced) {
    expect(rejected({ ...base, filter: { all: [condition] } })).toMatchObject({
      refusal: 'misplaced_facet', message: 'misplaced_facet: releaseTranslator needs an occurrence',
    });
    const accepted = compileQuery({ ...base, filter: { all: [
      { facet: release.id, where: { all: [condition] } },
    ] } });
    expect(accepted.template).toBe('release-works');
    expect(accepted.facets).toContain(translator.id);
  }
  expect(rejected({ ...base, filter: { all: [foreign] } })).toMatchObject({
    refusal: 'misplaced_facet', message: 'misplaced_facet: releaseTranslator needs its declared related-node group',
  });
});

test('Advertised Query route returns machine-readable misplaced_facet before any owner or Account read', async () => {
  const reads: string[] = [];
  const failRead = (_target: object, key: string | symbol): never => {
    reads.push(String(key));
    throw new Error(`Invalid placement attempted owner read: ${String(key)}`);
  };
  // Disconnected dependencies supply no authority, graph or projection answer.
  const graph = new Proxy<FusekiClient>(new FusekiClient('http://127.0.0.1:1/rezics'), { get: failRead });
  const work = new Proxy<MainWorkDependencies>({} as MainWorkDependencies, { get: failRead });
  const app = queryRoutes(graph, work);
  for (const signedIn of [false, true]) for (const condition of [...misplaced, foreign]) {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (signedIn) headers.set('authorization', 'Bearer admission-must-precede-verification');
    const response = await app.handle(new Request(`http://main.local${shape.href}`, {
      method: shape.method, headers, body: JSON.stringify({ ...base, filter: { all: [condition] } }),
    }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ status: 422, code: 'misplaced_facet' });
    expect(body.title).toStartWith('misplaced_facet: releaseTranslator ');
    expect(body).not.toHaveProperty('result');
    expect(reads).toEqual([]);
  }
});

test('Precise placement codes preserve existing invalid, unsupported and filter allocation refusals', () => {
  const invalid: FilterCondition[] = [{ facet: 'unknownFacet', any: [id(1)] },
    { facet: 'type', any: [] }, { facet: 'relation', bind: {}, where: { all: [{ facet: translator.id, any: [id(1)] }] } }];
  for (const condition of invalid)
    expect(rejected({ ...base, filter: { all: [condition] } }).refusal).toBe('invalid_query');
  expect(rejected({ ...base, filter: { all: Array.from({ length: FILTER_LIMITS.nodes + 1 },
    () => ({ facet: 'type', any: ['https://rezics.com/vocab/Book'] })) } })).toMatchObject({
    refusal: 'query_budget_exceeded', message: 'filter_too_large: Filter has too many nodes',
  });
  expect(rejected({ ...base, filter: { any: [{ facet: 'type', any: ['https://rezics.com/vocab/Book'] }] } })
    .refusal).toBe('unsupported_query_shape');
  expect(rejected({ ...base, sourcePolicy: { kind: 'multi-dataset', datasetIds: ['product', 'other'] } })
    .refusal).toBe('unsupported_query_source');
});
