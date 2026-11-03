import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withConnection } from '../../src/database/pool.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  placement,
  seed,
  type GrowthCheck,
  type GrowthDatabase,
  type Population,
} from './growth.ts';
import {
  COUNTED_UNIT_LIMITS,
  countedNames,
  countedSample,
  countedViolations,
  medianCounted,
  validateCountedConfig,
  validateCountedRun,
} from './growth-counters.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase | undefined;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
});
afterAll(async () => {
  await db?.close();
});

function base(
  operation: GrowthCheck['operation'],
  counted: NonNullable<GrowthCheck['counted']>,
  extra: Partial<GrowthCheck> = {},
) {
  return checkGrowth(db!, {
    name: 'counted units',
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {},
    operation,
    counted,
    repetitions: 3,
    warmups: 1,
    ...extra,
  });
}

const query: GrowthCheck['operation'] = (database) =>
  withConnection(database.pool, async (client) => (await client.query('SELECT 1')).rows[0]);

test('a counted unit over its numeric limit fails at a scale and identifies its value and limit', async () => {
  await expect(
    base(query, {
      read: (_value, scale) => ({ candidates: scale }),
      limits: { candidates: 8 },
    }),
  ).rejects.toMatchObject({
    name: 'GrowthBoundError',
    message: expect.stringContaining('counted unit candidates at scale 64 repetition 1: value 64 exceeds limit 8'),
  });
}, 60_000);

test('a counted limit rejects an over-limit repetition when its median passes', async () => {
  await expect(
    base(async (_database, _scale, repetition) => ({ count: repetition % 3 === 0 ? 9 : 1 }), {
      read: (value) => ({ candidates: (value as { count: number }).count }),
      limits: { candidates: 3 },
    }),
  ).rejects.toThrow('counted unit candidates at scale 1 repetition 3: value 9 exceeds limit 3');
}, 60_000);

test('counted growth is checked while rows, blocks and statements satisfy their bounds', async () => {
  await expect(
    base(query, {
      read: (_value, scale) => ({ candidates: scale }),
      bounds: { candidates: 'constant' },
    }),
  ).rejects.toMatchObject({
    name: 'GrowthBoundError',
    message: expect.stringContaining('counted unit candidates at scale 64: value 64 violates constant growth bound'),
    violations: [],
  });
}, 60_000);

