import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  checkGrowth,
  GrowthSettleInfrastructureError,
  openGrowthDatabase,
  settle,
  type GrowthDatabase,
} from './growth.ts';
import { capture, captureMeasuredRun } from './growth-capture.ts';

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

test('settle waits for an older snapshot and establishes all-visible stable index probes after bare VACUUM', async () => {
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
    expect((await holder.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows).toEqual([{ count: 3000 }]);
    expect((await db.admin.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows).toEqual([{ count: 200 }]);
    const dirty = await relationState();
    expect(dirty.pages).toBeGreaterThan(0);
    expect(dirty.visible).toBeLessThan(dirty.pages);
    let completed = false;
    waiting = settle(db, { relations: [table], timeoutMs: 5000, pollMs: 20 }).then((elapsed) => {
      completed = true;
      return elapsed;
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(completed).toBe(false);
    await holder.query('COMMIT');
    await waiting;
    expect((await holder.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows).toEqual([{ count: 200 }]);
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
    // Advance the next transaction ID past the held snapshot, making it a blocking horizon.
    await db.admin.query(`DELETE FROM ${table} WHERE id=3000`);
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

test('settle diagnoses a transaction that remains open on its measured backend', async () => {
  await db.admin.query(`TRUNCATE ${table}`);
  await db.admin.query(`INSERT INTO ${table} SELECT i,i FROM generate_series(1,1000) i`);
  await settle(db, { relations: [table], analyze: true });
  const client: PoolClient = await db.pool.connect();
  try {
    const measured = await captureMeasuredRun(() =>
      capture(
        db,
        async () => {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await client.query(`SELECT count(*) FROM ${table}`);
        },
        { includeBackends: true },
      ),
    );
    const backend = measured.value.capture.statementBackends?.[0];
    expect(backend).toBeDefined();
    expect(measured.transactions.get(db)?.get(backend!)).toEqual(expect.any(Number));
    await db.admin.query(`DELETE FROM ${table} WHERE id=1`);

    await expect(
      settle(db, {
        relations: [table],
        timeoutMs: 5000,
        operationBackends: measured.backends,
      }),
    ).rejects.toMatchObject({
      name: 'GrowthSettleInfrastructureError',
      message: expect.stringContaining(`Backend ${backend} from the measured operation keeps a transaction open`),
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('settle waits for a later background transaction that reuses a measured backend', async () => {
  await db.admin.query(`TRUNCATE ${table}`);
  await db.admin.query(`INSERT INTO ${table} SELECT i,i FROM generate_series(1,1000) i`);
  await settle(db, { relations: [table], analyze: true });
  const client: PoolClient = await db.pool.connect();
  let settling: Promise<number> | undefined;
  try {
    const measured = await captureMeasuredRun(() =>
      capture(
        db,
        async () => {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await client.query(`SELECT count(*) FROM ${table}`);
          await client.query('COMMIT');
        },
        { includeBackends: true },
      ),
    );
    const backend = measured.value.capture.statementBackends?.[0];
    expect(backend).toBeDefined();
    expect(measured.backends.has(backend!)).toBe(true);
    expect(measured.transactions.get(db)?.has(backend!)).toBe(false);

    // The same checked-out client now opens a new finite transaction after the measured one committed.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`SELECT count(*) FROM ${table}`);
    await db.admin.query(`DELETE FROM ${table} WHERE id=1`);
    let completed = false;
    settling = settle(db, {
      relations: [table],
      timeoutMs: 5000,
      pollMs: 20,
      operationBackends: measured.backends,
    }).then((elapsed) => {
      completed = true;
      return elapsed;
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(completed).toBe(false);
    await client.query('COMMIT');
    await settling;
    expect((await relationState()).visible).toBe((await relationState()).pages);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await settling;
  }
});

test('settle does not mistake a retained measured transaction token for a later transaction on the same backend', async () => {
  await db.admin.query(`TRUNCATE ${table}`);
  await db.admin.query(`INSERT INTO ${table} SELECT i,i FROM generate_series(1,1000) i`);
  await settle(db, { relations: [table], analyze: true });
  const client = await db.pool.connect();
  let settling: Promise<number> | undefined;
  try {
    const measured = await captureMeasuredRun(() =>
      capture(
        db,
        async () => {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await client.query(`SELECT count(*) FROM ${table}`);
        },
        { includeBackends: true },
      ),
    );
    const backend = measured.value.capture.statementBackends![0]!;
    const token = measured.transactions.get(db)?.get(backend);
    expect(token).toEqual(expect.any(Number));
    // Complete the measured transaction outside its capture. Its retained token deliberately stays in the receipt.
    await client.query('COMMIT');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`SELECT count(*) FROM ${table}`);
    await db.admin.query(`DELETE FROM ${table} WHERE id=1`);
    let completed = false;
    settling = settle(db, {
      relations: [table],
      timeoutMs: 5000,
      pollMs: 20,
      operationBackends: measured.backends,
    }).then((elapsed) => {
      completed = true;
      return elapsed;
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(completed).toBe(false);
    expect(measured.transactions.get(db)?.get(backend)).toBe(token);
    await client.query('COMMIT');
    await settling;
    expect((await relationState()).visible).toBe((await relationState()).pages);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await settling;
  }
});

test('settle retains measured transaction identity in the actual mapped database', async () => {
  const name = `growth_settle_${Bun.randomUUIDv7().replaceAll('-', '').slice(0, 16)}`;
  const url = new URL(db.url);
  url.pathname = `/${name}`;
  await db.admin.query(`CREATE DATABASE "${name}"`);
  const admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
  let source: GrowthDatabase | undefined;
  let client: PoolClient | undefined;
  try {
    source = await openGrowthDatabase(db.url);
    const database = source;
    // Libraries such as DBOS redirect a pool before its first connection; capture must use the connected database.
    const pool = database.openPool({ max: 1 });
    pool.options.connectionString = url.toString();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, value integer NOT NULL)
      WITH (autovacuum_enabled=false)`);
    await admin.query(`INSERT INTO ${table} SELECT i,i FROM generate_series(1,1000) i`);
    client = await pool.connect();
    const connection = client;
    const measured = await captureMeasuredRun(() =>
      capture(
        database,
        async () => {
          await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await connection.query(`UPDATE ${table} SET value=value+1 WHERE id=1`);
          await connection.query(`SELECT count(*) FROM ${table}`);
        },
        { includeBackends: true },
      ),
    );
    const target = [...measured.writes.keys()].find((database) => new URL(database.url).pathname === `/${name}`);
    expect(target).toBeDefined();
    const backend = measured.value.capture.statementBackends![0]!;
    expect(measured.transactions.get(target!)?.get(backend)).toEqual(expect.any(Number));
    expect(measured.transactions.get(database)?.has(backend) ?? false).toBe(false);
    await expect(
      settle(target!, {
        relations: [table],
        timeoutMs: 5000,
        operationBackends: measured.backends,
      }),
    ).rejects.toMatchObject({
      name: 'GrowthSettleInfrastructureError',
      message: expect.stringContaining(`Backend ${backend} from the measured operation keeps a transaction open`),
    });
    await connection.query('COMMIT');
    await settle(target!, { relations: [table] });
    const visibility = await admin.query<{ pages: number; visible: number }>(
      `SELECT relpages AS pages,relallvisible AS visible FROM pg_class WHERE oid=$1::regclass`,
      [table],
    );
    expect(visibility.rows[0]!.pages).toBeGreaterThan(0);
    expect(visibility.rows[0]!.visible).toBe(visibility.rows[0]!.pages);
  } finally {
    if (client) {
      await client.query('ROLLBACK');
      client.release(true);
    }
    await admin.end();
    await source?.close();
    await db.admin.query(`DROP DATABASE "${name}"`);
  }
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
      LEFT JOIN pg_class t ON t.oid=c.reltoastrelid
      WHERE c.relkind='r' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND (c.reloptions IS NULL OR NOT c.reloptions @> ARRAY['autovacuum_enabled=false']
          OR (c.reltoastrelid<>0 AND (t.reloptions IS NULL OR NOT t.reloptions @> ARRAY['autovacuum_enabled=false'])))`,
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
