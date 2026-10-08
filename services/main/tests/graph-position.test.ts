import { expect, test } from 'bun:test';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { GRAPH_QUERY_COST, checkedStatementGraphQuery, InvalidGraphQuery,
  type StatementGraphQuery } from '../src/modules/graph-query/schema.ts';
import { queryStatementGraph } from '../src/modules/graph-query/statements.ts';
import { GraphQueryContinuationStale, GraphQueryNotFound } from '../src/modules/graph-query/query.ts';
import { type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request: StatementGraphQuery = { profile: 'statement-graph-v1', actingSubject: id(1),
  anchor: id(2), direction: 'incoming' };
const binding = (value: string) => ({ type: 'uri', value });
function fixture(count: number) {
  const fuseki = new FusekiClient('http://unused.invalid');
  let calls = 0;
  fuseki.query = async text => {
    calls++;
    if (!text.includes('GROUP_CONCAT')) return { boolean: true };
    return { results: { bindings: Array.from({ length: count }, (_, n) => ({ epoch: binding('epoch'), sequence: binding('1'),
      statement: binding(id(100 + n)), head: binding(id(200 + n)), subject: binding(id(3)), object: binding(id(2)),
      predicate: binding('https://example.org/participates'), relation: binding('https://example.org/definition'),
      speaker: binding(id(1)), key: binding('key'), applicability: binding(id(4)) })) } };
  };
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: '.temp/graph-position',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  return { env, calls: () => calls };
}

test('statement graph positions accept the common selection and reject malformed values', () => {
  for (const position of [undefined, 'mine', 'all', 'start', id(4)]) {
    expect(checkedStatementGraphQuery({ ...request, position }).position).toBe(position);
  }
  expect(() => checkedStatementGraphQuery({ ...request, position: 'chapter 3' })).toThrow(InvalidGraphQuery);
  expect(GRAPH_QUERY_COST.statementPage.projectionPartQueries).toBe(1);
  // Each candidate expands interpretation context and edition scope: 65 * (5 + 8 + 2 * 9) + 1 records.
  expect(GRAPH_QUERY_COST.statementPage.revelationBatches).toBe(41);
});

test('statement graph filters the Statement and both endpoints in one batch before counting', async () => {
  for (const hidden of [id(100), id(3), id(2), id(4)]) {
    const f = fixture(3);
    const calls: string[][] = [];
    const authority = { canReadResource: async () => true, canReadPrivateContext: async () => true,
      visibleRecords: async (records: readonly string[]) => { calls.push([...records]); return new Set(records.filter(ref => ref !== hidden)); } };
    if (hidden === id(2)) await expect(queryStatementGraph(f.env, authority, request)).rejects.toBeInstanceOf(GraphQueryNotFound);
    else {
      const result = await queryStatementGraph(f.env, authority, request);
      expect(result.total).toBe(hidden === id(100) ? 2 : 0);
      expect(result.claims.some(claim => claim.statement === id(100))).toBe(false);
      expect(result.continuation).toBeNull();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(id(100)); expect(calls[0]).toContain(id(3)); expect(calls[0]).toContain(id(2));
    expect(f.calls()).toBe(2);
  }
});

test('statement continuation binds the selection and revelation snapshot', async () => {
  const f = fixture(65);
  const authority = { canReadResource: async () => true, canReadPrivateContext: async () => true,
    visibleRecords: async (records: readonly string[]) => new Set(records), readingBinding: ['mine', '1', 'saved-1'] };
  const first = await queryStatementGraph(f.env, authority, request);
  expect(first.claims).toHaveLength(64); expect(first.continuation).not.toBeNull();
  const next = { ...request, continuation: first.continuation! };
  for (const changed of [{ ...next, position: 'all' }, { ...next, position: id(4) }]) {
    await expect(queryStatementGraph(f.env, authority, changed)).rejects.toBeInstanceOf(GraphQueryContinuationStale);
  }
  await expect(queryStatementGraph(f.env, { ...authority, readingBinding: ['mine', '2', 'saved-1'] }, next))
    .rejects.toBeInstanceOf(GraphQueryContinuationStale);
  await expect(queryStatementGraph(f.env, { ...authority, readingBinding: ['mine', '1', 'saved-2'] }, next))
    .rejects.toBeInstanceOf(GraphQueryContinuationStale);
  expect(f.calls()).toBe(2);
});