test('counted units report the median and repetitions in the report and growth profile', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'growth-counted-'));
  const profile = join(directory, 'profile.jsonl');
  const previous = process.env.GROWTH_PROFILE;
  process.env.GROWTH_PROFILE = profile;
  try {
    const report = await base(
      async (database, _scale, repetition) => {
        await withConnection(database.pool, (client) => client.query('SELECT 1'));
        return { count: [1, 2, 3][repetition % 3] };
      },
      { read: (value) => ({ slots: (value as { count: number }).count }), limits: { slots: 3 } },
    );
    expect(report.samples.every(({ counted }) => counted?.slots?.value === 2)).toBe(true);
    expect(
      report.samples.every(({ counted }) => counted?.slots?.repetitions.reduce((sum, value) => sum + value, 0) === 6),
    ).toBe(true);
    const profileLine = JSON.parse(readFileSync(profile, 'utf8').trim());
    expect(profileLine.counted).toEqual(report.samples.map(({ counted }) => counted));
  } finally {
    if (previous === undefined) delete process.env.GROWTH_PROFILE;
    else process.env.GROWTH_PROFILE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test('a configured counted unit missing from a measured run fails the check', async () => {
  await expect(
    base(query, {
      read: () => ({}),
      limits: { slots: 4 },
    }),
  ).rejects.toThrow('Counted unit slots was not reported at scale 1');
}, 60_000);

test('connections counts distinct operation backends and requires backend capture', async () => {
  const operation: GrowthCheck['operation'] = async (database) => {
    await Promise.all([0, 1].map(() => withConnection(database.pool, (client) => client.query('SELECT 1'))));
    return null;
  };
  const report = await base(operation, { read: () => ({}), limits: { connections: 2 } }, { includeBackends: true });
  expect(report.samples.every(({ counted }) => counted?.connections?.value === 2)).toBe(true);
  await expect(base(query, { read: () => ({}), limits: { connections: 1 } })).rejects.toThrow(
    'Counted unit connections is unavailable at scale 1: capture did not include backends',
  );
}, 60_000);

test('counted medians require complete matching non-negative safe-integer repetitions', () => {
  expect(() => medianCounted([{ examined: 1 }, {}, { examined: 3 }])).toThrow(/missing or mismatched unit names/);
  expect(() => medianCounted([{ examined: 1 }, { rows: 2 }])).toThrow(/missing or mismatched unit names/);
  expect(() => medianCounted([{ examined: -1 }])).toThrow(/non-negative safe integer/);
  expect(() => medianCounted([{ examined: Number.NaN }])).toThrow(/non-negative safe integer/);
  const sparseRuns = [{ examined: 1 }, , { examined: 3 }] as Array<{ examined: number }>;
  expect(() => medianCounted(sparseRuns)).toThrow(/missing item 2/);
  expect(medianCounted([{ examined: 1 }, { examined: 2 }])).toEqual({ examined: 1.5 });
  expect(countedSample([{ examined: 1 }, { examined: 2 }])).toEqual({
    examined: { value: 1.5, repetitions: [1, 2] },
  });
  expect(() =>
    medianCounted([{ examined: Number.MAX_SAFE_INTEGER - 1 }, { examined: Number.MAX_SAFE_INTEGER }]),
  ).toThrow(/not exactly representable/);
  expect(medianCounted([{ examined: 0 }])).toEqual({ examined: 0 });
});

test('counted runs validate their configuration, supplied units and scale before aggregation', () => {
  const check = { read: () => ({}), limits: { slots: 3 } };
  expect(validateCountedRun(check, { slots: 0 }, 1)).toEqual({ slots: 0 });
  expect(() => validateCountedRun(check, { slots: -1 }, 1)).toThrow(/non-negative safe integer/);
  expect(() => validateCountedRun(check, {}, 1)).toThrow(/was not reported/);
  expect(() => validateCountedRun(check, { slots: 1 }, Number.POSITIVE_INFINITY)).toThrow(/scale/);
});

test('counted comparisons require configured medians and coherent scale repetitions', () => {
  const check = { read: () => ({}), bounds: { examined: 'constant' as const } };
  const makeSample = (scale: number, values: number[]) => ({
    scale,
    counted: countedSample(values.map((examined) => ({ examined }))),
  });
  const valid = [makeSample(1, [1, 2]), makeSample(8, [1, 2]), makeSample(64, [1, 2])];
  expect(countedViolations(check, valid)).toEqual([]);
  expect(() =>
    countedViolations(
      check,
      valid.map(({ scale }) => ({ scale, counted: {} })),
    ),
  ).toThrow(/missing/);
  expect(() =>
    countedViolations(check, [valid[0]!, valid[1]!, { scale: 64, counted: countedSample([{ examined: 1 }]) }]),
  ).toThrow(/incoherent/);
  expect(() => countedViolations(check, [valid[0]!, valid[1]!, { ...valid[2]!, scale: Number.NaN }])).toThrow(/scale/);
  expect(() =>
    countedViolations({ ...check, slack: { examined: { absolute: 0, relative: Number.MAX_VALUE } } }, [
      makeSample(1, [Number.MAX_SAFE_INTEGER]),
      makeSample(8, [Number.MAX_SAFE_INTEGER]),
      makeSample(64, [Number.MAX_SAFE_INTEGER]),
    ]),
  ).toThrow(/growth slack/);
  expect(countedViolations({ read: () => ({}) }, [])).toEqual([]);
});

function unitDictionary(count: number, name = (index: number) => `u${index}`, value = 1): Record<string, number> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [name(index), value]));
}

