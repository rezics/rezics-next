import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withConnection } from '../../src/database/pool.ts';
import {
  checkGrowth,
  GrowthEvidenceError,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthReport,
} from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let db: GrowthDatabase | undefined;
beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
});
afterAll(async () => {
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

test('an operation that creates a new backend every run fails after four cold discards', async () => {
  const database = db!;
  await expect(
    checkGrowth(database, {
      name: 'always cold backend',
      scales: [1, 4, 16],
      repetitions: 1,
      bounds,
      warmup: async (growthDb) => {
        const pool = growthDb.openPool({ max: 1 });
        await pool.query('SELECT 4 AS warm');
      },
      grow: async () => {},
      operation: async (growthDb) => {
        const pool = growthDb.openPool({ max: 1 });
        await pool.query('SELECT 5 AS cold');
      },
    }),
  ).rejects.toMatchObject({
    name: 'GrowthEvidenceError',
    message: expect.stringContaining('operation keeps using cold backends'),
  } satisfies Partial<GrowthEvidenceError>);
}, 60_000);
