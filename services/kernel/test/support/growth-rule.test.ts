import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { openGrowthDatabase, checkGrowth, GrowthBoundError, GrowthEvidenceError, type GrowthDatabase } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
beforeAll(async () => { db = await openGrowthDatabase(databaseUrl); });
afterAll(async () => { await db?.close(); });

function check(name: string, options: { rule?: 'step' | 'series'; repetitions?: number; variable?: boolean; fixed?: boolean } = {}) {
  return checkGrowth(db, {
    name,
    rule: options.rule,
    repetitions: options.repetitions,
    bounds: { rows: 'constant', blocks: 'linear', statements: 'linear' },
    slack: { rows: { absolute: 0, relative: 0 } },
    grow: async () => {},
    operation: async (_database, scale, repetition) => {
      const count = options.variable ? (repetition % 2 === 0 ? 1 : 12) : options.fixed ? 3 : scale;
      await withConnection(db.pool, (client) => client.query('SELECT generate_series(1, $1::integer)', [count]));
    },
  });
}

test('the series rule rejects a constant check whose rows grow by one per scale unit', async () => {
  await expect(check('series constant violation', { rule: 'series' })).rejects.toBeInstanceOf(GrowthBoundError);
});

test('the series rule reports dispersed repetitions as insufficient evidence', async () => {
  await expect(check('series uncertain repetitions', { rule: 'series', repetitions: 3, variable: true })).rejects.toBeInstanceOf(GrowthEvidenceError);
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