test('counted configuration admits a finite unit-name budget before sorting and keeps own custom names', () => {
  const tooMany = unitDictionary(COUNTED_UNIT_LIMITS.units + 1);
  expect(() => validateCountedConfig({ read: () => ({}), limits: tooMany })).toThrow(
    `Counted checks exceed the ${COUNTED_UNIT_LIMITS.units} unit capacity`,
  );
  expect(() => countedNames({ read: () => ({}), limits: tooMany })).toThrow(
    `Counted checks exceed the ${COUNTED_UNIT_LIMITS.units} unit capacity`,
  );
  const long = 'n'.repeat(COUNTED_UNIT_LIMITS.nameBytes + 1);
  expect(() => validateCountedConfig({ read: () => ({}), limits: { [long]: 1 } })).toThrow(
    `Counted unit name in limits exceeds the ${COUNTED_UNIT_LIMITS.nameBytes} byte name limit`,
  );
  expect(() =>
    validateCountedConfig({
      read: () => ({}),
      bounds: { slots: 'constant' },
      slack: { [long]: { absolute: 0, relative: 0 } },
    }),
  ).toThrow(`Counted unit name in slack exceeds the ${COUNTED_UNIT_LIMITS.nameBytes} byte name limit`);
  const allowed = unitDictionary(COUNTED_UNIT_LIMITS.units);
  expect(countedNames({ read: () => ({}), limits: allowed })).toEqual(Object.keys(allowed).sort());
  const inherited = Object.assign(Object.create({ inherited: 9 }), { custom: 4, diagnostic: 1 });
  expect(countedNames({ read: () => ({}), limits: inherited })).toEqual(['custom', 'diagnostic']);
  expect(
    validateCountedConfig({
      read: () => ({}),
      limits: { slots: 1 },
      slack: { slots: { absolute: 0, relative: 0 } },
    }).declared.has('slots'),
  ).toBe(true);
  expect(() =>
    validateCountedConfig({
      read: () => ({}),
      limits: { slots: 1 },
      slack: { other: { absolute: 0, relative: 0 } },
    }),
  ).toThrow('Slack configured for undeclared counted unit other');
});

test('returned counted evidence keeps undeclared diagnostic units and refuses oversized runs before medians', () => {
  const check = { read: () => ({}), limits: { slots: 3 } };
  expect(validateCountedRun(check, { slots: 1, extra: 2 }, 1)).toEqual({ slots: 1, extra: 2 });
  expect(
    countedSample([
      { slots: 1, extra: 2 },
      { slots: 3, extra: 4 },
    ]),
  ).toEqual({
    extra: { value: 3, repetitions: [2, 4] },
    slots: { value: 2, repetitions: [1, 3] },
  });
  const inherited = Object.assign(Object.create({ inherited: 9 }), { slots: 2, extra: 5 });
  expect(validateCountedRun(check, inherited, 1)).toEqual({ slots: 2, extra: 5 });
  const oversized = { slots: 1, ...unitDictionary(COUNTED_UNIT_LIMITS.units) };
  expect(() => validateCountedRun(check, oversized, 1)).toThrow(
    `Counted checks exceed the ${COUNTED_UNIT_LIMITS.units} unit capacity`,
  );
  expect(() => medianCounted([oversized])).toThrow(
    `Counted checks exceed the ${COUNTED_UNIT_LIMITS.units} unit capacity`,
  );
  expect(() => validateCountedRun(check, {}, 1)).toThrow('Counted unit slots was not reported at scale 1');
});

