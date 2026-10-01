import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assemblerFacts, assertPinnedAssembler, PINNED_ANALYZER }
  from '../../../scripts/operations/search-state.ts';
import { TEXT_INDEX_PROFILE, TEXT_INDEX_PROBE_BODY, TEXT_INDEX_PROBE_QUERIES }
  from '../src/modules/work/activate.ts';
import { assertPublicTextReady, SearchIndexUnavailable }
  from '../src/modules/work/search-readiness.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';

test('G-585: every product/fault assembler and offline rebuild pin uses the folded analyzer', () => {
  for (const name of ['fuseki-text.ttl', 'fuseki-text-qa.ttl', 'fuseki-text-qa-raw.ttl']) {
    const facts = assemblerFacts(readFileSync(resolve(import.meta.dir, '../../../infra/jena', name), 'utf8'));
    expect(facts.analyzer).toBe('com.rezics.jena.FilteredGraphTextAssembler$CjkBigramV2');
    expect(() => assertPinnedAssembler(facts)).not.toThrow();
    expect(() => assertPinnedAssembler({ ...facts, analyzer: 'org.apache.lucene.analysis.cjk.CJKAnalyzer' })).toThrow();
  }
  expect(PINNED_ANALYZER).toEndWith('$CjkBigramV2');
  expect(TEXT_INDEX_PROFILE).toEndWith('search-index-cjk-bigram-v3');
});

test('G-585: native generation qualification alone cannot admit an older profile or missing folding witness', async () => {
  const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  const queries: string[] = [];
  const client = (probe: boolean) => ({
    commandHealth: async () => ({ instanceId: '11111111-1111-4111-8111-111111111111',
      textIndexUncertain: false, publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
      publicSearchDeltaAvailable: true }),
    searchDeltaSince: async () => ({ available: true, ordinal: '0', dataEpoch: 'epoch',
      sequence: '9', generation, writeEpoch: '0', luceneGeneration: '1', qualifiedPopulation: '1', deltas: [] }),
    query: async (query: string) => {
      queries.push(query);
      return { results: { bindings: probe ? [{ epoch: { value: 'epoch' }, sequence: { value: '9' },
        generation: { value: generation } }] : [] } };
    },
  }) as unknown as FusekiClient;
  await expect(assertPublicTextReady(client(false), lineage)).rejects.toBeInstanceOf(SearchIndexUnavailable);
  expect(await assertPublicTextReady(client(true), lineage)).toMatchObject({ generation, population: 1 });
  for (const query of queries) {
    expect(query).toContain(TEXT_INDEX_PROFILE);
    expect(query).toContain(TEXT_INDEX_PROBE_BODY);
    for (const term of TEXT_INDEX_PROBE_QUERIES) expect(query).toContain(JSON.stringify(`"${term}"`));
    expect(query.match(/text:query/g)).toHaveLength(TEXT_INDEX_PROBE_QUERIES.length);
    expect(query).not.toMatch(/COUNT\(|body:\*/);
  }
});
