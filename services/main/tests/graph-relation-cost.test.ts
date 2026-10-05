import { expect, test } from 'bun:test';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import {
  admitRelationCandidatePage,
  GraphQueryBudgetExceeded,
  GraphQueryNotFound,
  GraphQueryUnavailable,
  queryRelationGraph,
} from '../src/modules/graph-query/query.ts';
import {
  GRAPH_QUERY_COST,
  GRAPH_QUERY_READ_LIMITS,
  type RelationGraphQuery,
} from '../src/modules/graph-query/schema.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { graphQueryRoutes } from '../src/routes/graph-queries.ts';

const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = (value: string) => ({ type: 'uri', value });
const rows = (count: number) =>
  Array.from({ length: count }, (_, n) => ({
    occurrence: binding(id(100 + n)),
    revision: binding(id(200 + n)),
    from: binding(id(2)),
    to: binding(id(300 + n)),
    target: binding(id(300 + n)),
  }));
const scalarRead = async (): Promise<boolean> => {
  throw new Error('page disclosure fell back to a scalar read');
};
const request: RelationGraphQuery = {
  profile: 'relation-graph-v1',
  actingSubject: id(1),
  anchor: { kind: 'resource', id: id(2) },
  definition: id(3),
  fromRole: 'lead',
  toRole: 'character',
  direction: 'outgoing',
  roleBindings: [],
};

test('GRAPH03/GRAPH04: 65 native edges use two disclosure batches and count only admitted candidates', async () => {
  const batches: string[][] = [];
  const candidates = rows(65);
  const hidden = new Set([id(100), id(301)]);
  const authority = {
    canReadResource: scalarRead,
    canReadResources: async (refs: readonly string[]) => {
      batches.push([...refs]);
      return new Set(refs.filter((ref) => !hidden.has(ref)));
    },
  };
  const page = await admitRelationCandidatePage(authority, candidates);
  expect(batches.map((batch) => batch.length)).toEqual([65, 65]);
  expect(new Set(batches.flat()).size).toBe(130);
  expect(page.rawBoundReached).toBe(true);
  expect(page.admitted).toHaveLength(63);
  expect(
    page.admitted.some((row) => hidden.has(row.occurrence!.value) || hidden.has(row.target!.value)),
  ).toBe(false);
  expect(GRAPH_QUERY_COST.relationPage.maxResourceSeedFusekiCalls).toBe(18);
  expect(GRAPH_QUERY_COST.relationPage.maxResourceSeedFusekiCalls).toBeLessThan(
    GRAPH_QUERY_READ_LIMITS.fusekiCalls,
  );

  // Page decisions expire with the request: a revoked grant is never reused.
  hidden.add(id(302));
  expect((await admitRelationCandidatePage(authority, candidates)).admitted).toHaveLength(62);
  expect(batches).toHaveLength(4);
});

test('GRAPH03/GRAPH04: repeated references share disclosure and external targets need no native authority', async () => {
  const candidates = rows(3);
  candidates[1] = { ...candidates[0]! };
  const external = { ...candidates[2]!, targetExternal: binding('true') };
  const batches: string[][] = [];
  const page = await admitRelationCandidatePage(
    {
      canReadResource: scalarRead,
      canReadResources: async (refs) => {
        batches.push([...refs]);
        return new Set(refs);
      },
    },
    [...candidates.slice(0, 2), external],
  );
  expect(batches).toEqual([[id(100), id(300), id(102)]]);
  expect(page.admitted).toEqual([candidates[0]!, external]);
  expect(page.rawBoundReached).toBe(false);
});

test('GRAPH03: an oversized or incomplete candidate page fails before any disclosure', async () => {
  const authority = {
    canReadResource: scalarRead,
    canReadResources: async (): Promise<ReadonlySet<string>> => {
      throw new Error('invalid candidates reached disclosure');
    },
  };
  await expect(admitRelationCandidatePage(authority, rows(66))).rejects.toBeInstanceOf(
    GraphQueryBudgetExceeded,
  );
  await expect(
    admitRelationCandidatePage(authority, [{ ...rows(1)[0]!, target: undefined }]),
  ).rejects.toBeInstanceOf(GraphQueryUnavailable);
  expect(await admitRelationCandidatePage(authority, [])).toEqual({
    admitted: [],
    rawBoundReached: false,
  });
});

test('GRAPH04: anchor and role constraints share one disclosure before matching a hidden participant', async () => {
  const graphQueries: string[] = [];
  const env = {
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: {
      query: async (query: string) => {
        graphQueries.push(query);
        if (query.includes('ASK {')) return { boolean: true };
        throw new Error('hidden participant reached the relation match');
      },
    } as FusekiClient,
  } as WorkActivationEnvironment;
  const batches: string[][] = [];
  await expect(
    queryRelationGraph(
      env,
      {
        canReadResource: scalarRead,
        canReadResources: async (refs) => {
          batches.push([...refs]);
          return new Set(refs.filter((ref) => ref !== id(4)));
        },
      },
      {
        ...request,
        roleBindings: [
          { role: 'lead', participant: id(2) },
          { role: 'character', participant: id(4) },
        ],
      },
    ),
  ).rejects.toBeInstanceOf(GraphQueryNotFound);
  expect(batches).toEqual([[id(2), id(4)]]);
  expect(graphQueries).toHaveLength(1);
});

test('relation graph route requires the bounded reference reader at composition', async () => {
  const work = {
    account: { verify: async () => ({ issuer: 'https://account.test', subject: 'reader' }) },
    access: { canReadSemanticResource: scalarRead },
  } as unknown as Parameters<typeof graphQueryRoutes>[0];
  const response = await graphQueryRoutes(work).handle(
    new Request('http://localhost/v1/graph/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'graph_query_unavailable' });
});