test('oversized counted configuration is rejected before grow, warmup or operation', async () => {
  const calls: string[] = [];
  await expect(
    checkGrowth(db!, {
      name: 'too many counted units',
      bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
      grow: async () => {
        calls.push('grow');
      },
      warmup: async () => {
        calls.push('warmup');
      },
      operation: async () => {
        calls.push('operation');
      },
      counted: { read: () => ({}), limits: unitDictionary(COUNTED_UNIT_LIMITS.units + 1) },
    }),
  ).rejects.toThrow(
    `too many counted units: counted: Counted checks exceed the ${COUNTED_UNIT_LIMITS.units} unit capacity`,
  );
  expect(calls).toEqual([]);
});

const nativeSchema = 'growth_counted_native';
const recordsTable = `${nativeSchema}.records`;
const historyTable = `${nativeSchema}.history`;
const neighborhoodIds = [1, 2, 3, 4];
const keepSlots = 2;
const ordinalsPerScale = 32;

function presentRemovedRows(plans: readonly unknown[]): number | undefined {
  let removed: number | undefined;
  const visit = (node: Record<string, unknown>) => {
    const loops = typeof node['Actual Loops'] === 'number' ? node['Actual Loops'] : 1;
    for (const field of ['Rows Removed by Filter', 'Rows Removed by Index Recheck'] as const) {
      const value = node[field];
      if (typeof value === 'number') removed = (removed ?? 0) + value * loops;
    }
    if (Array.isArray(node.Plans)) for (const child of node.Plans) visit(child as Record<string, unknown>);
  };
  for (const document of plans) {
    const entries = Array.isArray(document) ? document : [document];
    for (const entry of entries) {
      if (typeof entry === 'object' && entry !== null && 'Plan' in entry)
        visit((entry as { Plan: Record<string, unknown> }).Plan);
    }
  }
  return removed;
}

async function runWithPoller(pool: GrowthDatabase['pool'], work: () => Promise<void>): Promise<void> {
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending
      .then(() => pool.query('SELECT 1'))
      .then(
        () => {},
        () => {},
      );
  }, 5);
  try {
    await work();
  } finally {
    clearInterval(timer);
    await pending;
  }
}

