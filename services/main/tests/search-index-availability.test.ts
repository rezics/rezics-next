import { expect, test } from 'bun:test';
import { FusekiClient, fusekiReadBudget, type SearchDeltaProof } from '../src/infrastructure/fuseki.ts';
import { assertPublicTextReady, MAX_SEARCH_REQUEST_MS, SearchIndexUnavailable,
  SearchRequestTimedOut, withStableSearchSnapshot } from '../src/modules/work/search-readiness.ts';

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
