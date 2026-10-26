import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import type { Pool } from 'pg';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_background_test';
const table = `${schema}.records`;
let db: GrowthDatabase | undefined;
let workflowPool: pg.Pool | undefined;
let queuedWorkflow: (() => Promise<number>) | undefined;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
  workflowPool = new pg.Pool({ connectionString: databaseUrl });
  queuedWorkflow = DBOS.registerWorkflow(
    async () => {
      const result = await db!.pool.query('SELECT 1');
      return result.rowCount ?? 0;
    },
    { name: 'growth.background.workflow' },
  );
  DBOS.setConfig({
    name: 'growth-background-test',
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: 'dbos',
    systemDatabasePool: workflowPool,
    runMigrations: false,
    logLevel: 'warn',
  });
  await DBOS.launch();
  DBOS.registerQueue('growth-background', { workerConcurrency: 1, minPollingIntervalMs: 10 });
});

afterAll(async () => {
  if (!db) return;
  try {
    if (DBOS.isInitialized()) await DBOS.shutdown({ workflowCompletionTimeoutMS: 5000 });
  } finally {
    await workflowPool?.end();
    await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.close();
  }
});

async function runWithPoller(pool: Pool, statement: string, work: () => Promise<void>): Promise<void> {
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending
      .then(() => pool.query(statement))
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

function check(database: GrowthDatabase, operation: () => Promise<unknown>) {
  return checkGrowth(database, {
    name: 'background poller',
    scales: [1, 8, 64],
    repetitions: 1,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await growthDb.admin.query(`INSERT INTO ${table} SELECT generate_series($1 + 1, $2)`, [previous, scale]);
    },
    operation,
  });
}

test('statements from a loop started outside the operation are background, and a constant-cost poller passes', async () => {
  const database = db!;
  await database.admin.query(`TRUNCATE ${table}`);
  const pool = database.openPool({ max: 2 });
  await pool.query('SELECT 1');
  await runWithPoller(pool, 'SELECT 1', async () => {
    const measured = await check(database, () =>
      withConnection(database.pool, (client) => client.query('SELECT pg_sleep(0.02)')),
    );
    expect(measured.samples.every(({ cost }) => cost.statements === 1)).toBe(true);
    expect((measured.samples.at(-1)?.cost as { backgroundStatements?: number }).backgroundStatements).toBeGreaterThan(
      0,
    );
  });
}, 60_000);

test('a background loop whose scan grows with scale fails the check', async () => {
  const database = db!;
  await database.admin.query(`TRUNCATE ${table}`);
  const pool = database.openPool({ max: 2 });
  await pool.query('SELECT 1');
  await expect(
    runWithPoller(pool, `SELECT id FROM ${table}`, async () => {
      await check(database, () => withConnection(database.pool, (client) => client.query('SELECT pg_sleep(0.02)')));
    }),
  ).rejects.toMatchObject({
    name: 'GrowthBoundError',
    message: expect.stringContaining('background'),
  });
}, 60_000);

test('a statement the operation issues keeps its attribution when the pool hands it a client released by other work', async () => {
  const database = db!;
  await database.admin.query(`TRUNCATE ${table}`);
  const pool = database.openPool({ max: 1 });
  await runWithPoller(pool, 'SELECT pg_sleep(0.02)', async () => {
    const result = await check(database, () => withConnection(pool, (client) => client.query('SELECT 1')));
    expect(result.samples.every(({ cost }) => cost.statements === 1)).toBe(true);
    expect((result.samples.at(-1)?.cost as { backgroundStatements?: number }).backgroundStatements).toBeGreaterThan(0);
  });
}, 60_000);

test("a workflow the operation starts runs on the queue runner and stays the operation's", async () => {
  const database = db!;
  await database.admin.query(`TRUNCATE ${table}`);
  const result = await checkGrowth(database, {
    name: 'queued workflow attribution',
    scales: [1, 8, 64],
    repetitions: 1,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await growthDb.admin.query(`INSERT INTO ${table} SELECT generate_series($1 + 1, $2)`, [previous, scale]);
    },
    operation: async () =>
      (await DBOS.startWorkflow(queuedWorkflow!, { queueName: 'growth-background' })()).getResult(),
  });
  expect(result.samples.every(({ cost }) => cost.statements === 1)).toBe(true);
});
