import { expect, test } from 'bun:test';
import { type FusekiClient, type SparqlResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import type { WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { queryPublicRealmClassifiedRatedPhrase }
  from '../../../services/main/src/modules/work/search-joined.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable }
  from '../../../services/main/src/modules/work/search-public.ts';
import { COMMAND_MODULE_VERSION } from '../../../services/main/src/infrastructure/profile.ts';

const id = (number: number) => `https://rezics.com/id/${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const value = (item: string) => ({ type: 'literal', value: item });

function fixture(candidateCount = 1, includeMatch = true, hiddenPin = false) {
  const calls: string[] = [];
  const fuseki = { commandHealth: async () => ({ moduleVersion: COMMAND_MODULE_VERSION,
    profiles: {}, instanceId: '11111111-1111-4111-8111-111111111111',
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
    publicSearchDeltaAvailable: false }),
  query: async (sparql: string): Promise<SparqlResult> => {
    calls.push(sparql);
    if (sparql.includes('ASK {')) return { boolean: true };
    if (sparql.includes('?probeScore')) return { results: { bindings: [{
      epoch: value('epoch'), sequence: value('7'), generation: value(generation) }] } };
    if (sparql.includes('"body:*"')) return { results: { bindings: [{
      epoch: value('epoch'), sequence: value('7'), generation: value(generation),
      population: value('1'), indexed: value('1'), uniqueIndexed: value('1'), valid: value('1'),
    }] } };
    if (sparql.includes('VALUES (?main ?key ?decision ?context)')) {
      return { results: { bindings: [{ epoch: value('epoch'), sequence: value('7'),
        main: value(id(2)), decision: value(id(6)), support: value(id(10)),
        ...(hiddenPin ? { pin: value(id(12)), pinContext: value(id(13)),
          pinDisclosure: value('https://rezics.com/vocab/Private') } : {}) }] } };
    }
    if (sparql.includes('?ratingPopulation') && sparql.includes('text:query')) {
      return { results: { bindings: [{
        epoch: value('epoch'), sequence: value('7'), indexGeneration: value(generation),
        candidateCount: value(String(candidateCount)), ratingPopulation: value('3'),
        ratingRows: value('3'), ratingUniqueSlots: value('3'), ratingValidRows: value('3'),
        ...(includeMatch ? { unit: value('urn:rezics:match:one'), score: value('2'),
          work: value(id(1)), main: value(id(2)), contribution: value(id(3)),
          revision: value(id(4)), selection: value(id(5)), language: value('zh'),
          reason: value('main-fallback'), decision: value(id(6)),
          source: value('inherited-global'), sourceContext: value(id(7)),
          key: value(`urn:rezics:meaning:${'a'.repeat(64)}`),
          concept: value(id(11)),
          ratingCount: value('2'), ratingSum: value('16'),
          ratingTargetPopulation: value('2') } : {}),
      }] } };
    }
    throw new Error('unexpected Statement search query');
  } } as FusekiClient;
  const env = { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '/unused' } as WorkActivationEnvironment;
  const input = { context: { kind: 'realm-local' as const, id: id(7) },
    phrase: '中文词组', language: 'zh', sense: id(8), ratingContext: id(9),
    minimumMeanTimes10: 80 };
  return { calls, env, input };
}

test('SEARCH01/SEARCH04: Statement, text and rating use one joined relation request', async () => {
  const { calls, env, input } = fixture();
  const result = await queryPublicRealmClassifiedRatedPhrase(env, input);
  expect(result.complete).toBe(true);
  expect(result.total).toBe(1);
  expect(result.results[0]).toMatchObject({ score: 2,
    classification: { application: null, source: 'inherited-global',
      supportingStatements: [id(10)] },
    rating: { count: 2, sum: 16, precision: { numerator: 16, denominator: 2 } } });
  const joined = calls.filter(query => query.includes('?ratingPopulation')
    && query.includes('text:query'));
  expect(joined).toHaveLength(1);
  expect(joined[0]).toContain('rv:DecisionSlot');
  expect(joined[0]).toContain('rv:interpretationDefinition ?senseRevision');
  expect(joined[0]).toContain('COUNT(?observation) AS ?ratingTargetPopulation');
  expect(joined[0]).not.toContain('rv:ClassificationApplication');
});

test('SEARCH04/SEARCH10: raw candidate overflow remains a typed budget outcome', async () => {
  const { env, input } = fixture(513, false);
  await expect(queryPublicRealmClassifiedRatedPhrase(env, input))
    .rejects.toBeInstanceOf(PublicQueryBudgetExceeded);
});

test('SEARCH01/SEARCH10: a private supporting Context cannot qualify a public fact', async () => {
  const { env, input } = fixture(1, true, true);
  await expect(queryPublicRealmClassifiedRatedPhrase(env, input))
    .rejects.toBeInstanceOf(PublicQueryUnavailable);
});
