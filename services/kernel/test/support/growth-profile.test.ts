import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withConnection } from '../../src/database/pool.ts';
import {
  checkGrowth,
  growthFailureEvidence,
  openGrowthDatabase,
  seed,
  type GrowthCheck,
  type GrowthDatabase,
  type Population,
} from './growth.ts';
import { readGrowthProfiles } from './growth-profile-read.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_profile_test';
const bulk = `${schema}.bulk`;
const written = `${schema}.written`;
const bulkPerScale = 10;
const writesPerScale = 2;

const bulkPopulation: Population = {
  name: 'growth-profile-bulk',
  hotPartition: 5,
  rows: ({ ordinal, route }) => ({ [bulk]: [{ route, id: ordinal }] }),
};
const writtenPopulation: Population = {
  name: 'growth-profile-written',
  hotPartition: 6,
  write: ({ pool }, { ordinal, route }) =>
    withConnection(pool, (client) =>
      client.query(`INSERT INTO ${written} (route, id) VALUES ($1, $2)`, [route, ordinal]).then(() => undefined),
    ),
};

let db: GrowthDatabase | undefined;
let directory = '';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'growth-profile-'));
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${bulk} (
    route integer NOT NULL, id integer NOT NULL, PRIMARY KEY (route, id)
  ) WITH (autovacuum_enabled = false)`);
  await db.admin.query(
    `CREATE TABLE ${written} (route integer NOT NULL, id integer NOT NULL, PRIMARY KEY (route, id))`,
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  if (!db) return;
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

async function withProfile<T>(path: string | undefined, work: () => Promise<T>): Promise<T> {
  const previous = process.env.GROWTH_PROFILE;
  if (path === undefined) delete process.env.GROWTH_PROFILE;
  else process.env.GROWTH_PROFILE = path;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.GROWTH_PROFILE;
    else process.env.GROWTH_PROFILE = previous;
  }
}

const bounds = {
  rows: 'constant',
  blocks: 'constant',
  statements: 'constant',
} as const;
const operation: GrowthCheck['operation'] = (growthDb) =>
  withConnection(growthDb.pool, (client) => client.query('SELECT 1 AS answer'));

test("checkGrowth reports each scale's seeding cost and appends it to the growth profile", async () => {
  const database = db!;
  await database.admin.query(`TRUNCATE ${bulk}, ${written}`);
  const path = join(directory, 'profile.jsonl');

  const report = await withProfile(path, () =>
    checkGrowth(database, {
      name: 'growth profile seeding',
      bounds,
      repetitions: 1,
      grow: async (growthDb, scale, previous) => {
        const target = { pool: growthDb.pool, admin: growthDb.admin };
        await seed(target, bulkPopulation, {
          from: previous * bulkPerScale,
          to: scale * bulkPerScale,
        });
        await seed(target, writtenPopulation, {
          from: previous * writesPerScale,
          to: scale * writesPerScale,
        });
      },
      operation,
    }),
  );

  // One bulk batch is BEGIN, INSERT and COMMIT through admin; each written ordinal is one INSERT through the pool.
  expect(report.verdicts.rows.outcome).toBe('compatible');
  expect(report.verdicts.blocks.outcome).toBe('compatible');
  expect(report.verdicts.statements.outcome).toBe('compatible');
  const expected = [1, 7, 56].map((added) => ({
    statements: 3 + added * writesPerScale,
    rowsWritten: added * (bulkPerScale + writesPerScale),
  }));
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  report.samples.forEach(({ seeding }, index) => {
    expect(seeding).toMatchObject(expected[index]!);
    expect(Number.isFinite(seeding.growMs) && seeding.growMs >= 0).toBe(true);
    expect(Number.isFinite(seeding.vacuumMs) && seeding.vacuumMs >= 0).toBe(true);
  });

  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  expect(lines).toHaveLength(1);
  const profile = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(profile).toMatchObject({
    file: expect.stringMatching(/growth-profile\.test\.ts$/),
    check: 'growth profile seeding',
    scales: [1, 8, 64],
    seeding: report.samples.map(({ seeding }) => seeding),
  });

  await withProfile(path, () =>
    checkGrowth(database, {
      name: 'growth profile second',
      bounds,
      repetitions: 1,
      grow: async () => {},
      operation,
    }),
  );
  const second = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  expect(second).toHaveLength(2);
  expect(JSON.parse(second[1]!)).toMatchObject({
    check: 'growth profile second',
    seeding: expect.any(Array),
  });
}, 60_000);

test('a profile that cannot be written warns once and never fails a check', async () => {
  const database = db!;
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const path = join(directory, 'missing', 'profile.jsonl');
    for (const name of ['growth profile unwritable first', 'growth profile unwritable second']) {
      await withProfile(path, () =>
        checkGrowth(database, {
          name,
          bounds,
          repetitions: 1,
          grow: async () => {},
          operation,
        }),
      );
    }
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
}, 60_000);

test('a failed check exports incomplete native evidence and keeps export failure secondary', async () => {
  const database = db!;
  const primary = new Error('verification failed after native capture');
  const destination = join(directory, 'failed.jsonl');
  let thrown: unknown;
  try {
    await withProfile(destination, () =>
      checkGrowth(database, {
        name: 'failed profile diagnostic',
        bounds,
        repetitions: 1,
        grow: async () => {},
        warmup: async () => {},
        operation,
        verify: async () => {
          throw primary;
        },
      }),
    );
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBe(primary);
  const evidence = growthFailureEvidence(thrown);
  expect(evidence).toMatchObject({
    kind: 'growth-failure-diagnostic',
    status: 'incomplete',
    phase: 'verification',
    check: 'failed profile diagnostic',
    primary: { value: primary },
  });
  expect((evidence?.native as { nativeCaptures: readonly unknown[] }).nativeCaptures.length).toBeGreaterThan(0);

  const lines = (await readFile(destination, 'utf8')).split('\n').filter(Boolean);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    kind: 'growth-failure-diagnostic',
    status: 'incomplete',
    phase: 'verification',
    check: 'failed profile diagnostic',
  });
  const read = readGrowthProfiles([{ name: 'failed-check-run', text: lines[0]! }]);
  expect(read.entries).toEqual([]);
  expect(read.series.rows).toEqual([]);
  expect(read.diagnostics).toMatchObject([{ run: 'failed-check-run', phase: 'verification', scale: 1, repetition: 1 }]);

  const exportPrimary = new Error('verification failed before profile could be written');
  const missingDestination = join(directory, 'missing', 'failed.jsonl');
  thrown = undefined;
  try {
    await withProfile(missingDestination, () =>
      checkGrowth(database, {
        name: 'failed profile export',
        bounds,
        repetitions: 1,
        grow: async () => {},
        warmup: async () => {},
        operation,
        verify: async () => {
          throw exportPrimary;
        },
      }),
    );
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBe(exportPrimary);
  const failedExportEvidence = growthFailureEvidence(thrown);
  expect(failedExportEvidence?.secondary).toContainEqual(
    expect.objectContaining({
      phase: 'profile-export',
      value: expect.objectContaining({ name: 'GrowthProfileExportError' }),
    }),
  );
}, 60_000);

test('hostile error accessors keep the original raw and folded failure in profile diagnostics', async () => {
  const database = db!;
  const query = 'SELECT 719 AS hostile_error_summary';

  for (const captureMode of ['raw', 'cost-folded'] as const) {
    const destination = join(directory, `hostile-${captureMode}.jsonl`);
    const primary = new Error('summary is unavailable');
    const accessorFailure = new Error('hostile summary accessor');
    Object.defineProperties(primary, {
      name: {
        configurable: true,
        get: () => {
          throw accessorFailure;
        },
      },
      message: {
        configurable: true,
        get: () => {
          throw accessorFailure;
        },
      },
      code: {
        configurable: true,
        get: () => {
          throw accessorFailure;
        },
      },
      sqlState: {
        configurable: true,
        get: () => {
          throw accessorFailure;
        },
      },
    });

    let thrown: unknown;
    try {
      await withProfile(destination, () =>
        checkGrowth(database, {
          name: `hostile error summary ${captureMode}`,
          scales: [1, 8, 64],
          repetitions: 1,
          bounds,
          captureMode,
          grow: async () => {},
          warmup: async () => {},
          operation: async (growthDb) => {
            await withConnection(growthDb.pool, (client) => client.query(query));
            throw primary;
          },
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(primary);
    const diagnostic = growthFailureEvidence(thrown);
    expect(diagnostic).toMatchObject({
      kind: 'growth-failure-diagnostic',
      status: 'incomplete',
      phase: 'operation',
      scale: 1,
      captureMode,
      primary: {
        value: primary,
        omittedDescriptionFields: ['name', 'message', 'sqlstate'],
      },
    });
    const lines = (await readFile(destination, 'utf8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      kind: 'growth-failure-diagnostic',
      status: 'incomplete',
      phase: 'operation',
      captureMode,
      cause: { omittedDescriptionFields: ['name', 'message', 'sqlstate'] },
    });
    expect(JSON.stringify(record)).toContain(query);
    const imported = readGrowthProfiles([{ name: `hostile-${captureMode}`, text: lines[0]! }]);
    expect(imported.entries).toEqual([]);
    expect(imported.diagnostics).toMatchObject([{ phase: 'operation', scale: 1, captureMode }]);
  }
}, 60_000);

type Counts = { readonly vacuumCount: number; readonly analyzeCount: number };

async function counts(database: GrowthDatabase): Promise<Counts> {
  const result = await database.admin.query<Counts>(
    `SELECT vacuum_count::integer AS "vacuumCount", analyze_count::integer AS "analyzeCount"
     FROM pg_stat_user_tables WHERE relid = '${bulk}'::regclass`,
  );
  return result.rows[0]!;
}

test('seed inside a grow leaves the vacuum to checkGrowth', async () => {
  const database = db!;
  await database.admin.query(`TRUNCATE ${bulk}, ${written}`);
  const target = { pool: database.pool, admin: database.admin };
  const population: Population = {
    ...bulkPopulation,
    name: 'growth-profile-vacuum',
  };
  const beforeGrow: Counts[] = [];
  const afterGrow: Counts[] = [];

  await withProfile(undefined, () =>
    checkGrowth(database, {
      name: 'growth profile vacuum',
      bounds,
      repetitions: 1,
      grow: async (growthDb, scale, previous) => {
        beforeGrow.push(await counts(growthDb));
        await seed(target, population, {
          from: previous * bulkPerScale,
          to: scale * bulkPerScale,
        });
        await seed(target, population, {
          from: scale * bulkPerScale,
          to: scale * bulkPerScale,
        });
      },
      warmup: async (growthDb) => {
        afterGrow.push(await counts(growthDb));
      },
      operation,
    }),
  );

  expect(beforeGrow).toHaveLength(3);
  expect(afterGrow).toHaveLength(3);
  afterGrow.forEach((after, index) => {
    expect(after.vacuumCount).toBe(beforeGrow[index]!.vacuumCount + 1);
    expect(after.analyzeCount).toBe(beforeGrow[index]!.analyzeCount + 1);
  });

  const before = await counts(database);
  await seed(target, population, {
    from: 3 * 64 * bulkPerScale,
    to: 3 * 64 * bulkPerScale + 5,
  });
  const after = await counts(database);
  expect(after.vacuumCount).toBe(before.vacuumCount + 1);
  expect(after.analyzeCount).toBe(before.analyzeCount + 1);
}, 60_000);