test('counted-unit-ceilings-at-three-scales', async () => {
  const database = db!;
  await database.admin.query(`DROP SCHEMA IF EXISTS ${nativeSchema} CASCADE`);
  try {
    await database.admin.query(`CREATE SCHEMA ${nativeSchema}`);
    await database.admin.query(`CREATE TABLE ${recordsTable} (
      route integer NOT NULL,
      id integer NOT NULL,
      payload jsonb NOT NULL,
      PRIMARY KEY (route, id)
    )`);
    await database.admin.query(`CREATE TABLE ${historyTable} (
      route integer NOT NULL,
      id integer NOT NULL,
      payload jsonb NOT NULL,
      PRIMARY KEY (route, id)
    )`);
    const recordsPopulation: Population = {
      name: 'counted-native-records',
      hotPartition: 41,
      rows: ({ ordinal, route }) => ({
        [recordsTable]: [{ route, id: ordinal + 100, payload: { group: 'unrelated' } }],
      }),
    };
    const historyPopulation: Population = {
      name: 'counted-native-history',
      hotPartition: 77,
      rows: ({ ordinal, route }) => ({
        [historyTable]: [{ route, id: ordinal + 1, payload: { group: 'history' } }],
      }),
    };
    const selected = placement(recordsPopulation, 0);
    await database.admin.query(
      `INSERT INTO ${recordsTable} (route, id, payload) VALUES
        ($1, 0, $2), ($1, 1, $3), ($1, 2, $3), ($1, 3, $4), ($1, 4, $4)`,
      [selected.route, { group: 'anchor' }, { group: 'keep' }, { group: 'drop' }],
    );

    const operation: GrowthCheck['operation'] = (growthDb) =>
      withConnection(growthDb.pool, async (client) => {
        await client.query(`SELECT payload FROM ${recordsTable} WHERE route = $1 AND id = 0`, [selected.route]);
        let slots = 0;
        for (const id of neighborhoodIds) {
          const filtered = await client.query(
            `SELECT id FROM ${recordsTable} WHERE route = $1 AND id = $2 AND payload->>'group' = 'keep'`,
            [selected.route, id],
          );
          slots += filtered.rowCount ?? 0;
        }
        await client.query('SELECT pg_sleep(0.02)');
        return { slots };
      });

    const poller = database.openPool({ max: 2 });
    await poller.query('SELECT 1');
    let report: Awaited<ReturnType<typeof checkGrowth>>;
    await runWithPoller(poller, async () => {
      report = await checkGrowth(database, {
        name: 'counted-unit-ceilings-at-three-scales',
        rule: 'step',
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
        includeBackends: true,
        repetitions: 3,
        warmups: 1,
        counted: {
          read: (value) => ({ slots: (value as { slots: number }).slots }),
          limits: { slots: keepSlots, connections: 1 },
          bounds: { slots: 'constant', connections: 'constant' },
        },
        grow: async (growthDb, scale, previous) => {
          const range = { from: previous * ordinalsPerScale, to: scale * ordinalsPerScale };
          await seed({ pool: growthDb.pool, admin: growthDb.admin }, recordsPopulation, range);
          await seed({ pool: growthDb.pool, admin: growthDb.admin }, historyPopulation, range);
        },
        operation,
      });
    });

    expect(report!.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
    for (const sample of report!.samples) {
      expect(sample.counted?.slots).toBeDefined();
      expect(sample.counted?.connections).toBeDefined();
      expect(sample.counted!.slots!.repetitions).toHaveLength(3);
      expect(sample.counted!.connections!.repetitions).toHaveLength(3);
      expect(sample.backendRepetitions).toHaveLength(3);
      for (const [index, cost] of sample.repetitions.entries()) {
        const repetition = index + 1;
        expect(cost.rows, `examined rows at scale ${sample.scale} repetition ${repetition}`).toBeGreaterThan(
          sample.counted!.slots!.repetitions[index]!,
        );
        expect(cost.blocks, `shared blocks at scale ${sample.scale} repetition ${repetition}`).toBeGreaterThan(0);
        expect(cost.sharedHit + cost.sharedRead).toBe(cost.blocks);
        expect(cost.statements, `statements at scale ${sample.scale} repetition ${repetition}`).toBeGreaterThan(0);
        expect(cost.requestBytes, `request bytes at scale ${sample.scale} repetition ${repetition}`).toBeGreaterThan(0);
        expect(cost.responseBytes, `response bytes at scale ${sample.scale} repetition ${repetition}`).toBeGreaterThan(
          0,
        );
        expect(sample.counted!.slots!.repetitions[index]).toBe(keepSlots);
        expect(sample.counted!.connections!.repetitions[index]).toBe(1);
        expect(sample.backendRepetitions[index]).toHaveLength(1);
        expect(
          cost.backgroundStatements,
          `background statements at scale ${sample.scale} repetition ${repetition}`,
        ).toBeGreaterThan(0);
      }
    }

    const measured = await capture(database, () => operation(database, 64, 0), { includeBackends: true });
    const nativeCost = costOf(measured.capture);
    const removed = presentRemovedRows(measured.capture.plans);
    expect(removed, 'Rows Removed by Filter or Index Recheck is present on the native plan').toBeGreaterThan(0);
    expect(nativeCost.rows).toBeGreaterThan(keepSlots);
    expect(nativeCost.blocks).toBeGreaterThan(0);
    expect(nativeCost.requestBytes).toBeGreaterThan(0);
    expect(nativeCost.responseBytes).toBeGreaterThan(0);
    expect(new Set(measured.capture.statementBackends).size).toBe(1);
  } finally {
    await database.admin.query(`DROP SCHEMA IF EXISTS ${nativeSchema} CASCADE`);
  }
}, 60_000);
