import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, type GrowthCheck, type GrowthDatabase } from './growth.ts';

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
    message: expect.stringContaining('counted unit candidates at scale 64: value 64 exceeds limit 8'),
  });
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
