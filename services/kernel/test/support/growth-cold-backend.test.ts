import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase, type GrowthReport } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const coldSchema = 'growth_cold_backend';
const writeTable = `${coldSchema}.write_records`;

let db: GrowthDatabase | undefined;
beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`CREATE SCHEMA ${coldSchema}`);
  await db.admin.query(`CREATE TABLE ${writeTable} (id integer PRIMARY KEY)`);
});
afterAll(async () => {
  await db?.admin.query(`DROP SCHEMA IF EXISTS ${coldSchema} CASCADE`);
  await db?.close();
});

const bounds = { rows: 'constant', blocks: 'constant', statements: 'constant' } as const;

test('a newly used pool connection is discarded once and accepted repetitions report their backend sets', async () => {
  const database = db!;
  const directory = await mkdtemp(join(process.cwd(), '.temp', 'growth-cold-backend-'));
  const profilePath = join(directory, 'profile.jsonl');
  const previousProfile = process.env.GROWTH_PROFILE;
  process.env.GROWTH_PROFILE = profilePath;
  let report: GrowthReport;
  try {
    report = await checkGrowth(database, {
      name: 'cold pooled backend',
      bounds,
      repetitions: 2,
      warmup: (growthDb) => withConnection(growthDb.pool, (client) => client.query('SELECT 1 AS warm')),
      grow: async () => {},
      operation: async (growthDb) => {
        const first = await growthDb.pool.connect();
        const second = await growthDb.pool.connect();
        try {
          await Promise.all([first.query('SELECT 2 AS first'), second.query('SELECT 3 AS second')]);
        } finally {
          first.release();
          second.release();
        }
      },
    });
  } finally {
    if (previousProfile === undefined) delete process.env.GROWTH_PROFILE;
    else process.env.GROWTH_PROFILE = previousProfile;
  }

  expect(report.samples[0]!.coldBackendDiscards).toBe(1);
  for (const sample of report.samples) {
    expect(sample.backendRepetitions).toHaveLength(2);
    expect(sample.backendRepetitions[0]).toEqual(expect.arrayContaining([expect.any(Number)]));
  }
  const [profileLine] = (await readFile(profilePath, 'utf8')).trim().split('\n');
  expect(JSON.parse(profileLine!)).toMatchObject({
    coldBackendDiscards: report.samples.map(({ coldBackendDiscards }) => coldBackendDiscards),
    backendRepetitions: report.samples.map(({ backendRepetitions }) => backendRepetitions),
  });
  await rm(directory, { recursive: true, force: true });
}, 60_000);

test('an operation that always creates cold backends retains every run after four bounded discards per scale', async () => {
  const database = db!;
  const operationCounts = new Map<number, number>();
  const report = await checkGrowth(database, {
    name: 'always cold backend',
    scales: [1, 4, 16],
    repetitions: 2,
    bounds,
    warmup: async (growthDb) => {
      const pool = growthDb.openPool({ max: 1 });
      await pool.query('SELECT 4 AS warm');
    },
    grow: async () => {},
    operation: async (growthDb, scale) => {
      const pool = growthDb.openPool({ max: 1 });
      const operationIndex = operationCounts.get(scale) ?? 0;
      operationCounts.set(scale, operationIndex + 1);
      if (operationIndex < 4) await pool.query('SELECT 5 AS cold');
      else await pool.query(`INSERT INTO ${writeTable} (id) VALUES ($1)`, [scale * 10 + operationIndex]);
    },
  });

  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    expect(sample.coldBackendDiscards).toBe(4);
    expect(sample.repetitions).toHaveLength(2);
    expect(sample.repetitions.every(({ statements }) => statements === 1)).toBe(true);
    expect(sample.backendRepetitions).toHaveLength(2);
    expect(sample.backendRepetitions.every((backends) => backends.length === 1)).toBe(true);
    expect(sample.occurrenceRepetitions).toHaveLength(2);
    expect(
      sample.occurrenceRepetitions.every(({ statements }) =>
        statements.some(({ statement }) => statement.includes('INSERT INTO')),
      ),
    ).toBe(true);
    expect(sample.relationSizes[writeTable]).toBeDefined();
  }
  const backends = report.samples.flatMap(({ backendRepetitions }) => backendRepetitions.flat());
  expect(new Set(backends).size).toBe(6);
}, 60_000);
