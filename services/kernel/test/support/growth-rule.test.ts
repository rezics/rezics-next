import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import {
  openGrowthDatabase,
  checkGrowth,
  GrowthBoundError,
  GrowthEvidenceError,
  type GrowthDatabase,
} from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const schema = 'growth_rule_test';
const table = `${schema}.records`;
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
});
afterAll(async () => {
  await db?.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db?.close();
});

async function check(
  name: string,
  options: {
    rule?: 'step' | 'series';
    repetitions?: number;
    variable?: boolean;
    fixed?: boolean;
    indexProbes?: number;
    constantBlocks?: boolean;
  } = {},
) {
  await db.admin.query(`TRUNCATE ${table}`);
  return await checkGrowth(db, {
    name,
    ...(options.rule === undefined ? {} : { rule: options.rule }),
    ...(options.repetitions === undefined ? {} : { repetitions: options.repetitions }),
    bounds: {
      rows: options.fixed ? 'linear' : 'constant',
      blocks: options.constantBlocks ? 'constant' : 'linear',
      statements: 'linear',
    },
    ...(options.indexProbes === undefined ? {} : { indexProbes: options.indexProbes }),
    slack: { rows: { absolute: 0, relative: 0 } },
    grow: async (database, scale, previous) => {
      await database.admin.query(`INSERT INTO ${table} SELECT generate_series($1 + 1, $2)`, [previous, scale]);
    },
    operation: async (database, _scale, repetition) =>
      withConnection(database.pool, async (client) => {
        if (options.variable) {
          const count = repetition % 2 === 0 ? 1 : 100;
          const first = 100_000 + repetition * 100;
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO ${table} SELECT generate_series($1::integer, $1::integer + $2::integer - 1)`,
            [first, count],
          );
          await client.query(`SELECT id FROM ${table} WHERE id >= $1`, [first]);
          await client.query('ROLLBACK');
        } else if (options.fixed) {
          await client.query(`SELECT id FROM ${table} WHERE id = 1`);
        } else {
          await client.query(`SELECT id FROM ${table}`);
        }
      }),
  });
}

test('the series rule fails a series no allowed family explains with GrowthBoundError', async () => {
  await expect(check('series constant violation', { rule: 'series' })).rejects.toBeInstanceOf(GrowthBoundError);
});

test('the series rule fails dispersed evidence with GrowthEvidenceError', async () => {
  await expect(
    check('series uncertain repetitions', { rule: 'series', repetitions: 3, variable: true }),
  ).rejects.toBeInstanceOf(GrowthEvidenceError);
});

test('the step rule stays the default and GROWTH_RULE=series selects the series rule', async () => {
  const prior = process.env.GROWTH_RULE;
  try {
    delete process.env.GROWTH_RULE;
    expect((await check('default step rule', { fixed: true })).rule).toBe('step');
    process.env.GROWTH_RULE = 'series';
    expect((await check('environment series rule', { fixed: true })).rule).toBe('series');
  } finally {
    if (prior === undefined) delete process.env.GROWTH_RULE;
    else process.env.GROWTH_RULE = prior;
  }
});

test('indexProbes requires a positive safe integer and a non-constant blocks bound', async () => {
  for (const indexProbes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(check('invalid probe count', { indexProbes })).rejects.toThrow(
      'invalid probe count: indexProbes must be a positive safe integer',
    );
  }
  await expect(check('constant probe count', { indexProbes: 1, constantBlocks: true })).rejects.toThrow(
    'constant probe count: indexProbes cannot be used with a constant blocks bound',
  );
});
