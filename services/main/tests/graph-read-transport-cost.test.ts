import { expect, test } from 'bun:test';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { GraphReadFence } from '../src/infrastructure/graph-read-fence.ts';
import { workRead } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { meterFuseki } from '../../../tests/qa/integration/support/query-cost-meter.ts';
import { CountingFuseki } from '../../../tests/qa/integration/support/counting-fuseki.ts';

test('only the closing graph fence reuses copied results; physical counters equal wire requests', async () => {
  let wire = 0, head = 'first';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
    wire++;
    return Response.json({ results: { bindings: [{ head: { type: 'literal', value: head } }] } });
  } });
  const native = new CountingFuseki(server.url.href);
  const graph = meterFuseki(native);
  try {
    const fence = new GraphReadFence(native);
    await fence.capture(async () => {
      const first = await graph.query('SELECT ?head WHERE {}', 1024);
      first.results!.bindings[0]!.head!.value = 'caller mutation';
      head = 'successor';
      expect((await graph.query('SELECT ?head WHERE {}', 1024)).results!.bindings[0]!.head!.value).toBe('successor');
      await fence.verify(async () => {
        const retained = await graph.query('SELECT ?head WHERE {}', 1024);
        expect(retained.results!.bindings[0]!.head!.value).toBe('first');
        retained.results!.bindings[0]!.head!.value = 'another mutation';
        expect((await graph.query('SELECT ?head WHERE {}', 1024)).results!.bindings[0]!.head!.value).toBe('first');
        await graph.query('SELECT ?head WHERE {}', 2048);
      });
      expect(fence.reused).toBe(true);
    });
    await new GraphReadFence(native).capture(async () => { await graph.query('SELECT ?head WHERE {}', 1024); });
    await fence.capture(() => graph.query('ASK {}', 1024, 'occurrence-discovery'));
    await fence.verify(() => graph.query('ASK {}', 1024, 'occurrence-discovery'));
    expect(wire).toBe(6);
    expect(graph.queries).toBe(wire);
    expect(native.queries).toBe(wire);
  } finally { await server.stop(true); }
});

test('a graph change during a live owner fence retries instead of delivering memoized stale rows', async () => {
  let sequence = 1, head = 'first', ownerReads = 0, assemblies = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ results: { bindings: [{
    epoch: { type: 'literal', value: 'epoch' }, sequence: { type: 'literal', value: String(sequence) },
    head: { type: 'literal', value: head },
  }] } }, { headers: { 'x-rezics-graph-version':
    `00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:${sequence}` } }) });
  const graph = new FusekiClient(server.url.href);
  const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } },
    access: { assertRecoveryOpen: async () => {} } } as unknown as MainWorkDependencies;
  try {
    const answer = await workRead(deps, new Request('http://main.test/v1/realms/test'), {}, async session => {
      assemblies++;
      const rows = await session.query('SELECT ?head WHERE {}', 1);
      session.observeDependency('live-owner', true, async () => {
        ownerReads++;
        if (ownerReads === 1) { sequence++; head = 'successor'; }
        return true;
      });
      return rows[0]!.head!.value;
    });
    expect(answer).toBe('successor');
    expect(assemblies).toBe(2);
    expect(ownerReads).toBe(2);
  } finally { await server.stop(true); }
});
