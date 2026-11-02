import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { withConnection } from '../../src/database/pool.ts';
import {
  checkGrowth,
  GrowthBoundError,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
  type ReportSample,
} from './growth.ts';
import { classifySeries, type GrowthModelBound, type SeriesPoint } from './growth-model.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_verdict_test';
const records = `${schema}.records`;
const badBlocks = `${schema}.bad_blocks`;
const settlingRows = `${schema}.settling_rows`;
const seedRows = `${schema}.seed_rows`;
const tempRoot = resolve(import.meta.dir, '../../../../.temp');
let db: GrowthDatabase;
let tempDirectory: string;

beforeAll(async () => {
  await mkdir(tempRoot, { recursive: true });
  tempDirectory = await mkdtemp(join(tempRoot, 'growth-verdict-'));
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${records} (id integer PRIMARY KEY)`);
  await db.admin.query(`INSERT INTO ${records} SELECT generate_series(1, 10000)`);
  await db.admin.query(`CREATE TABLE ${badBlocks} (id integer PRIMARY KEY, body text NOT NULL)`);
  await db.admin.query(`CREATE TABLE ${settlingRows} (id integer PRIMARY KEY, body text NOT NULL)`);
  await db.admin.query(`CREATE TABLE ${seedRows} (id integer PRIMARY KEY)`);
  await db.admin.query(`CREATE FUNCTION ${schema}.fail_retry(state text) RETURNS integer LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'retry requested' USING ERRCODE = state; END $$`);
});

afterAll(async () => {
  await db?.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db?.close();
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
});

function repetitions(values: readonly number[]): number[] {
  return [...values];
}

function repeated(value: number, count = 5): number[] {
  return Array.from({ length: count }, () => value);
}

function points(
  scales: readonly number[],
  values: readonly (readonly number[])[],
  uncertainty: number | readonly number[],
): SeriesPoint[] {
  return scales.map((scale, index) => ({
    scale,
    repetitions: [...values[index]!],
    uncertainty: typeof uncertainty === 'number' ? uncertainty : uncertainty[index]!,
  }));
}

type PureCase = Readonly<{
  name: string;
  bound: GrowthModelBound;
  points: readonly SeriesPoint[];
}>;

const compatibleSeries: PureCase[] = [
  {
    name: 'semantic rows decrease from 78 to 11',
    bound: 'constant',
    points: points([64, 512, 4096], [repeated(78), repeated(11), repeated(11)], 22),
  },
  {
    name: 'commerce follow-source rows',
    bound: 'constant',
    points: points(
      [256, 1024, 4096],
      [
        repetitions([620, 626, 433, 435, 437]),
        repetitions([441, 443, 445, 447, 449]),
        repetitions([453, 455, 457, 459, 461]),
      ],
      22,
    ),
  },
  ...[
    [
      [246, 248, 244, 246, 236],
      [261, 239, 239, 239, 229],
      [260, 254, 264, 254, 244],
    ],
    [
      [210, 212, 206, 217, 202],
      [205, 201, 210, 201, 197],
      [226, 229, 227, 218, 209],
    ],
    [
      [188, 182, 176, 195, 187],
      [191, 190, 188, 188, 188],
      [200, 202, 200, 202, 200],
    ],
  ].map((value, index) => ({
    name: `accounts membership blocks ${String.fromCharCode(97 + index)}`,
    bound: 'logarithmic' as const,
    points: points([256, 1024, 4096], value, 9),
  })),
  {
    name: 'accounts membership blocks medians 222 199 222',
    bound: 'logarithmic',
    points: points([256, 1024, 4096], [repeated(222), repeated(199), repeated(222)], 9),
  },
  ...[
    {
      uncertainties: [11.76, 11.85, 12],
      values: [
        [386, 380, 415, 393, 392],
        [395, 386, 399, 411, 393],
        [401, 400, 383, 410, 395],
      ],
    },
    {
      uncertainties: [11.85, 12, 12.3],
      values: [
        [390, 397, 387, 395, 413],
        [388, 407, 405, 400, 397],
        [396, 426, 410, 413, 400],
      ],
    },
    { uncertainties: [10.5, 11.01, 9.96], values: [[350], [367], [332]] },
    { uncertainties: [10.11, 11.34, 10.11], values: [[337], [378], [337]] },
  ].map(({ uncertainties, values }, index) => ({
    name: `accounts fence pages ${String.fromCharCode(97 + index)}`,
    bound: 'logarithmic' as const,
    points: points([1, 8, 64], values, uncertainties),
  })),
  ...[
    [
      [214, 180, 179, 179, 179],
      [216, 181, 173, 173, 173],
      [182, 182, 221, 182, 182],
    ],
    [
      [106, 106, 100, 116, 106],
      [106, 94, 96, 110, 122],
      [110, 112, 122, 112, 116],
    ],
    [
      [115, 115, 115, 131, 115],
      [115, 94, 94, 96, 110],
      [125, 112, 113, 112, 116],
    ],
  ].map((value, index) => ({
    name: `content moderation and report blocks ${String.fromCharCode(97 + index)}`,
    bound: 'logarithmic' as const,
    points: points([32, 256, 2048], value, 9),
  })),
  {
    name: 'semantic sourced-write rows',
    bound: 'constant',
    points: points(
      [1, 4, 16],
      [
        [1363, 1330, 1191, 1125, 1279],
        [1163, 1099, 1098, 1140, 1159],
        [1091, 1158, 1114, 1102, 1107],
      ],
      22,
    ),
  },
  {
    name: 'semantic sourced-write statements',
    bound: 'constant',
    points: points(
      [1, 4, 16],
      [
        [2207, 2167, 1900, 1786, 2054],
        [1874, 1745, 1745, 1839, 1877],
        [1745, 1871, 1782, 1768, 1768],
      ],
      0,
    ),
  },
  {
    name: 'performance media-import blocks repetitions one',
    bound: 'logarithmic',
    points: points([32, 256, 2048], [repeated(230, 3), repeated(218, 3), repeated(258, 3)], 9),
  },
  {
    name: 'performance media-import blocks repetitions two',
    bound: 'logarithmic',
    points: points([32, 256, 2048], [repeated(230, 3), repeated(209, 3), repeated(258, 3)], 9),
  },
];

test('all named decreasing and flat harness series classify as compatible', () => {
  for (const item of compatibleSeries) {
    const verdict = classifySeries(item.points, item.bound);
    expect(verdict.outcome, item.name).toBe('compatible');
  }
});

test('established account-agent, statements and row growth remain violations', () => {
  const agentBlocks = classifySeries(points([1, 8, 64], [repeated(4), repeated(12), repeated(69)], 9), 'logarithmic');
  expect(agentBlocks.outcome).toBe('violation');

  const statements = classifySeries(points([1, 4, 16], [repeated(69), repeated(79), repeated(86)], 0), 'constant');
  expect(statements.outcome).toBe('violation');

  const rows = classifySeries(points([1, 4, 16], [repeated(11), repeated(78), repeated(11)], 22), 'constant');
  expect(rows.outcome).toBe('violation');
});

test('organization-cleanup row spreads are inconclusive noise', () => {
  const cases = [
    [
      [890, 809, 800, 899, 782],
      [953, 899, 908, 845, 881],
      [962, 962, 998, 953, 917],
    ],
    [
      [818, 908, 827, 836, 863],
      [935, 953, 872, 917, 854],
      [1016, 944, 1043, 980, 854],
    ],
  ];
  for (const value of cases) {
    const verdict = classifySeries(points([256, 1024, 4096], value, 22), 'constant');
    expect(verdict).toMatchObject({ outcome: 'inconclusive', reason: 'noise' });
  }
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

async function scanRecordRange(database: GrowthDatabase, count: number): Promise<void> {
  await withConnection(database.pool, async (client) => {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan=off');
    await client.query(`SELECT id FROM ${records} WHERE id >= 1 AND id <= $1`, [count]);
    await client.query('ROLLBACK');
  });
}

test('noise passes checkGrowth and is present once in verdicts, profile and stderr review', async () => {
  const profilePath = join(tempDirectory, 'noise-profile.jsonl');
  const previousProfile = process.env.GROWTH_PROFILE;
  process.env.GROWTH_PROFILE = profilePath;
  const values = [
    [1, 1, 1, 100, 200],
    [1, 80, 80, 100, 200],
    [1, 150, 150, 200, 250],
  ];
  let run = 0;
  try {
    const captured = await captureReviews(() =>
      checkGrowth(db, {
        name: 'organization-cleanup noisy rows',
        rule: 'series',
        scales: [1, 4, 16],
        bounds: { rows: 'constant', blocks: 'linear', statements: 'linear' },
        grow: async () => {
          run = 0;
        },
        warmup: async (database) => scanRecordRange(database, 1),
        operation: async (database, scale) => {
          const index = scale === 1 ? 0 : scale === 4 ? 1 : 2;
          await scanRecordRange(database, values[index]![run++]!);
        },
      }),
    );
    expect(captured.value.verdicts.rows).toMatchObject({ outcome: 'inconclusive', reason: 'noise' });
    expect(captured.value.shadow.rows.outcome).toBe('inconclusive');
    expect(captured.lines).toHaveLength(1);
    expect(reviewJson(captured.lines[0]!)).toMatchObject({
      file: expect.stringMatching(/growth-verdict\.test\.ts$/),
      check: 'organization-cleanup noisy rows',
      metric: 'rows',
      bound: 'constant',
      rule: 'series',
      reason: 'noise',
      medians: captured.value.verdicts.rows.medians,
      ranges: captured.value.verdicts.rows.ranges,
      uncertainties: captured.value.verdicts.rows.uncertainties,
    });
    const profileLines = (await readFile(profilePath, 'utf8')).trim().split('\n');
    expect(profileLines).toHaveLength(1);
    expect(JSON.parse(profileLines[0]!)).toMatchObject({
      check: 'organization-cleanup noisy rows',
      verdicts: { rows: { outcome: 'inconclusive', reason: 'noise' } },
    });
  } finally {
    if (previousProfile === undefined) delete process.env.GROWTH_PROFILE;
    else process.env.GROWTH_PROFILE = previousProfile;
  }
}, 120_000);

test('a step-rule spike passes as inconclusive when the series classifier finds it compatible', async () => {
  const targets: Record<number, number> = { 1: 0, 4: 0, 16: 10 };
  const captured = await captureReviews(() =>
    checkGrowth(db, {
      name: 'step spike within calibrated uncertainty',
      rule: 'step',
      scales: [1, 4, 16],
      bounds: { rows: 'constant', blocks: 'linear', statements: 'linear' },
      grow: async () => {},
      warmup: async (database) => scanRecordRange(database, 1),
      operation: async (database, scale) => scanRecordRange(database, targets[scale]!),
    }),
  );
  expect(captured.value.shadow.rows.outcome).toBe('compatible');
  expect(captured.value.verdicts.rows).toMatchObject({ outcome: 'inconclusive', reason: 'noise' });
  expect(captured.lines).toHaveLength(1);
  expect(reviewJson(captured.lines[0]!)).toMatchObject({ metric: 'rows', reason: 'noise', rule: 'step' });
}, 120_000);

async function countStatements(database: GrowthDatabase, count: number, retryState?: string): Promise<void> {
  await withConnection(database.pool, async (client) => {
    for (let index = 0; index < count; index += 1) await client.query('SELECT $1::integer AS value', [index]);
    if (retryState) {
      try {
        await client.query(`SELECT ${schema}.fail_retry($1::text)`, [retryState]);
      } catch (error) {
        if ((error as { code?: string }).code !== retryState) throw error;
      }
    }
  });
}

test('measured serialization and deadlock retries turn a violation into inconclusive review', async () => {
  for (const sqlstate of ['40001', '40P01']) {
    const captured = await captureReviews(() =>
      checkGrowth(db, {
        name: `retry evidence ${sqlstate}`,
        rule: 'series',
        scales: [1, 4, 16],
        repetitions: 1,
        bounds: { rows: 'linear', blocks: 'linear', statements: 'constant' },
        grow: async () => {},
        warmup: async (database) => countStatements(database, 1),
        operation: async (database, scale) => {
          await countStatements(database, scale === 1 ? 1 : scale === 4 ? 2 : 4, scale === 1 ? sqlstate : undefined);
        },
      }),
    );
    expect(captured.value.verdicts.statements).toMatchObject({ outcome: 'inconclusive', reason: 'retries' });
    expect(captured.lines).toHaveLength(1);
    expect(reviewJson(captured.lines[0]!)).toMatchObject({
      check: `retry evidence ${sqlstate}`,
      metric: 'statements',
      reason: 'retries',
      failedStatements: [{ scale: 1, sqlstate, count: 1 }],
    });
  }
}, 120_000);

async function runBadBlocks(rule: 'step' | 'series'): Promise<unknown> {
  try {
    await checkGrowth(db, {
      name: `sequential block growth ${rule}`,
      rule,
      scales: [1, 8, 64],
      repetitions: 1,
      bounds: { rows: 'linear', blocks: 'logarithmic', statements: 'constant' },
      grow: async (database, scale, previous) => {
        if (previous === 0) await database.admin.query(`TRUNCATE ${badBlocks}`);
        const from = previous * 50 + 1;
        const to = scale * 50;
        if (from > to) return;
        await database.admin.query(
          `INSERT INTO ${badBlocks} (id,body)
           SELECT ids.row_id, (SELECT string_agg(md5(ids.row_id::text || ':' || pages.page::text), '')
                                 FROM generate_series(1,8) AS pages(page))
             FROM generate_series($1::integer,$2::integer) AS ids(row_id)`,
          [from, to],
        );
      },
      operation: (database) =>
        withConnection(database.pool, (client) => client.query(`SELECT sum(length(body)) FROM ${badBlocks}`)),
    });
    throw new Error('expected the sequential block growth to fail');
  } catch (error) {
    return error;
  }
}

test('established block and statement growth fail with GrowthBoundError under step and series rules', async () => {
  for (const rule of ['step', 'series'] as const) {
    const blockError = await runBadBlocks(rule);
    expect(blockError).toBeInstanceOf(GrowthBoundError);

    const statementError = await (async () => {
      try {
        await checkGrowth(db, {
          name: `constant statements ${rule}`,
          rule,
          scales: [1, 4, 16],
          repetitions: 1,
          bounds: { rows: 'linear', blocks: 'linear', statements: 'constant' },
          grow: async () => {},
          warmup: async (database) => countStatements(database, 1),
          operation: async (database, scale) => {
            await countStatements(database, scale === 1 ? 69 : scale === 4 ? 79 : 86);
          },
        });
        throw new Error('expected constant statements growth to fail');
      } catch (error) {
        return error;
      }
    })();
    expect(statementError).toBeInstanceOf(GrowthBoundError);
  }
}, 120_000);

test('a held snapshot does not hide measured rows and blocks or create settle failures', async () => {
  await db.admin.query(`TRUNCATE ${settlingRows}`);
  let holder: pg.Client | undefined;
  const profilePath = join(tempDirectory, 'settle-profile.jsonl');
  const previousProfile = process.env.GROWTH_PROFILE;
  process.env.GROWTH_PROFILE = profilePath;
  try {
    const captured = await captureReviews(async () => {
      try {
        await checkGrowth(db, {
          name: 'settle and statements evidence',
          rule: 'series',
          scales: [1, 4, 16],
          repetitions: 1,
          bounds: { rows: 'linear', blocks: 'logarithmic', statements: 'constant' },
          grow: async (database, scale, previous) => {
            await database.admin.query(
              `INSERT INTO ${settlingRows} (id,body)
               SELECT ids.row_id, string_agg(md5(ids.row_id::text || ':' || parts.part::text), '')
                 FROM generate_series($1::integer + 1,$2::integer) AS ids(row_id)
                 CROSS JOIN generate_series(1,16) AS parts(part)
                GROUP BY ids.row_id`,
              [previous * 50, scale * 50],
            );
          },
          warmup: async (database) => countStatements(database, 1),
          prepare: async () => {
            if (holder) return;
            holder = new pg.Client({ connectionString: databaseUrl, application_name: 'growth-verdict-snapshot' });
            await holder.connect();
            await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
            await holder.query(`SELECT count(*) FROM ${settlingRows}`);
          },
          operation: async (database, scale) => {
            await withConnection(database.pool, (client) =>
              client.query(`SELECT sum(length(body)) FROM ${settlingRows}`),
            );
            await countStatements(database, scale === 1 ? 69 : scale === 4 ? 79 : 86);
          },
        });
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(captured.value).toBeInstanceOf(GrowthBoundError);
    const error = captured.value as GrowthBoundError;
    expect(error.message).toContain('statements violates constant growth bound');
    expect(error.message).toContain('blocks violates logarithmic growth bound');
    const measuredSamples = error.samples as unknown as readonly ReportSample[];
    expect(measuredSamples).toHaveLength(3);
    expect(measuredSamples.every(({ settleFailures }) => !settleFailures?.length)).toBe(true);
    expect(
      measuredSamples.every(({ repetitions }) => repetitions[0]!.rows > 0 && repetitions[0]!.blocks > 0),
    ).toBe(true);
    expect(captured.lines.map(reviewJson).some(({ metric }) => metric === 'blocks')).toBe(true);
    expect(captured.lines.map(reviewJson).some(({ reason }) => reason === 'settle')).toBe(false);
    const profileLine = JSON.parse((await readFile(profilePath, 'utf8')).trim());
    expect(profileLine.settleFailures).toEqual([[], [], []]);
  } finally {
    if (holder) {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    }
    if (previousProfile === undefined) delete process.env.GROWTH_PROFILE;
    else process.env.GROWTH_PROFILE = previousProfile;
  }
}, 120_000);

test('seed succeeds with an unrelated held snapshot and emits no settle review', async () => {
  await db.admin.query(`TRUNCATE ${seedRows}`);
  const holder = new pg.Client({ connectionString: databaseUrl, application_name: 'growth-seed-snapshot' });
  await holder.connect();
  await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await holder.query(`SELECT count(*) FROM ${seedRows}`);
  const population: Population = {
    name: 'seed settle review',
    hotPartition: 0,
    rows: () => ({ [seedRows]: [{ id: 1 }] }),
  };
  try {
    const captured = await captureReviews(() =>
      seed({ pool: db.pool, admin: db.admin }, population, { from: 0, to: 1 }),
    );
    expect(captured.value).toBeUndefined();
    expect(captured.lines).toHaveLength(0);
    expect((await holder.query(`SELECT count(*)::integer AS count FROM ${seedRows}`)).rows[0]!.count).toBe(0);
    const result = await db.admin.query(`SELECT id FROM ${seedRows} WHERE id=1`);
    expect(result.rowCount).toBe(1);
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await holder.end();
  }
}, 120_000);
