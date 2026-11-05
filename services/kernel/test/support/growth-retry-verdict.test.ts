import { expect, test } from 'bun:test';
import { indexRetryRun } from './growth-attempt-index.ts';
import { classifySeries } from './growth-model.ts';
import type { StatementOccurrence } from './growth-report.ts';
import {
  isSuccessfulForegroundOccurrence,
  retainIndependentRetryViolation,
  retryAffectsOccurrence,
  successfulMetricEvidence,
  type RetryEvidenceSample,
} from './growth-retry-verdict.ts';
import { validateAttemptSamples, type AttemptRecord, type GrowthCheck, type ReportSample } from './growth.ts';

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

function occurrence(index: number, statement: string, extra: Partial<StatementOccurrence> = {}): StatementOccurrence {
  return {
    index,
    statement,
    backend: 10,
    error: null,
    plans: [],
    planDocuments: [],
    rows: 0,
    blocks: 0,
    ...extra,
  };
}

function mixedRun(scale: number): {
  statements: StatementOccurrence[];
  ledger: AttemptRecord[];
  cost: RetryEvidenceSample['cost'];
} {
  const statements = [
    occurrence(0, 'SELECT autocommit', { rows: 3, blocks: 2 }),
    occurrence(1, 'BEGIN'),
    occurrence(2, 'SELECT committed', { rows: 5, blocks: 4 }),
    occurrence(3, 'COMMIT'),
    occurrence(4, 'BEGIN'),
    occurrence(5, 'SELECT aborted', { rows: 7 * scale, blocks: 6 * scale }),
    occurrence(6, 'ROLLBACK'),
    occurrence(7, 'SELECT unknown', { rows: 11, blocks: 8, error: { code: '57014', message: 'cancelled' } }),
    occurrence(8, 'SELECT retry_error', {
      rows: 13,
      blocks: 9,
      error: { code: '40001', message: 'serialization failure' },
    }),
  ];
  const ledger: AttemptRecord[] = [
    { backend: 10, outcome: 'committed', statements: 1, occurrences: [1, 2, 3] },
    { backend: 10, outcome: 'aborted:40001', statements: 1, occurrences: [4, 5, 6] },
  ];
  return {
    statements,
    ledger,
    cost: {
      statements: 5,
      rows: 3 + 5 + 7 * scale + 11 + 13,
      blocks: 2 + 4 + 6 * scale + 8 + 9,
      catalogStatements: 0,
      failedStatements: { '57014': 1, '40001': 1 },
    },
  };
}

function mixedSample(scale: number): RetryEvidenceSample {
  const run = mixedRun(scale);
  return {
    scale,
    cost: run.cost,
    repetitions: [run.cost],
    occurrenceRepetitions: [{ statements: run.statements, backgroundStatements: [] }],
    attempts: { repetitions: [{ ledger: run.ledger }] },
  };
}

test('mixed successful, aborted and unknown work keeps autocommit costs and refuses bad attribution', () => {
  const run = mixedRun(1);
  const indexed = indexRetryRun(run.statements, run.ledger);
  expect(indexed.attribution).toEqual({ ok: true });
  expect(indexed.attemptByIndex.get(0)).toBeUndefined();
  expect(indexed.attemptByIndex.get(2)?.outcome).toBe('committed');
  expect(indexed.attemptByIndex.get(5)?.outcome).toBe('aborted:40001');
  expect(indexed.byStatement.get('SELECT committed')).toHaveLength(1);
  expect(isSuccessfulForegroundOccurrence(run.statements[0]!, run.ledger)).toBe(true);
  expect(isSuccessfulForegroundOccurrence(run.statements[2]!, run.ledger)).toBe(true);
  expect(isSuccessfulForegroundOccurrence(run.statements[5]!, run.ledger)).toBe(false);
  expect(isSuccessfulForegroundOccurrence(run.statements[7]!, run.ledger)).toBe(false);
  expect(retryAffectsOccurrence(run.statements[5]!, run.ledger)).toBe(true);
  expect(retryAffectsOccurrence(run.statements[8]!, run.ledger)).toBe(true);
  expect(retryAffectsOccurrence(run.statements[7]!, run.ledger)).toBe(false);

  const samples = [mixedSample(1), mixedSample(4), mixedSample(16)];
  expect(successfulMetricEvidence(samples, 'statements').values).toEqual([[2], [2], [2]]);
  expect(successfulMetricEvidence(samples, 'rows').values).toEqual([[8], [8], [8]]);
  expect(successfulMetricEvidence(samples, 'blocks').values).toEqual([[6], [6], [6]]);

  const withLedger = (ledger: AttemptRecord[]): RetryEvidenceSample => ({
    ...mixedSample(1),
    attempts: { repetitions: [{ ledger }] },
  });
  expect(
    successfulMetricEvidence([withLedger([{ ...run.ledger[0]!, occurrences: [1, 2, 3, 99] }])], 'rows').explanation,
  ).toContain('attempt occurrence without matching foreground attribution');
  expect(
    successfulMetricEvidence(
      [withLedger([run.ledger[0]!, { ...run.ledger[0]!, outcome: 'aborted:40001', occurrences: [2] }])],
      'rows',
    ).explanation,
  ).toContain('assigns an occurrence to multiple attempts');
  expect(successfulMetricEvidence([withLedger([{ ...run.ledger[0]!, backend: 20 }])], 'rows').explanation).toContain(
    'attempt occurrence without matching foreground attribution',
  );
});

