import { expect, test } from 'bun:test';
import { assertPublicTextReady, SearchIndexUnavailable, SearchIndexUncertain,
  SearchSnapshotMoved } from '../src/modules/work/search-readiness.ts';
import type { FusekiClient, SearchDeltaProof } from '../src/infrastructure/fuseki.ts';

const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
const instanceId = '11111111-1111-4111-8111-111111111111';
const binding = (value: string) => ({ type: 'literal', value });
function fixture(options: { population?: string; unavailable?: boolean; uncertain?: boolean; moved?: boolean } = {}) {
  const queries: string[] = [];
  let healthCalls = 0;
  const client = {
    commandHealth: async () => ({ instanceId, textIndexUncertain: options.uncertain,
      publicSearchWriteEpoch: options.moved && ++healthCalls > 1 ? '2' : '0',
      publicSearchWriteActive: false, publicSearchDeltaAvailable: true }),
    searchDeltaSince: async (since: string): Promise<SearchDeltaProof> => {
      expect(since).toBe('-1');
      return options.unavailable ? { available: false } : { available: true, ordinal: '0',
        dataEpoch: lineage.dataEpoch, sequence: '9', generation, writeEpoch: '0',
        luceneGeneration: '1', qualifiedPopulation: options.population ?? '20005', deltas: [] };
    },
    query: async (query: string) => {
      queries.push(query);
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding('9'),
        generation: binding(generation) }] } };
    },
  } as unknown as FusekiClient;
  return { client, queries };
}

test('G-556: a catalogue above 20,000 uses a bounded native generation proof', async () => {
  const { client, queries } = fixture();
  for (let n = 0; n < 3; n++) expect((await assertPublicTextReady(client, lineage)).population).toBe(20_005);
  expect(queries).toHaveLength(3);
  expect(queries.every(query => !/COUNT\(|body:\*|20001/.test(query))).toBe(true);
});

test('G-556: unavailable, corrupt and uncertain qualifications remain closed', async () => {
  await expect(assertPublicTextReady(fixture({ unavailable: true }).client, lineage))
    .rejects.toBeInstanceOf(SearchIndexUnavailable);
  await expect(assertPublicTextReady(fixture({ population: '-1' }).client, lineage))
    .rejects.toBeInstanceOf(SearchIndexUnavailable);
  await expect(assertPublicTextReady(fixture({ uncertain: true }).client, lineage))
    .rejects.toBeInstanceOf(SearchIndexUncertain);
  await expect(assertPublicTextReady(fixture({ moved: true }).client, lineage))
    .rejects.toBeInstanceOf(SearchSnapshotMoved);
});
