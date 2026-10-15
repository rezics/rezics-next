import { afterEach, expect, spyOn, test } from 'bun:test';
import { GraphReadFence, graphReadVersion } from '../src/infrastructure/graph-read-fence.ts';
import { FusekiClient, fusekiReadBudget } from '../src/infrastructure/fuseki.ts';

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

function fixture() {
  let calls = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async () => {
    calls++;
    return Response.json({ results: { bindings: [{ head: { type: 'literal', value: 'head' } }] } });
  }) as typeof globalThis.fetch);
  restores.push(() => fetch.mockRestore());
  const graph = new FusekiClient('http://graph.invalid/rezics');
  return { graph, fence: new GraphReadFence(graph), calls: () => calls };
}

test('the raw Fuseki transport reuses isolated graph inputs without charging a second HTTP call', async () => {
  const f = fixture();
  const budget = { signal: AbortSignal.timeout(5_000), callsLeft: 1, bytesLeft: 4096 };
  await fusekiReadBudget.run(budget, async () => {
    const first = await f.fence.capture(() => f.graph.query('SELECT ?head WHERE {}', 1024));
    first.results!.bindings[0]!.head!.value = 'mutated by the consumer';
    const fenced = await f.fence.verify(() => f.graph.query('SELECT ?head WHERE {}', 1024));
    expect(fenced.results!.bindings[0]!.head!.value).toBe('head');
    expect(budget.callsLeft).toBe(0);
  });
  expect(f.calls()).toBe(1);
  expect(f.fence.reused).toBe(true);
});

for (const query of ['SELECT (NOW() AS ?time) WHERE {}', 'SELECT ?x WHERE { SERVICE <http://other> {} }',
  'SELECT ?x WHERE { ?x text:query "name" }',
  'PREFIX index: <http://jena.apache.org/text#> SELECT ?x WHERE { ?x index:query "name" }']) {
  test(`a separately changing query remains live: ${query}`, async () => {
    const f = fixture();
    await f.fence.capture(() => f.graph.query(query));
    await f.fence.verify(() => f.graph.query(query));
    expect(f.calls()).toBe(2);
    expect(f.fence.reused).toBe(false);
  });
}

test('another graph client and another response budget cannot borrow the captured version', async () => {
  const f = fixture(), other = new FusekiClient('http://other.invalid/rezics');
  await f.fence.capture(() => f.graph.query('ASK {}', 1024));
  await f.fence.verify(async () => {
    await other.query('ASK {}', 1024);
    await f.graph.query('ASK {}', 2048);
  });
  expect(f.calls()).toBe(3);
});

test('a cached raw query still refuses cancellation and invalid response bounds', async () => {
  const f = fixture(), abort = new AbortController();
  const budget = { signal: abort.signal, callsLeft: 2, bytesLeft: 4096 };
  await fusekiReadBudget.run(budget, async () => {
    await f.fence.capture(() => f.graph.query('ASK {}', 1024));
    await expect(f.fence.verify(() => f.graph.query('ASK {}', 0))).rejects.toThrow('invalid Fuseki query response budget');
    abort.abort(new Error('read cancelled'));
    await expect(f.fence.verify(() => f.graph.query('ASK {}', 1024))).rejects.toThrow('read cancelled');
  });
  expect(f.calls()).toBe(1);
});

test('native discovery probes remain live even for an identical SPARQL body', async () => {
  const f = fixture();
  await f.fence.capture(() => f.graph.query('SELECT ?head WHERE {}', 1024, 'occurrence-discovery'));
  await f.fence.verify(() => f.graph.query('SELECT ?head WHERE {}', 1024, 'occurrence-discovery'));
  expect(f.calls()).toBe(2);
});

test('only bounded native header evidence supplies a physical query version', async () => {
  const version = '00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:3';
  let header = version;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json(
    { boolean: true, graphVersion: 'untrusted body field' }, { headers: { 'x-rezics-graph-version': header } })) as typeof globalThis.fetch);
  restores.push(() => fetch.mockRestore());
  const graph = new FusekiClient('http://graph.invalid/rezics');
  expect(graphReadVersion(await graph.query('ASK {}'))).toBe(version);
  header = 'invalid';
  expect(graphReadVersion(await graph.query('ASK {}'))).toBeUndefined();
});
