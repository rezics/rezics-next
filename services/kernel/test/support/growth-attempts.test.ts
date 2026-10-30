import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withConnection } from '../../src/database/pool.ts';
import {
  checkGrowth,
  GrowthBoundError,
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
const retrySchema = 'growth_attempt_verdict_test';
const retryFunction = `${retrySchema}.fail_retry`;
const inclusiveTable = `${retrySchema}.inclusive_records`;
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`CREATE SCHEMA ${retrySchema}`);
  await db.admin.query(`CREATE TABLE ${inclusiveTable} (id integer NOT NULL)`);
  await db.admin.query(`INSERT INTO ${inclusiveTable} SELECT generate_series(1, 78)`);
  await db.admin.query(`CREATE FUNCTION ${retryFunction}(state text) RETURNS integer LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'retry requested' USING ERRCODE = state; END $$`);
});
afterAll(async () => {
  await db?.admin.query(`DROP SCHEMA IF EXISTS ${retrySchema} CASCADE`);
  await db?.close();
});

async function captureReviews<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    const text = String(chunk);
    if (text.startsWith('GROWTH_REVIEW ')) lines.push(text.trimEnd());
    else originalWrite(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await run(), lines };
  } finally {
    process.stderr.write = originalWrite;
  }
}

function reviewJson(line: string): Record<string, unknown> {
  expect(line.startsWith('GROWTH_REVIEW ')).toBe(true);
  return JSON.parse(line.slice('GROWTH_REVIEW '.length));
}

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
        statements: [
          { index: 0, statement: 'SELECT 1', backend: 100, error: null, plans: [], planDocuments: [], rows, blocks: 1 },
        ],
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

