import { expect, test } from 'bun:test';
import { protectClassifiedResults, type SearchRouteDependencies }
  from '../../../services/main/src/routes/search.ts';
import { PublicQueryUnavailable }
  from '../../../services/main/src/modules/work/search-budget.ts';
import type { JudgmentContext } from '../../../services/main/src/modules/judgment/schema.ts';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

test('SEARCH01/SEARCH10: exact supports check separate Realm and Global judgment populations', async () => {
  const calls: Array<{ statement: string; context: JudgmentContext; concept: string | null }> = [];
  const work = { judgments: { protectionCheck: async (statement: string,
    context: JudgmentContext, concept: string | null) => {
    calls.push({ statement, context, concept });
    return { statement, context, generation: '3', policyGeneration: 'wilson-v1' as const,
      conceptHint: 'unknown' as const, conceptHintGeneration: '5', sourceEvent: id(9),
      protection: (statement === id(1) ? 'show-all' : 'hide-major') as 'show-all' | 'hide-major',
      status: 'unknown' as const,
      distribution: { notSpoiler: 0, minorSpoiler: 0, majorSpoiler: 0 }, sampleSize: 0 };
  } } } as unknown as SearchRouteDependencies;
  const relation = { total: 2, results: [
    { classification: { meaningKey: 'urn:rezics:meaning:a', concept: id(3),
      supportingStatements: [id(1)], source: 'local' } },
    { classification: { meaningKey: 'urn:rezics:meaning:b', concept: id(4),
      supportingStatements: [id(2)], source: 'inherited-global' } },
  ] };
  const result = await protectClassifiedResults(work, relation, id(7));
  expect(calls).toEqual([
    { statement: id(1), context: { kind: 'realm', realm: id(7) }, concept: id(3) },
    { statement: id(2), context: { kind: 'global' }, concept: id(4) },
  ]);
  expect(result.total).toBe(1);
  expect(result.results[0]?.classification).toMatchObject({ supportingStatementCount: 1,
    supportingStatements: [id(1)], protectionChecks: [{
    statement: id(1), context: { kind: 'realm', realm: id(7) }, generation: '3',
    conceptHintGeneration: '5', policyGeneration: 'wilson-v1', sourceEvent: id(9),
    protection: 'show-all',
  }] });
  expect(result.results[1]).toBeUndefined();
});

test('SEARCH10: classified search fails closed when exact protection is unavailable', async () => {
  const relation = { total: 1, results: [{ classification: { meaningKey: 'urn:rezics:meaning:a',
    concept: id(3), supportingStatements: [id(1)], source: 'global' } }] };
  await expect(protectClassifiedResults({} as SearchRouteDependencies, relation))
    .rejects.toBeInstanceOf(PublicQueryUnavailable);
  const work = { judgments: { protectionCheck: async () => { throw new Error('Access unavailable'); } } } as
    unknown as SearchRouteDependencies;
  await expect(protectClassifiedResults(work, relation))
    .rejects.toBeInstanceOf(PublicQueryUnavailable);
});
