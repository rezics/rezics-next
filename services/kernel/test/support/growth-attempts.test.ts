import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  checkGrowth,
  openGrowthDatabase,
  readAttemptLedger,
  validateAttemptSamples,
  type AttemptRecord,
  type AttemptSample,
  type GrowthCheck,
  type GrowthDatabase,
  type ReportSample,
} from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
});
afterAll(async () => {
  await db?.close();
});

function attempt(outcome: AttemptRecord['outcome'], statements: number, occurrences: number[] = []): AttemptRecord {
  return { backend: 100, outcome, statements, occurrences };
}

function reportSample(
  scale: number,
  attemptsByRun: AttemptRecord[][],
  rows = 1,
  inclusiveStatements = 9,
): ReportSample {
  const runs = attemptsByRun.map((ledger) => ({
    byOutcome: Object.fromEntries(
      ledger.reduce(
        (counts, item) => counts.set(item.outcome, (counts.get(item.outcome) ?? 0) + 1),
        new Map<string, number>(),
      ),
    ),
    attemptsPerCommand: ledger.length,
    ledger,
  }));
  const attempts: AttemptSample = {
    commands: 1,
    byOutcome: {},
    attemptsPerCommand: runs.reduce((sum, item) => sum + item.attemptsPerCommand, 0) / runs.length,
    repetitions: runs,
  };
  return {
    scale,
    cost: {
      statements: inclusiveStatements,
      rows,
      blocks: 1,
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
    occurrenceRepetitions: [
      {
        statements: [{ index: 0, statement: 'SELECT 1', backend: 100, error: null, plans: [], rows, blocks: 1 }],
        backgroundStatements: [],
      },
    ],
    attempts,
  };
}

const attemptCheck = {
  name: 'attempt fixture',
  bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
  attempts: { commands: 1 },
} as GrowthCheck;

test('a check with concurrent commands reports outcomes per run and preserves inclusive totals', async () => {
  const report = await checkGrowth(db, {
    name: 'concurrent attempt ledger',
    scales: [1, 4, 16],
    repetitions: 1,
    warmups: 1,
    attempts: { commands: 2 },
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {},
    operation: async (growthDb) =>
      Promise.all(
        Array.from({ length: 2 }, () =>
          growthDb.pool.connect().then(async (client) => {
            try {
              await client.query('BEGIN');
              await client.query('SELECT 1');
              await client.query('COMMIT');
            } finally {
              client.release();
            }
          }),
        ),
      ),
  });

  expect(report.samples.every(({ attempts }) => attempts?.commands === 2)).toBe(true);
  expect(report.samples.every(({ attempts }) => attempts?.byOutcome.committed === 2)).toBe(true);
  expect(report.samples[0]?.cost.statements).toBe(2);
});

test('serialization retries may vary while committed statement work and inclusive totals remain visible', () => {
  const samples = [
    reportSample(1, [[attempt('aborted:40001', 1), attempt('committed', 1)], [attempt('committed', 1)]], 1, 5),
    reportSample(4, [[attempt('committed', 1)], [attempt('aborted:40001', 1), attempt('committed', 1)]], 1, 6),
    reportSample(16, [[attempt('committed', 1)], [attempt('committed', 1)]], 1, 7),
  ];
  expect(() => validateAttemptSamples(attemptCheck, samples)).not.toThrow();
  expect(samples.map(({ cost }) => cost.statements)).toEqual([5, 6, 7]);
});

test('a committed attempt statement-count change fails with the attempt and counts', () => {
  const samples = [
    reportSample(1, [[attempt('committed', 1)]]),
    reportSample(4, [[attempt('committed', 2)]]),
    reportSample(16, [[attempt('committed', 1)]]),
  ];
  expect(() => validateAttemptSamples(attemptCheck, samples)).toThrow(/committed attempt.*statement counts differ/);
});

test('attempts per command growing by scale fails with its per-scale series', () => {
  const samples = [1, 4, 16].map((scale, index) =>
    reportSample(scale, [
      [...Array.from({ length: index }, () => attempt('aborted:40001', 1)), attempt('committed', 1)],
    ]),
  );
  expect(() => validateAttemptSamples(attemptCheck, samples)).toThrow(/attempts per command grew with scale/);
});

test('rows per execution of a statement fingerprint are bounded across scales', () => {
  const samples = [
    reportSample(1, [[attempt('committed', 1)]], 1),
    reportSample(4, [[attempt('committed', 1)]], 8),
    reportSample(16, [[attempt('committed', 1)]], 64),
  ];
  expect(() => validateAttemptSamples(attemptCheck, samples)).toThrow(
    /statement SELECT 1 rows violates constant growth bound/,
  );
});

test('a check without attempts keeps the existing inclusive growth rule', async () => {
  const report = await checkGrowth(db, {
    name: 'legacy inclusive behavior',
    scales: [1, 4, 16],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {},
    operation: async (growthDb) => growthDb.pool.query('SELECT 1'),
  });
  expect(report.samples.every(({ attempts }) => attempts === undefined)).toBe(true);
});

test('capture ledger identifies backend attempts and SQLSTATE outcomes', () => {
  const capture = {
    statements: ['BEGIN', 'BEGIN', 'SELECT 1', 'SELECT 1', 'COMMIT', 'ROLLBACK'],
    plans: [],
    statementBackends: [10, 20, 10, 20, 10, 20],
    statementErrors: [null, null, null, '40001', null, null],
  };
  expect(readAttemptLedger(capture)).toEqual([
    { backend: 10, outcome: 'committed', statements: 1, occurrences: [0, 2, 4] },
    { backend: 20, outcome: 'aborted:40001', statements: 1, occurrences: [1, 3, 5] },
  ]);
});

test('attempt ledger: concurrent serialization retries preserve every inclusive execution per scale and repetition', async () => {
  let run = 0;
  const report = await checkGrowth(db, {
    name: 'executed retry work',
    scales: [1, 4, 16],
    repetitions: 2,
    attempts: { commands: 2 },
    bounds: attemptCheck.bounds,
    grow: async () => {
      run = 0;
    },
    operation: async (database, scale) => {
      const retry = scale < 16 && run++ % 2 === 0;
      await Promise.all(
        [0, 1].map(async (command) => {
          const client = await database.pool.connect();
          try {
            if (retry && command === 0) {
              await client.query('BEGIN');
              try {
                await client.query("DO $$ BEGIN RAISE EXCEPTION 'retry fixture' USING ERRCODE = '40001'; END $$");
                throw new Error('expected serialization failure');
              } catch (error) {
                if ((error as { code?: string }).code !== '40001') throw error;
              }
              await client.query('ROLLBACK');
            }
            await client.query('BEGIN');
            await client.query('SELECT 1');
            await client.query('COMMIT');
          } finally {
            client.release();
          }
        }),
      );
    },
  });
  for (const sample of report.samples) {
    expect(sample.attempts?.repetitions).toHaveLength(2);
    for (const [index, repetition] of sample.attempts!.repetitions.entries()) {
      const aborted = repetition.byOutcome['aborted:40001'] ?? 0;
      expect(repetition.byOutcome.committed).toBe(2);
      expect(repetition.ledger.filter(({ outcome }) => outcome === 'aborted:40001')).toHaveLength(aborted);
      expect(sample.repetitions[index]!.statements).toBe(2 + aborted);
      expect(sample.repetitions[index]!.failedStatements?.['40001'] ?? 0).toBe(aborted);
      expect(repetition.attemptsPerCommand).toBe((2 + aborted) / 2);
    }
  }
  expect(report.samples[0]!.attempts!.repetitions.some(({ byOutcome }) => byOutcome['aborted:40001'] === 1)).toBe(true);
});

test('attempt ledger: aborted work cannot exceed a committed attempt', () => {
  const samples = [1, 4, 16].map((scale) =>
    reportSample(scale, [[attempt('aborted:40P01', 2), attempt('committed', 1)]]),
  );
  expect(() => validateAttemptSamples(attemptCheck, samples)).toThrow(/aborted attempt.*40P01.*exceeding committed/);
});

test('attempt ledger: committed statement changes between repetitions name SQL and location', () => {
  const samples = [1, 4, 16].map((scale) =>
    reportSample(scale, [[attempt('committed', 1, [0])], [attempt('committed', scale === 4 ? 2 : 1, [0])]]),
  );
  expect(() => validateAttemptSamples(attemptCheck, samples)).toThrow(
    /committed attempt.*scale 4, repetition 1.*SELECT 1/,
  );
});

test('attempt ledger: COMMIT failures and deadlocks are aborts; savepoint rollback does not end an attempt', () => {
  const ledger = readAttemptLedger({
    statements: [
      'BEGIN',
      'SAVEPOINT retry',
      'SELECT 1',
      'ROLLBACK TO SAVEPOINT retry',
      'SELECT 1',
      'COMMIT',
      'BEGIN',
      'SELECT 1',
      'ROLLBACK',
    ],
    statementBackends: Array(9).fill(100),
    plans: [],
    statementErrors: [null, null, null, null, null, '40001', null, '40P01', null],
  });
  expect(ledger.map(({ outcome, statements }) => ({ outcome, statements }))).toEqual([
    { outcome: 'aborted:40001', statements: 2 },
    { outcome: 'aborted:40P01', statements: 1 },
  ]);
});

test('attempt ledger: without a declaration inclusive statement growth still fails', async () => {
  await expect(
    checkGrowth(db, {
      name: 'inclusive growth unchanged',
      scales: [1, 4, 16],
      repetitions: 1,
      bounds: attemptCheck.bounds,
      grow: async () => {},
      operation: async (database, scale) => {
        for (let index = 0; index < scale; index++) await database.pool.query('SELECT 1');
      },
    }),
  ).rejects.toThrow(/statements/);
});
