import { expect, test } from 'bun:test';
import { classifySeries } from './growth-model.ts';
import type { StatementOccurrence } from './growth-report.ts';
import {
  retainIndependentRetryViolation,
  successfulMetricEvidence,
  type RetryEvidenceSample,
} from './growth-retry-verdict.ts';

function sample(scale: number, successfulCount: number): RetryEvidenceSample {
  const statements: StatementOccurrence[] = Array.from({ length: successfulCount }, (_, index) => ({
    index,
    statement: 'SELECT $1::integer',
    backend: 10,
    error: null,
    plans: [],
    planDocuments: [],
    rows: 0,
    blocks: 0,
  }));
  statements.push({
    index: successfulCount,
    statement: 'SELECT unrelated_retry()',
    backend: 10,
    error: { code: '40001', message: 'serialization failure' },
    plans: [],
    planDocuments: [],
    rows: 0,
    blocks: 0,
  });
  const cost = {
    statements: statements.length,
    rows: 0,
    blocks: 0,
    catalogStatements: 0,
    failedStatements: { '40001': 1 },
  };
  return {
    scale,
    cost,
    repetitions: [cost],
    occurrenceRepetitions: [{ statements, backgroundStatements: [] }],
  };
}

test('unrelated retries preserve successful growth and unresolved attribution stays inconclusive', () => {
  const samples = [sample(1, 1), sample(4, 4), sample(16, 16)];
  const evidence = successfulMetricEvidence(samples, 'statements');
  expect(evidence.values).toEqual([[1], [4], [16]]);
  const classification = classifySeries(
    samples.map(({ scale }, index) => ({ scale, repetitions: evidence.values![index]!, uncertainty: 0 })),
    'constant',
  );
  expect(classification.outcome).toBe('violation');
  expect(retainIndependentRetryViolation(classification.outcome, '')).toEqual({ outcome: 'violation' });

  const unresolved = successfulMetricEvidence(samples, 'requestBytes');
  expect(unresolved.explanation).toContain('per-occurrence requestBytes evidence is not retained');
  expect(retainIndependentRetryViolation(undefined, unresolved.explanation!)).toMatchObject({
    outcome: 'inconclusive',
    reason: 'retries',
    explanation: expect.stringContaining('requestBytes'),
  });
});
