import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { replacementContribution, selectedBody, uniqueToken, writerCohorts, writerIndex }
  from '../../../scripts/load/corpus.ts';
import { fusekiImageFromCompose } from '../../../scripts/load/image.ts';
import { PRACTICAL_PROFILE_TIMEOUT_MS } from '../../../scripts/load/budget.ts';
import { delta, laneReadLatencies, laneReadP95Within, parseCgroupMemory, percentile,
  relayBacklogTrend, searchProofDelta, selectPhraseQuery,
  startFusekiMeter }
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

test('OPS05: practical profile budget covers the measured seed, mix and restart reserve', () => {
  const measuredSeedMs = 9_974_125;
  const mixMs = 180_000;
  const restartReserveMs = 20 * 60_000;
  expect(PRACTICAL_PROFILE_TIMEOUT_MS)
    .toBeGreaterThan(measuredSeedMs + mixMs + restartReserveMs);
});

test('OPS05/SEARCH18: call and latency evidence counts all attempts', () => {
  expect(delta({ calls: 9, sentBytes: 440, receivedBytes: 660, errors: 2 },
    { calls: 3, sentBytes: 100, receivedBytes: 200, errors: 1 }))
    .toEqual({ calls: 6, sentBytes: 340, receivedBytes: 460, errors: 1 });
  expect(percentile([10, 200, 30, 40, 50], 0.95)).toBe(200);
  expect(percentile([], 0.95)).toBeNull();
});

test('OPS05/SEARCH18: lane latency evidence includes Content and rejects absent samples', () => {
  const metrics = Object.fromEntries((['main', 'realm', 'content'] as const).flatMap(lane => [
    [`practical_${lane}_reads`, {count: 12}],
    [`practical_${lane}_read_ms`, {'p(95)': 95, 'p(99)': 113}],
  ]));
  const lanes = laneReadLatencies(metrics);
  expect(lanes.content).toEqual({reads: 12, p95Ms: 95, p99Ms: 113});
  expect(laneReadP95Within(lanes, 1500)).toBe(true);
  expect(laneReadP95Within({...lanes, content: {...lanes.content, p95Ms: 1501}}, 1500)).toBe(false);
  delete metrics.practical_content_read_ms;
  expect(() => laneReadLatencies(metrics)).toThrow('content public read latency evidence missing');
});

test('OPS05: cgroup memory evidence separates anonymous pages from file cache', () => {
  expect(parseCgroupMemory('900\n1500\nmax\nanon 400\nfile 450\nfile_mapped 20\n'))
    .toEqual({currentBytes: 900, peakBytes: 1500, limitBytes: null,
      anonBytes: 400, fileBytes: 450});
  expect(() => parseCgroupMemory('900\n1500\nmax\nanon 400\n'))
    .toThrow('invalid container memory counter');
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

test('SEARCH07: meter distinguishes native delta proof from full index inventory', async () => {
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: request => Response.json({ available: new URL(request.url).searchParams.has('deltaSince') }) });
  const meter = startFusekiMeter(`http://127.0.0.1:${upstream.port}/rezics/`);
  try {
    const before = meter.searchProofSnapshot();
    await fetch(`${meter.url}query`, { method: 'POST',
      body: 'SELECT (COUNT(?indexedUnit) AS ?indexed) WHERE { "body:*" }' });
    await fetch(`${meter.url}command?deltaSince=4`);
    expect(searchProofDelta(meter.searchProofSnapshot(), before)).toEqual({
      fullInventories: 1, deltaRequests: 1, deltaAvailable: 1, deltaUnavailable: 0,
    });
  } finally { meter.stop(); upstream.stop(true); }
});

test('OPS05: query plan parser follows the active Fuseki Compose image', () => {
  expect(fusekiImageFromCompose(`services:\n  postgres:\n    image: postgres:18\n  fuseki:\n    image: rezics/fuseki:6.2.0-cmd0.5.12\n  rustfs:\n    image: rustfs:1\n`))
    .toEqual({ image: 'rezics/fuseki:6.2.0-cmd0.5.12', jenaVersion: '6.2.0' });
  expect(() => fusekiImageFromCompose(`services:\n  postgres:\n    image: rezics/fuseki:6.2.0-cmd0.5.12\n  fuseki:\n    build: .\n`))
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
