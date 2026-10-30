import { expect, test } from 'bun:test';
import { GROWTH_BASELINE, validateGrowthBaseline } from './growth-baseline.ts';
import { afterAll, beforeAll } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const schema = 'growth_baseline_test';
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

async function run(name: string, extra: { rule?: 'step' | 'series'; allRows?: boolean; constantRows?: boolean } = {}) {
  await db.admin.query(`TRUNCATE ${table}`);
  return checkGrowth(db, {
    name,
    ...extra,
    bounds: { rows: extra.constantRows ? 'constant' : 'linear', blocks: 'linear', statements: 'linear' },
    slack: { rows: { absolute: extra.constantRows ? 100 : 0, relative: 0 } },
    grow: async (database, scale, previous) => {
      await database.admin.query(`INSERT INTO ${table} SELECT generate_series($1 + 1, $2)`, [previous, scale]);
    },
    operation: (database) =>
      withConnection(database.pool, (client) =>
        client.query(`SELECT id FROM ${table}${extra.allRows ? '' : ' WHERE id = 1'}`),
      ),
  });
}

test('baseline names are unique and every entry has an existing file, matching check name and reason', () => {
  expect(() => validateGrowthBaseline()).not.toThrow();
  expect(new Set(GROWTH_BASELINE.map(({ name }) => name)).size).toBe(GROWTH_BASELINE.length);
  expect(() => validateGrowthBaseline([...GROWTH_BASELINE, GROWTH_BASELINE[0]!])).toThrow(
    'Duplicate growth baseline name',
  );
  expect(() =>
    validateGrowthBaseline([{ name: 'absent check', file: 'services/kernel/test/no.test.ts', reason: 'B: report' }]),
  ).toThrow('missing test file');
  expect(() =>
    validateGrowthBaseline([
      { name: 'absent check', file: 'services/kernel/test/support/growth-rule.test.ts', reason: 'B: report' },
    ]),
  ).toThrow('is not present');
  expect(() =>
    validateGrowthBaseline([
      { name: 'an entry', file: 'services/kernel/test/support/growth-rule.test.ts', reason: ' ' },
    ]),
  ).toThrow('must have a reason');
});

test('a check without rule uses series unless its name is on the growth baseline', async () => {
  const prior = process.env.GROWTH_RULE;
  try {
    delete process.env.GROWTH_RULE;
    expect((await run('not listed')).rule).toBe('series');
    await expect(run('account Realm page')).rejects.toThrow(
      'account Realm page: series establishes this bound; delete its entry from growth-baseline.ts',
    );
  } finally {
    if (prior === undefined) delete process.env.GROWTH_RULE;
    else process.env.GROWTH_RULE = prior;
  }
});

test('a listed check uses step when its rows bound is not established by series', async () => {
  const prior = process.env.GROWTH_RULE;
  try {
    delete process.env.GROWTH_RULE;
    const report = await run('account Realm page', { allRows: true, constantRows: true });
    expect(report.rule).toBe('step');
    expect(report.shadow.rows.outcome).not.toBe('compatible');
  } finally {
    if (prior === undefined) delete process.env.GROWTH_RULE;
    else process.env.GROWTH_RULE = prior;
  }
});

test('listed checks reject an explicit rule with a TypeError naming the check', async () => {
  const prior = process.env.GROWTH_RULE;
  try {
    delete process.env.GROWTH_RULE;
    await expect(run('account Realm page', { rule: 'step' })).rejects.toMatchObject({
      name: 'TypeError',
      message: expect.stringContaining('account Realm page'),
    });
  } finally {
    if (prior === undefined) delete process.env.GROWTH_RULE;
    else process.env.GROWTH_RULE = prior;
  }
});

test('GROWTH_RULE=series applies series to listed checks and other values fail configuration', async () => {
  const prior = process.env.GROWTH_RULE;
  try {
    process.env.GROWTH_RULE = 'series';
    expect((await run('account Realm page')).rule).toBe('series');
    process.env.GROWTH_RULE = 'step';
    await expect(run('not listed')).rejects.toMatchObject({
      name: 'TypeError',
      message: expect.stringContaining('not listed'),
    });
  } finally {
    if (prior === undefined) delete process.env.GROWTH_RULE;
    else process.env.GROWTH_RULE = prior;
  }
});
