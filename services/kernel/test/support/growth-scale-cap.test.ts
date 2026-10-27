import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase, type GrowthCheck } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
});

afterAll(async () => {
  await db.close();
});

const bounds: GrowthCheck['bounds'] = { rows: 'constant', blocks: 'constant', statements: 'constant' };

test('a growth check whose largest scale exceeds 4096 is refused before it seeds', async () => {
  let growCalls = 0;
  await expect(
    checkGrowth(db, {
      name: 'over-limit growth check',
      scales: [128, 1024, 8192],
      bounds,
      grow: async () => {
        growCalls++;
      },
      operation: async () => undefined,
    }),
  ).rejects.toMatchObject({ name: 'TypeError', message: expect.stringContaining('4096') });
  expect(growCalls).toBe(0);
});

test('a largest scale of 4096 is accepted', async () => {
  const stopAfterValidation = new Error('stop after scale validation');
  let grownScale: number | undefined;
  await expect(
    checkGrowth(db, {
      name: 'maximum growth check',
      scales: [64, 512, 4096],
      bounds,
      grow: async (_database, scale) => {
        grownScale = scale;
        throw stopAfterValidation;
      },
      operation: async () => undefined,
    }),
  ).rejects.toBe(stopAfterValidation);
  expect(grownScale).toBe(64);
});