function tracked<T>(items: T[]) {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    items: new Proxy(items, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    }),
  };
}

const attemptCheck = {
  name: 'retry index',
  bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
  attempts: { commands: 1 },
} as GrowthCheck;

function indexedReport(scale: number, statements: StatementOccurrence[], ledger: AttemptRecord[]): ReportSample {
  const rows = statements.reduce((sum, item) => sum + item.rows, 0);
  const blocks = statements.reduce((sum, item) => sum + item.blocks, 0);
  return {
    scale,
    cost: {
      statements: statements.length,
      rows,
      blocks,
      controlStatements: 0,
      catalogStatements: 0,
      plans: 0,
      sharedHit: 0,
      sharedRead: 0,
      relations: {},
    },
    repetitions: [],
    relationSizes: {},
    seeding: { statements: 0, rowsWritten: 0, growMs: 0, vacuumMs: 0, settleMs: 0 },
    statementRepetitions: [],
    occurrenceRepetitions: [{ statements, backgroundStatements: [] }],
    attempts: {
      commands: 1,
      byOutcome: {},
      attemptsPerCommand: ledger.length,
      repetitions: [{ byOutcome: {}, attemptsPerCommand: ledger.length, ledger }],
    },
  };
}

function shapeReads(shapeCount: number): number {
  const trackedRuns = [1, 4, 16].map((scale) => {
    const autocommit = occurrence(0, 'SELECT autocommit', { rows: 1, blocks: 1 });
    const aborted = occurrence(1, 'SELECT aborted', {
      rows: 1,
      blocks: 1,
      error: { code: '40001', message: 'serialization failure' },
    });
    const shapes = Array.from({ length: shapeCount }, (_, index) =>
      occurrence(2 + index, `SELECT shape_${index}`, { rows: 1, blocks: 1 }),
    );
    const statements = [autocommit, aborted, ...shapes];
    const ledger: AttemptRecord[] = [
      { backend: 10, outcome: 'committed', statements: shapeCount, occurrences: shapes.map((item) => item.index) },
      { backend: 10, outcome: 'aborted:40001', statements: 1, occurrences: [1] },
    ];
    const cost = {
      statements: shapeCount + 2,
      rows: shapeCount + 2,
      blocks: shapeCount + 2,
      catalogStatements: 0,
      failedStatements: { '40001': 1 },
    };
    return { scale, ledger, cost, tracked: tracked(statements) };
  });
  const evidenceSamples = trackedRuns.map(({ scale, ledger, cost, tracked: run }): RetryEvidenceSample => ({
    scale,
    cost,
    repetitions: [cost],
    occurrenceRepetitions: [{ statements: run.items, backgroundStatements: [] }],
    attempts: { repetitions: [{ ledger }] },
  }));
  for (const metric of ['rows', 'blocks', 'statements'] as const) successfulMetricEvidence(evidenceSamples, metric);
  validateAttemptSamples(
    attemptCheck,
    trackedRuns.map(({ scale, ledger, tracked: run }) => indexedReport(scale, run.items, ledger)),
  );
  return trackedRuns.reduce((sum, { tracked: run }) => sum + run.reads, 0);
}

test('indexes each measured run once across metrics and statement shapes', () => {
  const small = shapeReads(8);
  const large = shapeReads(32);
  expect(large).toBeLessThanOrEqual(small * 6);
});

test('an independent successful shape still violates while aborted work stays inconclusive', () => {
  const samples = [1, 4, 16].map((scale) => {
    const mixed = mixedRun(scale);
    const growing = occurrence(9, 'SELECT growing', { rows: scale === 1 ? 1 : scale === 4 ? 8 : 64, blocks: 1 });
    return indexedReport(scale, [...mixed.statements, growing], mixed.ledger);
  });
  expect(() => validateAttemptSamples(attemptCheck, samples)).toThrow(
    /statement SELECT growing rows violates constant growth bound/,
  );
});
