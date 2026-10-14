import { expect, test } from 'bun:test';
import { FusekiClient, fusekiReadBudget, type SearchDeltaProof } from '../src/infrastructure/fuseki.ts';
import { assertPublicTextReady, MAX_SEARCH_REQUEST_MS, SearchIndexUnavailable,
  SearchRequestTimedOut, withStableSearchSnapshot } from '../src/modules/work/search-readiness.ts';
import { readRankedCatalogue } from '../src/modules/search/ranked.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { withSearchGraphSnapshot } from '../src/modules/search/snapshot.ts';

const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const term = (value: string) => ({ type: 'literal', value });

function indexed(sequence: string, epoch = lineage.dataEpoch) {
  const client = new FusekiClient('http://unused.invalid');
  let proofs = 0;
  client.commandHealth = async () => ({ moduleVersion: 'test', profiles: {},
    instanceId: '11111111-1111-4111-8111-111111111111',
    publicSearchWriteEpoch: '2', publicSearchWriteActive: false, publicSearchDeltaAvailable: true });
  client.query = async () => ({ results: { bindings: [{ epoch: term(lineage.dataEpoch),
    sequence: term('25'), generation: term(generation) }] } });
  client.searchDeltaSince = async (): Promise<SearchDeltaProof> => {
    proofs++;
    return { available: true, ordinal: '1', dataEpoch: epoch, sequence, generation,
      writeEpoch: '2', luceneGeneration: '3', qualifiedPopulation: '3', deltas: [] };
  };
  return { client, proofs: () => proofs };
}

test('ready public search consumes a checkpoint in the publication epoch and sequence', async () => {
  const fixture = indexed('25');
  expect(await assertPublicTextReady(fixture.client, lineage)).toMatchObject({
    dataEpoch: lineage.dataEpoch, sequence: '25', population: 3, generation });
  expect(fixture.proofs()).toBe(1);
});

test('a behind or foreign-epoch checkpoint refuses public membership without retry', async () => {
  for (const fixture of [indexed('24'), indexed('25', 'old-epoch')]) {
    await expect(withStableSearchSnapshot(fixture.client,
      () => assertPublicTextReady(fixture.client, lineage))).rejects.toBeInstanceOf(SearchIndexUnavailable);
    expect(fixture.proofs()).toBe(1);
  }
});

test('public search cancels unfinished work at its original wall bound without another attempt', async () => {
  let attempts = 0, cancelled = false;
  const started = performance.now();
  await expect(withStableSearchSnapshot(undefined, () => {
    attempts++;
    const budget = fusekiReadBudget.getStore()!;
    expect(budget.deadline! - performance.now()).toBeLessThanOrEqual(MAX_SEARCH_REQUEST_MS);
    return new Promise<never>((_resolve, reject) => {
      budget.signal.addEventListener('abort', () => { cancelled = true; reject(budget.signal.reason); }, { once: true });
    });
  })).rejects.toBeInstanceOf(SearchRequestTimedOut);
  expect(performance.now() - started).toBeGreaterThanOrEqual(MAX_SEARCH_REQUEST_MS - 10);
  expect(cancelled).toBe(true);
  expect(attempts).toBe(1);
});

test('one delivered catalogue slot admits only one initial index candidate to audience disclosure', async () => {
  const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const hits = Array.from({ length: 3 }, (_, n) => ({ id: `urn:rezics:unit:${n}`, key: id(n), score: '1' }));
  for (const population of [6, 22, 70]) {
    const client = new FusekiClient('http://unused.invalid');
    let candidates = 0;
    client.query = async sparql => {
      if (sparql.includes('rv:rankedText')) {
        const size = Number(/rv:rankedText\(rv:searchBody, "[^"]+", (\d+)/u.exec(sparql)![1]);
        return { results: { bindings: [{ epoch: term('epoch'), sequence: term('25'), generation: term(generation),
          page: term(JSON.stringify({ hits: hits.slice(0, size), commit: '7', more: size < hits.length })) }] } };
      }
      const units = [...sparql.matchAll(/<(urn:rezics:unit:\d+)>/gu)].map(match => match[1]!);
      return { results: { bindings: units.map(unit => ({ unit: term(unit), work: term(id(Number(unit.split(':').at(-1)))),
        main: term(id(Number(unit.split(':').at(-1)))), contribution: term(id(10)), revision: term(id(11)),
        selection: term(id(12)), language: term('en') })) } };
    };
    const env = { fuseki: client, lineage, objectDirectory: '.temp/search-availability-owner' };
    const position = { dataEpoch: lineage.dataEpoch, sequence: '25', generation, population,
      serverInstanceId: '11111111-1111-4111-8111-111111111111', publicSearchWriteEpoch: '2' };
    const page = await searchGraphSnapshot.run({ clients: new Set([client]), lineage, position },
      () => readRankedCatalogue(env, { phrase: 'needle story', language: null, pageSize: 1 }, async rows => {
        candidates += rows.length;
        return rows;
      }));
    expect(candidates).toBe(1);
    expect(page.results.map(row => row.work)).toEqual([id(0)]);
    expect(page.count).toEqual({ value: 1, precision: 'lower-bound' });
    expect(page.next).not.toBeNull();
  }
});

// The HTTP capture reached its final health call after the wall deadline while
// the event-loop timer was still pending. No new fence read may start there.
test('the search owner starts no graph fence after its deadline even before the abort timer runs', async () => {
  const fixture = indexed('25');
  let fences = 0;
  const original = fixture.client.query.bind(fixture.client);
  fixture.client.query = async (...args) => {
    if (args[0].includes('LIMIT 2')) fences++;
    return original(...args);
  };
  const controller = new AbortController();
  const budget = { signal: controller.signal, callsLeft: 72, bytesLeft: 8_388_608, deadline: Infinity };
  await expect(fusekiReadBudget.run(budget, () => withSearchGraphSnapshot(
    { fuseki: fixture.client, lineage, objectDirectory: '.temp/search-availability-owner' }, async () => {
      budget.deadline = performance.now() - 1;
      return { results: [] };
    }))).rejects.toBeInstanceOf(SearchRequestTimedOut);
  expect(controller.signal.aborted).toBe(false);
  expect(fences).toBe(0);
});
