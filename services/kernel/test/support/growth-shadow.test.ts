import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { withConnection } from '../../src/database/pool.ts';
import {
  checkGrowth,
  GrowthBoundError,
  growthViolations,
  openGrowthDatabase,
  type GrowthCheck,
  type GrowthDatabase,
} from './growth.ts';
import { classifySeries } from './growth-model.ts';
import { GROWTH_UNCERTAINTY } from './growth-uncertainty.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_shadow_test';
const table = `${schema}.records`;
const bounds: GrowthCheck['bounds'] = { rows: 'constant', blocks: 'constant', statements: 'constant' };
const metrics = ['rows', 'blocks', 'statements'] as const;
let db: GrowthDatabase | undefined;
let directory: string;

beforeAll(async () => {
  const temporary = resolve(import.meta.dir, '../../../../.temp');
  await mkdir(temporary, { recursive: true });
  directory = await mkdtemp(join(temporary, 'growth-shadow-'));
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
  await db.admin.query(`INSERT INTO ${table} SELECT generate_series(1, 100)`);
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  if (!db) return;
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

const operation: GrowthCheck['operation'] = (database) =>
  withConnection(database.pool, (client) => client.query(`SELECT id FROM ${table} WHERE id = 1`));

test('a growth check with five geometric scales reports five samples and applies the step rule to every consecutive triple', async () => {
  const scales = [1, 4, 16, 64, 256] as const;
  const report = await checkGrowth(db!, {
    name: 'five growth scales',
    scales,
    bounds,
    repetitions: 1,
    grow: async () => {},
    operation,
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(growthViolations(report.samples, bounds)).toEqual([]);

  for (const bound of ['constant', 'logarithmic', 'linear'] as const) {
    // Each possible triple must be checked, even when the other triples stay flat or decrease.
    for (const changed of [2, 3, 4]) {
      const samples = report.samples.map((sample, index) => ({
        ...sample,
        cost: { ...sample.cost, rows: index === changed ? 100 : 1 },
      }));
      expect(growthViolations(samples, { ...bounds, rows: bound })).toContainEqual({
        metric: 'rows',
        bound,
        scales: [scales[changed - 2]!, scales[changed - 1]!, scales[changed]!],
        values: [1, 1, 100],
        observed: 99,
        allowed: 2,
      });
    }
  }
  const lastStep = report.samples.map((sample, index) => ({
    ...sample,
    cost: { ...sample.cost, rows: index === 4 ? 100 : 1 },
  }));
  expect(growthViolations(lastStep, bounds)).toEqual([
    { metric: 'rows', bound: 'constant', scales: [16, 64, 256], values: [1, 1, 100], observed: 99, allowed: 2 },
  ]);
  expect(growthViolations(report.samples.slice(0, 4), bounds)).toEqual([]);
  for (const invalid of [
    [1, 4],
    [1, 4, 16, 64, 256, 1024],
    [1, 4, 16, 64, 257],
    [32, 128, 512, 2048, 8192],
  ]) {
    expect(() =>
      growthViolations(
        invalid.map((scale) => ({ scale, cost: report.samples[0]!.cost })),
        bounds,
      ),
    ).toThrow(TypeError);
  }
}, 60_000);

test("the growth profile line carries each scale's repetitions, relation sizes and a shadow verdict per metric", async () => {
  const path = join(directory, 'profile.jsonl');
  const previous = process.env.GROWTH_PROFILE;
  process.env.GROWTH_PROFILE = path;
  try {
    const slack = { rows: { absolute: 3, relative: 0.2 } };
    const report = await checkGrowth(db!, {
      name: 'shadow growth profile',
      scales: [1, 4, 16, 64],
      bounds: { ...bounds, blocks: 'logarithmic' },
      slack,
      indexProbes: 2,
      repetitions: 2,
      grow: async () => {},
      operation,
    });
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const profile = JSON.parse(lines[0]!);
    expect(profile).toMatchObject({
      file: expect.stringMatching(/growth-shadow\.test\.ts$/),
      check: report.name,
      scales: [1, 4, 16, 64],
      bounds: { ...bounds, blocks: 'logarithmic' },
      seeding: report.samples.map(({ seeding }) => seeding),
      repetitions: report.samples.map(({ repetitions }) =>
        repetitions.map(({ rows, blocks, statements }) => ({ rows, blocks, statements })),
      ),
      relationSizes: report.samples.map(({ relationSizes }) => relationSizes),
    });
    for (const sample of report.samples) {
      expect(sample.repetitions).toHaveLength(2);
      expect(sample.relationSizes[table]).toMatchObject({ reltuples: 100, relpages: expect.any(Number) });
    }
    for (const metric of metrics) {
      const tolerance = GROWTH_UNCERTAINTY[metric];
      const uncertainties = report.samples.map(({ cost }) =>
        Math.max(tolerance.absolute, tolerance.relative * cost[metric]),
      );
      const expected = classifySeries(
        report.samples.map(({ scale, repetitions }, index) => ({
          scale,
          repetitions: repetitions.map((cost) => cost[metric]),
          uncertainty: uncertainties[index]!,
        })),
        metric === 'blocks' ? 'logarithmic' : bounds[metric],
        metric === 'blocks' ? 2 : 0,
      );
      expect(report.shadow[metric]).toEqual({ ...expected, uncertainties });
      expect(report.shadow[metric].uncertainties).toEqual(
        report.samples.map(({ cost }) =>
          Math.max(GROWTH_UNCERTAINTY[metric].absolute, GROWTH_UNCERTAINTY[metric].relative * cost[metric]),
        ),
      );
      expect(profile.shadow[metric]).toMatchObject({ outcome: expected.outcome, uncertainties });
      for (const family of ['constant', 'logarithmic', 'linear'] as const) {
        const { a, b, factor } = expected.families[family];
        expect(profile.shadow[metric].families[family]).toEqual({ a, b, t: factor });
      }
    }
    if (!('staircase' in report.shadow.blocks)) throw new Error('Blocks shadow verdict lacks its staircase');
    expect(profile.shadow.blocks.staircase).toEqual(report.shadow.blocks.staircase);
    expect(profile.shadow.blocks.staircase).toHaveLength(report.samples.length);

    await expect(
      checkGrowth(db!, {
        name: 'failing shadow profile',
        bounds,
        repetitions: 1,
        grow: async () => {},
        operation: (database, scale) =>
          withConnection(database.pool, async (client) => {
            await client.query('SELECT 1');
            if (scale === 64) await client.query('SELECT 2');
          }),
      }),
    ).rejects.toBeInstanceOf(GrowthBoundError);
    const failedLines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(failedLines).toHaveLength(2);
    expect(JSON.parse(failedLines[1]!)).toMatchObject({
      check: 'failing shadow profile',
      shadow: {
        statements: {
          outcome: 'violation',
          uncertainties: [0, 0, 0],
          families: { constant: { t: 'Infinity' } },
        },
      },
    });
  } finally {
    if (previous === undefined) delete process.env.GROWTH_PROFILE;
    else process.env.GROWTH_PROFILE = previous;
  }
}, 60_000);

test('a shadow violation never fails a check that passes the step rule', async () => {
  const client = await db!.pool.connect();
  let report: Awaited<ReturnType<typeof checkGrowth>>;
  try {
    report = await checkGrowth(db!, {
      name: 'noisy shadow growth',
      bounds,
      repetitions: 3,
      grow: async () => {},
      warmup: () => client.query('SELECT 1'),
      operation: async (_database, scale, repetition) => {
        await client.query('SELECT 1');
        // With one warmup and three measured runs, the last run at the middle scale is repetition 7.
        if (scale === 8 && repetition === 7) {
          for (let extra = 0; extra < 10; extra++) await client.query('SELECT 2');
        }
      },
    });
  } finally {
    client.release();
  }
  const statementRuns = report.samples.map(({ repetitions }) => repetitions.map(({ statements }) => statements));
  expect(statementRuns[0]).toEqual([1, 1, 1]);
  expect(statementRuns[1]).toEqual([1, 1, 11]);
  expect(statementRuns[2]).toEqual([1, 1, 1]);
  expect(growthViolations(report.samples, bounds)).toEqual([]);
  expect(report.shadow.statements.outcome).toBe('compatible');

  const exact = await checkGrowth(db!, {
    name: 'exact shadow violation',
    bounds: { ...bounds, statements: 'logarithmic' },
    repetitions: 1,
    grow: async () => {},
    operation: (database, scale) =>
      withConnection(database.pool, async (client) => {
        const count = scale === 1 ? 1 : scale === 8 ? 2 : 4;
        for (let statement = 0; statement < count; statement++) await client.query('SELECT 1');
      }),
  });
  expect(growthViolations(exact.samples, exact.bounds)).toEqual([]);
  expect(exact.shadow.statements.outcome).toBe('violation');
});
