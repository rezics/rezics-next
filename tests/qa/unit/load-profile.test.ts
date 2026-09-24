import { expect, test } from 'bun:test';
import { replacementContribution, selectedBody, uniqueToken } from '../../../scripts/load/corpus.ts';
import { delta, percentile, startFusekiMeter } from '../../../scripts/load/measurement.ts';

test('OPS05/SEARCH18: ten thousand deterministic terms stay distinct and bounded', () => {
  const terms = Array.from({ length: 10_000 }, (_, index) => uniqueToken(index));
  expect(new Set(terms).size).toBe(10_000);
  expect(terms.every(term => /^loadtoken[a-z]{4}$/.test(term))).toBe(true);
  expect(() => uniqueToken(26 ** 4)).toThrow();
  expect(selectedBody(uniqueToken(17), 0)).not.toContain(uniqueToken(0));
  for (const language of ['en', 'zh', 'ja']) {
    const replacement = replacementContribution({ work: 'work', token: uniqueToken(108), language }, 4);
    expect(replacement.language).toBe(language);
    expect(replacement.body).toContain(uniqueToken(108));
  }
});

test('OPS05/SEARCH18: call and latency evidence counts all attempts', () => {
  expect(delta({ calls: 9, sentBytes: 440, receivedBytes: 660, errors: 2 },
    { calls: 3, sentBytes: 100, receivedBytes: 200, errors: 1 }))
    .toEqual({ calls: 6, sentBytes: 340, receivedBytes: 460, errors: 1 });
  expect(percentile([10, 200, 30, 40, 50], 0.95)).toBe(200);
  expect(percentile([], 0.95)).toBeNull();
});

test('SEARCH18: meter captures the product query sent to Fuseki and counts wire bodies', async () => {
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => Response.json({ boolean: true }) });
  const meter = startFusekiMeter(`http://127.0.0.1:${upstream.port}/rezics/`);
  try {
    meter.beginCapture();
    const sparql = 'ASK { ?s ?p ?o }';
    const result = await fetch(`${meter.url}query`, { method: 'POST',
      headers: { 'content-type': 'application/sparql-query' }, body: sparql });
    expect(result.status).toBe(200);
    const bytes = await result.arrayBuffer();
    expect(meter.endCapture()).toEqual([{ path: '/rezics/query', sparql }]);
    expect(meter.snapshot()).toEqual({ calls: 1, sentBytes: sparql.length,
      receivedBytes: bytes.byteLength, errors: 0 });
  } finally {
    meter.stop();
    upstream.stop(true);
  }
});
