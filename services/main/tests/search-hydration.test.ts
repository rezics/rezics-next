import { expect, test } from 'bun:test';
import { FusekiClient, fusekiReadBudget, type FusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { boundedSearchHydration, SEARCH_HYDRATION_FENCE_MS } from '../src/modules/search/hydration.ts';

test('a held card transport is aborted before the search deadline, leaving the shared allocation usable by final fences', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const payload = JSON.stringify({ results: { bindings: [] } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if ((await request.text()).includes('held')) await held;
    return new Response(payload, { headers: { 'content-type': 'application/json' } });
  } });
  try {
    const client = new FusekiClient(`${server.url}rezics`);
    const outer: FusekiReadBudget = { signal: new AbortController().signal, callsLeft: 5, bytesLeft: 100_000,
      deadline: performance.now() + SEARCH_HYDRATION_FENCE_MS + 100 };
    let child: FusekiReadBudget | undefined;
    await fusekiReadBudget.run(outer, async () => {
      expect(await boundedSearchHydration(async () => {
        child = fusekiReadBudget.getStore();
        return client.query('SELECT ?held WHERE {}');
      })).toBeNull();
      expect(child!.signal.aborted).toBe(true);
      expect(outer.signal.aborted).toBe(false);
      expect(outer.deadline! - performance.now()).toBeGreaterThan(100);
      await client.query('SELECT ?fence WHERE {}');
    });
    expect(outer.callsLeft).toBe(3);
    expect(outer.bytesLeft).toBe(100_000 - Buffer.byteLength(payload));
  } finally { release(); await server.stop(true); }
});

test('completed cards retain their value and owner failures remain failures', async () => {
  const budget: FusekiReadBudget = { signal: new AbortController().signal, callsLeft: 5, bytesLeft: 100_000,
    deadline: performance.now() + 1_500 };
  await fusekiReadBudget.run(budget, async () => {
    expect(await boundedSearchHydration(async () => 'card')).toBe('card');
    const failure = new Error('owner unavailable');
    await expect(boundedSearchHydration(async () => { throw failure; })).rejects.toBe(failure);
  });
});
