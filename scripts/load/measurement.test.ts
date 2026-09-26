import { expect, test } from 'bun:test';
import { startFusekiMeter } from './measurement.ts';

test('SEARCH18: movement hook runs before a public phrase query is forwarded', async () => {
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => new Response('ok') });
  const meter = startFusekiMeter(`http://127.0.0.1:${upstream.port}/rezics/`);
  let moved = 0;
  try {
    meter.beforeNextPhrase(async () => { moved++; });
    const response = await fetch(`${meter.url}query`, { method: 'POST',
      headers: { 'content-type': 'application/sparql-query' },
      body: 'SELECT ?candidateCount ?rawUnit WHERE { (?rawUnit ?score) text:query (rv:searchBody "move" 513) }' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(moved).toBe(1);
    expect(meter.snapshot().calls).toBe(1);
    expect(meter.snapshot().errors).toBe(0);
  } finally {
    await meter.stop();
    await upstream.stop(true);
  }
});
