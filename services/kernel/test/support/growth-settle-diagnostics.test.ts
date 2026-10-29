import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { openGrowthDatabase, settle, type GrowthDatabase } from './growth.ts';

const schema = 'growth_settle_diagnostics_test';
const relation = `${schema}.workflow_input`;
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase();
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${relation} (id integer PRIMARY KEY, workflow_uuid text, body text)`);
  await db.admin.query(`CREATE TABLE ${schema}.workflow_status (
    workflow_uuid text PRIMARY KEY,name text,status text,queue_name text,created_at timestamptz
  )`);
  await db.admin.query(`INSERT INTO ${relation} SELECT i,NULL,repeat('x',100) FROM generate_series(1,200000) i`);
  await settle(db, { relations: [relation] });
});

afterAll(async () => {
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

async function waitForVacuum() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await db.admin.query<{ active: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_progress_vacuum WHERE relid=$1::regclass) AS active`, [relation],
    );
    if (result.rows[0]?.active) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`VACUUM did not start for ${relation}`);
}

test('a settle with a concurrent writer reports moving relation counters and classifies the writer', async () => {
  const writer = new pg.Client({ connectionString: db.url, application_name: 'growth-settle-writer' });
  await writer.connect();
  let stop = false;
  const writing = (async () => {
    while (!stop) {
      await writer.query(`UPDATE ${relation} SET body=body WHERE id=1`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  try {
    await expect(settle(db, { relations: [relation], timeoutMs: 10_000, pollMs: 5 })).rejects.toMatchObject({
      name: 'GrowthSettleInfrastructureError',
      message: expect.stringMatching(
        /VACUUM did not make every page all-visible after three rounds; settle cause: concurrent writer; starting horizon: \d+; relation statistics by round: .*n_tup_upd.*n_dead_tup/s,
      ),
    });
  } finally {
    stop = true;
    await writing;
    await writer.end();
  }
});

test('a newer held snapshot reports its backend and classifies static relation counters', async () => {
  const holder = new pg.Client({ connectionString: db.url, application_name: 'growth-settle-snapshot-holder' });
  await holder.connect();
  const settling = settle(db, { relations: [relation], timeoutMs: 10_000, pollMs: 5 });
  await waitForVacuum();
  await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await holder.query(`SELECT count(*) FROM ${relation}`);
  try {
    await db.admin.query(`DELETE FROM ${relation} WHERE id=20000`);
    await expect(settling).rejects.toMatchObject({
      name: 'GrowthSettleInfrastructureError',
      message: expect.stringMatching(
        /settle cause: snapshot held during VACUUM; starting horizon: \d+; relation statistics by round: .*n_tup_del.*backend_xmin.*growth-settle-snapshot-holder.*"state":"idle in transaction".*"xact_start":".*"/s,
      ),
    });
  } finally {
    await holder.query('ROLLBACK');
    await holder.end();
  }
});

test('a post-start DBOS row is listed with its horizon, key, text and workflow status', async () => {
  await db.admin.query(`TRUNCATE ${schema}.workflow_status`);
  const holder = new pg.Client({ connectionString: db.url, application_name: 'growth-settle-row-holder' });
  await holder.connect();
  const settling = settle(db, { relations: [relation], timeoutMs: 200, pollMs: 5 });
  await waitForVacuum();
  await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await holder.query(`SELECT count(*) FROM ${relation}`);
  const workflow = 'growth-settle-diagnostics-workflow';
  await db.admin.query(
    `INSERT INTO ${schema}.workflow_status (workflow_uuid,name,status,queue_name,created_at) VALUES ($1,'growth.test','PENDING','growth-queue',now())`,
    [workflow],
  );
  await db.admin.query(`INSERT INTO ${relation} (id,workflow_uuid,body) VALUES (300001,$1,repeat('z',140))`, [workflow]);
  try {
    await expect(settling).rejects.toMatchObject({
      name: 'GrowthSettleInfrastructureError',
      message: expect.stringMatching(
        /settle cause: snapshot held during VACUUM;.*"ctid":"\(\d+,\d+\)".*"xmin":"\d+".*"xmax":"\d+".*"at_or_after_horizon":true.*"primary_key":\{"id":300001\}.*"text_columns":\{"body":"z{1,120}"\}.*"workflow":\{"name":"growth.test","status":"PENDING","queue_name":"growth-queue","created_at":/s,
      ),
    });
  } finally {
    await holder.query('ROLLBACK');
    await holder.end();
  }
});

test('a successful settle issues no relation-statistics diagnostics', async () => {
  await settle(db, { relations: [relation] });
  const original = db.admin.query.bind(db.admin);
  let diagnosticQueries = 0;
  db.admin.query = ((...args: Parameters<typeof db.admin.query>) => {
    const query = args[0] as unknown as string | { text: string };
    const sql = typeof query === 'string' ? query : query.text;
    if (sql.includes('pg_stat_clear_snapshot') || sql.includes('pg_stat_user_tables')) diagnosticQueries++;
    return original(...args);
  }) as typeof db.admin.query;
  try {
    await settle(db, { relations: [relation] });
    expect(diagnosticQueries).toBe(0);
  } finally {
    db.admin.query = original;
  }
});
