import { expect, test } from 'bun:test';
import { FusekiClient, FusekiQueryResponseTooLarge, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { readPublicStatementsAt } from '../src/modules/statement/read.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import { MAX_SEARCH_RESPONSE_BYTES } from '../src/modules/work/search-readiness.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });

test('256 allowed Statement supports retain their 1 MiB owner ceiling for a 600 KiB batch and its delivery reread', async () => {
  const statements = Array.from({ length: 256 }, (_, index) => id(index + 1));
  const bindings = statements.map((statement, index) => ({ statement: uri(statement),
    epoch: literal('epoch'), sequence: literal('7'), subject: uri(id(300)), predicate: uri(id(301)),
    object: uri(id(302)), relation: uri(id(303)), speaker: uri(id(304)), head: uri(id(index + 1000)),
    key: literal('a'.repeat(64)), definitions: literal('https://definitions.example/' + 'd'.repeat(1000)),
    applicability: literal('https://scope.example/selected'),
  }));
  const initialBytes = Buffer.byteLength(JSON.stringify({ results: { bindings } }));
  const padding = Math.max(0, Math.ceil((600 * 1024 - initialBytes) / bindings.length));
  for (const row of bindings) row.applicability.value += 'a'.repeat(padding);
  const response: SparqlResult = { results: { bindings } };
  const byteLength = Buffer.byteLength(JSON.stringify(response));
  expect(byteLength).toBeGreaterThanOrEqual(600 * 1024);
  expect(byteLength).toBeLessThan(MAX_SEARCH_RESPONSE_BYTES);
  let dataReads = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const body = await request.text();
    if (body.includes('ASK')) return Response.json({ boolean: true });
    dataReads++;
    return Response.json(response);
  } });
  try {
    const graph = new FusekiClient(server.url.toString());
    const deps = { environment: { fuseki: graph, objectDirectory: '.temp/work-query-ceilings',
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } } as unknown as MainWorkDependencies;
    const session = new WorkReadSession(deps, new Request('http://main.test/v1/works/classifications'), {},
      { dataEpoch: 'epoch', sequence: '7' });
    const parsed = await readPublicStatementsAt(deps.environment, statements, session.position, undefined, session);
    expect(parsed.size).toBe(256);
    expect(parsed.get(statements[0]!)?.applicability).toEqual([bindings[0]!.applicability.value]);
    await session.fenceDependencies();
    expect(dataReads).toBe(2);
    await expect(new WorkReadSession(deps, session.request, {}, session.position)
      .query('SELECT ?statement WHERE {}', 256)).rejects.toBeInstanceOf(FusekiQueryResponseTooLarge);
  } finally { await server.stop(true); }
});

test('delivery rereads preserve an explicit small ceiling instead of widening it to the session default', async () => {
  let padding = 10;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({
    results: { bindings: [{ label: literal('a'.repeat(padding)) }] },
  }) });
  try {
    const deps = { environment: { fuseki: new FusekiClient(server.url.toString()) } } as unknown as MainWorkDependencies;
    const session = new WorkReadSession(deps, new Request('http://main.test/v1/resources'), {},
      { dataEpoch: 'epoch', sequence: '7' });
    await session.query('SELECT ?label WHERE {}', 1, undefined, 4096);
    padding = 6000;
    await expect(session.fenceDependencies()).rejects.toBeInstanceOf(FusekiQueryResponseTooLarge);
  } finally { await server.stop(true); }
});
