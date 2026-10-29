import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, GrowthBoundError, openGrowthDatabase, type GrowthDatabase } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_attribution_test';
const rows = `${schema}.rows`;
const events = `${schema}.events`;
let db: GrowthDatabase | undefined;
let directory = '';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'growth-attribution-'));
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${rows} (id integer PRIMARY KEY) WITH (autovacuum_enabled = false)`);
  await db.admin.query(`CREATE TABLE ${events} (label text NOT NULL) WITH (autovacuum_enabled = false)`);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  if (!db) return;
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

test('failed growth reports normalized statement costs, plan nodes, and intermittent repetitions', async () => {
  const database = db!;
  await database.admin.query(`TRUNCATE ${rows}, ${events}`);
  const profilePath = join(directory, 'profile.jsonl');
  const previousProfile = process.env.GROWTH_PROFILE;
  process.env.GROWTH_PROFILE = profilePath;
  const eventsSeen: string[] = [];
  let failure: GrowthBoundError | undefined;
  try {
    await checkGrowth(database, {
      name: 'statement attribution',
      repetitions: 3,
      bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
      grow: async (growthDb, scale) => {
        await growthDb.admin.query(`INSERT INTO ${rows} SELECT generate_series(1, $1) ON CONFLICT DO NOTHING`, [
          scale * 20,
        ]);
      },
      warmup: async (_growthDb, scale, repetition) => {
        eventsSeen.push(`warmup:${scale}:${repetition}`);
      },
      prepare: async (growthDb, scale, repetition) => {
        eventsSeen.push(`prepare:${scale}:${repetition}`);
        await growthDb.admin.query(`INSERT INTO ${events} (label) VALUES ($1)`, [`${scale}:${repetition}`]);
      },
      operation: (growthDb, scale, repetition) =>
        withConnection(growthDb.pool, async (client) => {
          eventsSeen.push(`operation:${scale}:${repetition}`);
          await client.query(`/* growth-tag */ SELECT id FROM ${rows} WHERE id <= ${scale * 20}`);
          await client.query(`SELECT id FROM ${rows} WHERE id = $1`, [scale * 20]);
          if (repetition % 2 === 1) await client.query(`SELECT 1 AS occasional_value_${scale}`);
        }),
    });
  } catch (error) {
    if (!(error instanceof GrowthBoundError)) throw error;
    failure = error;
  } finally {
    if (previousProfile === undefined) delete process.env.GROWTH_PROFILE;
    else process.env.GROWTH_PROFILE = previousProfile;
  }

  expect(failure).toBeInstanceOf(GrowthBoundError);
  expect(failure!.message).toContain('Statement attribution:');
  expect(failure!.message).toContain('Statements growing most for rows:');
  expect(failure!.message).toContain('/* growth-tag */ SELECT id FROM');
  expect(failure!.message).toContain('growth_attribution_test.rows');
  expect(failure!.message).toContain('Intermittent at scale 1: SELECT ? AS occasional_value_1 ran in repetitions 1, 3');

  for (const scale of [1, 8, 64]) {
    const prepareIndices = eventsSeen.flatMap((event, index) => (event.startsWith(`prepare:${scale}:`) ? [index] : []));
    const operationIndices = eventsSeen.flatMap((event, index) =>
      event.startsWith(`operation:${scale}:`) ? [index] : [],
    );
    expect(prepareIndices).toHaveLength(3);
    expect(operationIndices).toHaveLength(3);
    prepareIndices.forEach((index, repetition) => expect(index).toBeLessThan(operationIndices[repetition]!));
  }
  expect(eventsSeen.filter((event) => event.startsWith('prepare:')).length).toBe(9);
  expect(eventsSeen.some((event) => event === 'prepare:1:0')).toBe(false);

  const profile = JSON.parse((await readFile(profilePath, 'utf8')).trim()) as {
    statements: { statement: string; rows: number; blocks: number; count: number }[][];
  };
  expect(profile.statements).toHaveLength(3);
  for (const statements of profile.statements) {
    expect(statements).toContainEqual(
      expect.objectContaining({
        statement: expect.stringContaining('/* growth-tag */'),
        rows: expect.any(Number),
        blocks: expect.any(Number),
        count: 3,
      }),
    );
    expect(statements).toContainEqual(
      expect.objectContaining({ statement: expect.stringContaining('WHERE id = $1'), count: 3 }),
    );
  }
}, 60_000);
