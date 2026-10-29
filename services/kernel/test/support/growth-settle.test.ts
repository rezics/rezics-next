import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  checkGrowth,
  GrowthSettleInfrastructureError,
  openGrowthDatabase,
  settle,
  type GrowthDatabase,
} from './growth.ts';

const schema = 'growth_settle_test';
const table = `${schema}.rows`;
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase();
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, value integer NOT NULL)`);
  await db.admin.query(`CREATE INDEX rows_value ON ${table}(value)`);
});

afterAll(async () => {
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

async function relationState() {
  return db.admin
    .query<{ pages: number; visible: number; autovacuum: boolean; toast_autovacuum: boolean }>(
      `SELECT c.relpages AS pages,c.relallvisible AS visible,
            COALESCE((c.reloptions @> ARRAY['autovacuum_enabled=false']),false) AS autovacuum,
            COALESCE((c.reloptions @> ARRAY['toast.autovacuum_enabled=false']),false) AS toast_autovacuum
       FROM pg_class c WHERE c.oid=$1::regclass`,
      [table],
    )
    .then(({ rows }) => rows[0]!);
}

test('settle waits for an older snapshot and removes the first index-probe excess after bare VACUUM', async () => {
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  // This mechanism concerns an index scan; an unselective sequential scan cannot expose dead index entries.
  await holder.query('SET enable_seqscan = off');
  await holder.query('SET enable_bitmapscan = off');
  let waiting: Promise<number> | undefined;
  async function dirtyWithSnapshot() {
    await db.admin.query(`TRUNCATE ${table}`);
    await db.admin.query(`INSERT INTO ${table} SELECT i,i FROM generate_series(1,3000) i`);
    await settle(db, { relations: [table], analyze: true });
    await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await holder.query(`SELECT count(*) FROM ${table}`);
    await db.admin.query(`DELETE FROM ${table} WHERE id <= 2800`);
    await db.admin.query(`VACUUM (INDEX_CLEANUP ON) ${table}`);
  }
  async function probe() {
    const result = await holder.query<{
      'QUERY PLAN': Array<{
        Plan: { 'Node Type': string; 'Shared Hit Blocks'?: number; 'Shared Read Blocks'?: number };
      }>;
    }>(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM ${table} WHERE id <= 3000`);
    const plan = result.rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(plan['Node Type']).toBe('Index Only Scan');
    return (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0);
  }
  try {
    await dirtyWithSnapshot();
    // Once the old snapshot ends, the first scan can mark the dead entries left by bare VACUUM.
    await holder.query('COMMIT');
    const dirtyFirst = await probe();
    const dirtyNext = await probe();
    expect(dirtyFirst).toBeGreaterThan(dirtyNext);

    // Recreate the dirty state so settle, rather than a preceding probe, must remove the excess.
    await dirtyWithSnapshot();
    let completed = false;
    waiting = settle(db, { relations: [table], timeoutMs: 5000, pollMs: 20 }).then((elapsed) => {
      completed = true;
      return elapsed;
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(completed).toBe(false);
    await holder.query('COMMIT');
    await waiting;
    const first = await probe();
    const next = await probe();
    expect(first).toBe(next);
    const state = await relationState();
    expect(state.visible).toBe(state.pages);
  } finally {
    await holder.query('ROLLBACK');
    await holder.end();
    await waiting;
  }
});

test('settle times out with an infrastructure error that identifies the holding backend', async () => {
  const holder = new pg.Client({ connectionString: db.url, application_name: 'growth-settle-holder' });
  await holder.connect();
  await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await holder.query(`SELECT count(*) FROM ${table}`);
  try {
    await expect(settle(db, { relations: [table], timeoutMs: 30, pollMs: 5 })).rejects.toMatchObject({
      name: 'GrowthSettleInfrastructureError',
      message: expect.stringMatching(
        /"pid":\d+,"backend_type":"client backend","application_name":"growth-settle-holder","state":"idle in transaction","xact_start":"[^"]+","query":"SELECT count\(\*\) FROM growth_settle_test\.rows"/,
      ),
    });
  } finally {
    await holder.query('ROLLBACK');
    await holder.end();
  }
  expect(GrowthSettleInfrastructureError.name).toBe('GrowthSettleInfrastructureError');
});

test('settle disables autovacuum on relations created after the growth database opened', async () => {
  await db.admin.query(`CREATE TABLE ${schema}.late (id integer, body text)`);
  await db.admin.query(`INSERT INTO ${schema}.late SELECT i,repeat('x',2000) FROM generate_series(1,100) i`);
  await settle(db, { relations: [`${schema}.late`] });
  const result = await db.admin.query<{ reloptions: string[]; toast_reloptions: string[] }>(
    `SELECT base.reloptions,toast.reloptions AS toast_reloptions
       FROM pg_class base JOIN pg_class toast ON toast.oid=base.reltoastrelid WHERE base.oid=$1::regclass`,
    [`${schema}.late`],
  );
  expect(result.rows[0]!.reloptions).toContain('autovacuum_enabled=false');
  expect(result.rows[0]!.toast_reloptions).toContain('autovacuum_enabled=false');
  const enabled = await db.admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='r' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND (c.reloptions IS NULL OR NOT c.reloptions @> ARRAY['autovacuum_enabled=false']
          OR NOT c.reloptions @> ARRAY['toast.autovacuum_enabled=false'])`,
  );
  expect(enabled.rows[0]!.count).toBe('0');
});

test('writes through triggers have settled state before every measured repetition', async () => {
  await db.admin.query(`CREATE TABLE ${schema}.trigger_rows (id integer PRIMARY KEY)`);
  await db.admin.query(`CREATE TABLE ${schema}.trigger_side (id integer PRIMARY KEY)`);
  await db.admin.query(`CREATE FUNCTION ${schema}.copy_row() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO ${schema}.trigger_side VALUES (NEW.id); RETURN NEW; END $$`);
  await db.admin.query(`CREATE TRIGGER copy_row AFTER INSERT ON ${schema}.trigger_rows
    FOR EACH ROW EXECUTE FUNCTION ${schema}.copy_row()`);
  const observer = new pg.Client({ connectionString: db.url });
  await observer.connect();
  const report = await checkGrowth(db, {
    name: 'trigger writes settle between runs',
    scales: [1, 4, 16],
    repetitions: 3,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    async grow() {
      await db.admin.query(`TRUNCATE ${schema}.trigger_side,${schema}.trigger_rows`);
      await db.admin.query(`INSERT INTO ${schema}.trigger_rows SELECT generate_series(10000,15000)`);
    },
    async operation(_database, _scale, repetition) {
      const visible = await observer.query<{ relation: string; pages: number; all_visible: number }>(
        `SELECT n.nspname || '.' || c.relname AS relation,c.relpages AS pages,c.relallvisible AS all_visible
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE (n.nspname || '.' || c.relname)=ANY($1::text[])`,
        [[`${schema}.trigger_rows`, `${schema}.trigger_side`]],
      );
      expect(visible.rows.every(({ pages, all_visible }) => pages === 0 || pages === all_visible)).toBe(true);
      await db.pool.query(`INSERT INTO ${schema}.trigger_rows VALUES ($1)`, [repetition + 1]);
    },
  });
  await observer.end();
  for (const sample of report.samples) {
    expect(new Set(sample.repetitions.map(({ blocks }) => blocks)).size).toBe(1);
    expect(sample.seeding.settleMs).toBeGreaterThanOrEqual(sample.seeding.vacuumMs);
  }
});
