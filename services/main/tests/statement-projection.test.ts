import { expect, test } from 'bun:test';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { normalizeStatementSubject, StatementApplicabilityRefused } from '../src/modules/statement/projection.ts';
import type { ResolvedTarget } from '../src/modules/target/contract.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = (resource: string, types: string[]): ResolvedTarget => ({ resource, base: 'resource', types,
  work: null, revision: id(90), disclosure: 'restricted' });
function environment() {
  const fuseki = new FusekiClient('http://unused.invalid');
  fuseki.query = async () => ({ results: { bindings: [] } });
  return { fuseki, objectDirectory: '.temp/statement-test', lineage: { dataEpoch: '', routingEpoch: '' } } satisfies WorkActivationEnvironment;
}

async function refusal(applicability: string[], targets: ResolvedTarget[]) {
  try {
    await normalizeStatementSubject(environment(), { subject: id(1), applicability }, async () => true, async () => targets);
  } catch (error) {
    if (error instanceof StatementApplicabilityRefused) return { code: error.code, message: error.message };
    throw error;
  }
}

test('unreadable applicability answers exactly as unknown before any type-specific refusal', async () => {
  const unknown = await refusal([id(2)], []);
  expect(unknown?.code).toBe('statement_applicability_unknown');
  expect(await refusal([id(3), id(2)], [target(id(3), [`${RV}Character`])])).toEqual(unknown);
  expect(await refusal([id(2), id(3)], [target(id(3), [`${RV}Character`])])).toEqual(unknown);
});

test('the writer resolves one bounded coordinate batch and retains structural ownership', async () => {
  const batches: string[][] = [];
  const result = await normalizeStatementSubject(environment(), { subject: id(1), applicability: [id(2), id(3)] },
    async () => true, async references => {
      batches.push([...references]);
      return [target(id(2), [`${RV}NarrativeContinuity`]),
        { resource: id(3), base: 'release', types: [`${RV}Release`], work: id(4), revision: id(5), disclosure: 'public' }];
    });
  expect(batches).toEqual([[id(2), id(3)]]);
  expect(result).toEqual({ subject: id(1), applicability: [id(2), id(3)] });
});
