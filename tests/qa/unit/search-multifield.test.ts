import { expect, test } from 'bun:test';
import { type FusekiClient, type SparqlResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import type { WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { queryPublicMainTitleBody }
  from '../../../services/main/src/modules/work/search-multifield.ts';
import { PublicQueryBudgetExceeded }
  from '../../../services/main/src/modules/work/search-budget.ts';
import { SearchIndexUnavailable }
  from '../../../services/main/src/modules/work/search-readiness.ts';
import { COMMAND_MODULE_VERSION } from '../../../services/main/src/infrastructure/profile.ts';

const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const value = (text: string) => ({ type: 'literal', value: text });

function fixture(titleCount = 1, titleReady = true) {
  const calls: string[] = [];
  const fuseki = { commandHealth: async () => ({ moduleVersion: COMMAND_MODULE_VERSION,
    profiles: {}, instanceId: '11111111-1111-4111-8111-111111111111',
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
    publicSearchDeltaAvailable: false }),
  query: async (sparql: string): Promise<SparqlResult> => {
    calls.push(sparql);
    if (sparql.includes('ASK {')) return { boolean: true };
    if (sparql.includes('?probeScore')) return { results: { bindings: [{
      epoch: value('epoch'), sequence: value('7'), generation: value(generation), population: value('1') }] } };
    if (sparql.includes('rv:publicTextInventory()')) return { results: { bindings: [{
      population: value('1'),
    }] } };
    if (sparql.includes('SELECT ?literal ?graph') && sparql.includes('rv:publicTitle')) {
      return { results: { bindings: titleReady ? [{ literal: value('标题检索验证'),
        graph: value('urn:rezics:search:probe') }] : [] } };
    }
    if (sparql.includes('?titleCount') && sparql.includes('text:query')) {
      return { results: { bindings: [{ epoch: value('epoch'), sequence: value('7'),
        indexGeneration: value(generation), titleCount: value(String(titleCount)),
        bodyCount: value('1'), unit: value(id(1)), titleScore: value('2.25'),
        bodyScore: value('3.5'), work: value(id(2)), main: value(id(3)),
        contribution: value(id(4)), revision: value(id(5)), selection: value(id(6)),
        language: value('zh') }] } };
    }
    throw new Error('unexpected title/body search query');
  } } as FusekiClient;
  const env = { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '/unused' } as WorkActivationEnvironment;
  return { calls, env };
}

test('SEARCH14: title/body binds one public unit, sums one score per field and ignores labels', async () => {
  const { calls, env } = fixture();
  const result = await queryPublicMainTitleBody(env,
    { titleTerm: '星海', bodyTerm: '中文', language: 'zh' });
  expect(result.total).toBe(1);
  expect(result.results[0]).toMatchObject({ work: id(2), mainVersion: id(3), score: 5.75 });
  const joined = calls.filter(query => query.includes('?titleCount') && query.includes('text:query'));
  expect(joined).toHaveLength(1);
  expect(joined[0]).toContain('(?unit ?titleScore) text:query (rv:publicTitle');
  expect(joined[0]).toContain('(?unit ?bodyScore) text:query (rv:searchBody');
  expect(joined[0]).not.toContain('rdfs:label');
});

test('SEARCH14/SEARCH10: the dedicated title field has its own typed raw-hit bound', async () => {
  const { env } = fixture(513);
  await expect(queryPublicMainTitleBody(env,
    { titleTerm: '星海', bodyTerm: '中文', language: 'zh' }))
    .rejects.toBeInstanceOf(PublicQueryBudgetExceeded);
});

test('SEARCH14: an unmapped title field cannot report a false complete empty relation', async () => {
  const { env } = fixture(0, false);
  await expect(queryPublicMainTitleBody(env,
    { titleTerm: '星海', bodyTerm: '中文', language: 'zh' }))
    .rejects.toBeInstanceOf(SearchIndexUnavailable);
});
