import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { replacementContribution, selectedBody, uniqueToken, writerCohorts, writerIndex }
  from '../../../scripts/load/corpus.ts';
import { fusekiImageFromCompose } from '../../../scripts/load/image.ts';
import { delta, percentile, relayBacklogTrend, selectPhraseQuery, startFusekiMeter }
  from '../../../scripts/load/measurement.ts';

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

test('OPS05: query plan parser follows the active Fuseki Compose image', () => {
  expect(fusekiImageFromCompose(`services:\n  postgres:\n    image: postgres:18\n  fuseki:\n    image: rezics/fuseki:6.2.0-cmd0.5.9\n  rustfs:\n    image: rustfs:1\n`))
    .toEqual({ image: 'rezics/fuseki:6.2.0-cmd0.5.9', jenaVersion: '6.2.0' });
  expect(() => fusekiImageFromCompose(`services:\n  postgres:\n    image: rezics/fuseki:6.2.0-cmd0.5.9\n  fuseki:\n    build: .\n`))
    .toThrow('Pinned Fuseki Compose image');
  expect(fusekiImageFromCompose(readFileSync(new URL('../../../infra/dev/compose.yaml', import.meta.url), 'utf8'))
    .image).toMatch(/^rezics\/fuseki:6\.2\.0-cmd/);
});

test('SEARCH18: plan capture selects the lane phrase query after readiness probes', () => {
  const probe = 'SELECT ?epoch WHERE { (?probe ?score) text:query (rv:searchBody "x" 2) }';
  const phrase = 'SELECT ?candidateCount ?unit WHERE { SELECT (COUNT(?rawUnit) AS ?candidateCount) WHERE { (?rawUnit ?score) text:query (rv:searchBody "x" 513) } }';
  expect(selectPhraseQuery([{ sparql: probe }, { sparql: phrase }])).toBe(phrase);
  expect(() => selectPhraseQuery([{ sparql: probe }])).toThrow('No public phrase candidate query');
});

test('OPS05: 10k writers split hot and cold Works; 10-Work diagnostic stays cold', () => {
  const indices = Array.from({ length: 9_995 }, (_, offset) => offset + 4)
    .filter(index => index !== 7);
  const own = writerCohorts(indices.filter((_, offset) => offset % 2 === 0), 1_000);
  const choices = Array.from({ length: 200 }, (_, iteration) => writerIndex(own, iteration));
  expect(choices.filter(choice => choice.hot).length).toBe(100);
  expect(choices.filter(choice => !choice.hot).length).toBe(100);
  expect(choices.filter((choice, iteration) => iteration % 20 === 0 && choice.hot).length).toBe(5);
  expect(choices.filter((choice, iteration) => iteration % 20 === 10 && choice.hot).length).toBe(5);
  expect(choices.every(choice => choice.hot === (choice.index < 1_000))).toBe(true);
  const diagnostic = writerCohorts([4, 6, 9], 1);
  expect(diagnostic.hot).toEqual([]);
  expect(writerIndex(diagnostic, 1)).toEqual({ index: 6, hot: false });
});

test('OPS05: temporary relay spike drains while a growing end backlog fails', () => {
  expect(relayBacklogTrend([0, 1, 0, 12, 9, 3, 1, 0, 0]).growingAtEnd).toBe(false);
  expect(relayBacklogTrend([0, 0, 1, 2, 3, 4, 5, 6, 7]).growingAtEnd).toBe(true);
  expect(relayBacklogTrend([0, 1, 0, 1, 2, 1, 2, 1, 2]).growingAtEnd).toBe(false);
});