test('attempts per command growth stays visible as diagnostics instead of blocking the check', () => {
  const samples = [1, 4, 16].map((scale, index) =>
    reportSample(scale, [
      [...Array.from({ length: index }, () => attempt('aborted:40001', 1)), attempt('committed', 1)],
    ]),
  );
  expect(() => validateAttemptSamples(attemptCheck, samples)).not.toThrow();
  expect(samples.map(({ attempts }) => attempts!.attemptsPerCommand)).toEqual([1, 2, 3]);
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

test('declared attempts do not bypass an established inclusive rows violation', async () => {
  await mkdir(join(process.cwd(), '.temp'), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), '.temp', 'growth-attempt-inclusive-'));
  const profilePath = join(directory, 'profile.jsonl');
  const previousProfile = process.env.GROWTH_PROFILE;
  process.env.GROWTH_PROFILE = profilePath;
  try {
    const error = await checkGrowth(db, {
      name: 'inclusive rows with attempt ledger',
      rule: 'series',
      scales: [1, 4, 16],
      repetitions: 5,
      attempts: { commands: 1 },
      bounds: { rows: 'constant', blocks: 'linear', statements: 'linear' },
      grow: async () => {},
      warmup: async (database) => database.pool.query('SELECT 1'),
      operation: async (database, scale) => {
        const rowCounts: Record<number, number> = { 1: 11, 4: 78, 16: 11 };
        await withConnection(database.pool, async (client) => {
          await client.query('BEGIN');
          await client.query(`SELECT id FROM ${inclusiveTable} LIMIT $1::integer`, [rowCounts[scale]!]);
          await client.query('COMMIT');
        });
      },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GrowthBoundError);
    const [line] = (await readFile(profilePath, 'utf8')).trim().split('\n');
    const profile = JSON.parse(line!) as {
      verdicts: { rows: { outcome: string } };
      repetitions: { rows: number }[][];
    };
    expect(profile.verdicts.rows.outcome).toBe('violation');
    expect(profile.repetitions.map((runs) => runs[0]!.rows)).toEqual([11, 78, 11]);
  } finally {
    if (previousProfile === undefined) delete process.env.GROWTH_PROFILE;
    else process.env.GROWTH_PROFILE = previousProfile;
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test('attempted 40001 and 40P01 work retains inclusive costs and uses retries review', async () => {
  for (const sqlstate of ['40001', '40P01']) {
    const captured = await captureReviews(() =>
      checkGrowth(db, {
        name: `attempt retry evidence ${sqlstate}`,
        rule: 'series',
        scales: [1, 4, 16],
        repetitions: 1,
        attempts: { commands: 1 },
        bounds: { rows: 'linear', blocks: 'linear', statements: 'constant' },
        grow: async () => {},
        warmup: async (database) => database.pool.query('SELECT 1'),
        operation: async (database, scale) => {
          const statementCounts: Record<number, number> = { 1: 69, 4: 79, 16: 86 };
          for (let index = 0; index < statementCounts[scale]!; index++)
            await database.pool.query('SELECT $1::integer AS value', [index]);
          await withConnection(database.pool, async (client) => {
            await client.query('BEGIN');
            try {
              await client.query(`SELECT ${retryFunction}($1::text)`, [sqlstate]);
            } catch (error) {
              if ((error as { code?: string }).code !== sqlstate) throw error;
            }
            await client.query('ROLLBACK');
            await client.query('BEGIN');
            await client.query('SELECT 1 AS committed');
            await client.query('COMMIT');
          });
        },
      }),
    );
    expect(captured.value.verdicts.statements).toMatchObject({ outcome: 'inconclusive', reason: 'retries' });
    expect(captured.value.samples.map(({ repetitions }) => repetitions[0]!.statements)).toEqual([71, 81, 88]);
    expect(captured.value.samples[0]!.attempts?.repetitions[0]!.byOutcome[`aborted:${sqlstate}`]).toBe(1);
    expect(captured.lines).toHaveLength(1);
    expect(reviewJson(captured.lines[0]!)).toMatchObject({
      check: `attempt retry evidence ${sqlstate}`,
      metric: 'statements',
      reason: 'retries',
      failedStatements: [
        { scale: 1, sqlstate, count: 1 },
        { scale: 4, sqlstate, count: 1 },
        { scale: 16, sqlstate, count: 1 },
      ],
    });
  }
}, 120_000);

test('retry-only SQL missing scale evidence stays in native occurrences without blocking', async () => {
  const report = await checkGrowth(db, {
    name: 'intermittent retry-only occurrence',
    rule: 'series',
    scales: [1, 4, 16],
    repetitions: 1,
    attempts: { commands: 1 },
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {},
    warmup: async (database) => database.pool.query('SELECT 1'),
    operation: async (database, scale) => {
      await withConnection(database.pool, async (client) => {
        if (scale === 1) {
          await client.query('BEGIN');
          try {
            await client.query(`SELECT ${retryFunction}($1::text)`, ['40001']);
          } catch (error) {
            if ((error as { code?: string }).code !== '40001') throw error;
          }
          await client.query('ROLLBACK');
        }
        await client.query('BEGIN');
        await client.query('SELECT 1 AS committed');
        await client.query('COMMIT');
      });
    },
  });

  const failed = report.samples[0]!.occurrenceRepetitions[0]!.statements.find(({ error }) => error?.code === '40001');
  expect(failed?.statement).toContain('fail_retry');
  expect(report.samples[0]!.attempts?.repetitions[0]!.byOutcome['aborted:40001']).toBe(1);
  expect(
    report.samples
      .slice(1)
      .every(({ occurrenceRepetitions }) =>
        occurrenceRepetitions[0]!.statements.every(({ statement }) => !statement.includes('fail_retry')),
      ),
  ).toBe(true);
  expect(report.samples[0]!.repetitions[0]!.failedStatements?.['40001']).toBe(1);
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

test('attempt ledger: intermittent retry statements are judged only on executed work', () => {
  const samples = [1, 4, 16].map((scale) => {
    const sample = reportSample(scale, [
      [attempt('aborted:40001', 1), attempt('committed', 1)],
      [attempt('committed', 1)],
    ]);
    const committed = sample.occurrenceRepetitions[0]!;
    const retryStatement = {
      ...committed.statements[0]!,
      index: 1,
      statement: 'SELECT retry_work',
      rows: 100,
      blocks: 100,
    };
    return {
      ...sample,
      occurrenceRepetitions: [{ ...committed, statements: [...committed.statements, retryStatement] }, committed],
    };
  });
  expect(() => validateAttemptSamples(attemptCheck, samples)).not.toThrow();
  // Contention can disappear at the largest scale, including the retry-only statement itself.
  const last = samples[2]!;
  const fewerRetries = reportSample(16, [[attempt('committed', 1)], [attempt('committed', 1)]]);
  expect(() => validateAttemptSamples(attemptCheck, [samples[0]!, samples[1]!, fewerRetries])).not.toThrow();
  expect(last.occurrenceRepetitions[0]!.statements[1]!.rows).toBe(100);
});

test('attempt ledger: failures without plans do not turn bounded executions into noisy row and block evidence', () => {
  const samples = [1, 4, 16].map((scale) => {
    const sample = reportSample(
      scale,
      [[attempt('aborted:40001', 1), attempt('committed', 1)], [attempt('committed', 1)]],
      100,
    );
    const success = sample.occurrenceRepetitions[0]!;
    const failed = {
      ...success.statements[0]!,
      error: { code: '40001', message: 'serialization failure' },
      rows: 0,
      blocks: 0,
    };
    return {
      ...sample,
      occurrenceRepetitions: [
        { ...success, statements: [failed] },
        { ...success, statements: [{ ...success.statements[0]!, blocks: 100 }] },
      ],
    };
  });
  expect(() => validateAttemptSamples(attemptCheck, samples)).not.toThrow();
});

test('attempt ledger: one expensive execution cannot be hidden by cheaper repetitions', () => {
  for (const metric of ['rows', 'blocks'] as const) {
    const samples = [1, 4, 16].map((scale) => {
      const sample = reportSample(scale, [[attempt('committed', 1)], [attempt('committed', 1)]]);
      const cheap = sample.occurrenceRepetitions[0]!;
      return {
        ...sample,
        occurrenceRepetitions: [cheap, { ...cheap, statements: [{ ...cheap.statements[0]!, [metric]: scale * 100 }] }],
      };
    });
    expect(() => validateAttemptSamples(attemptCheck, samples)).toThrow(
      `statement SELECT 1 ${metric} violates constant growth bound`,
    );
  }
});

test('attempt ledger: a statement mismatch reports actual and reference SQL separately', () => {
  const samples = [1, 4, 16].map((scale) => {
    const sample = reportSample(scale, [
      [attempt('committed', 1, [0])],
      [attempt('committed', scale === 4 ? 2 : 1, [0, 1])],
    ]);
    const first = sample.occurrenceRepetitions[0]!;
    return {
      ...sample,
      occurrenceRepetitions: [
        first,
        {
          ...first,
          statements: [
            { ...first.statements[0]!, statement: 'SELECT actual_first' },
            { ...first.statements[0]!, index: 1, statement: 'SELECT actual_second' },
          ],
        },
      ],
    };
  });
  expect(() => validateAttemptSamples(attemptCheck, samples)).toThrow(
    /scale 4, repetition 1.*statements: SELECT actual_first; SELECT actual_second; reference committed statements: SELECT 1/,
  );
});
