import { afterAll, beforeEach, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { checkStatement } from '../support/partition-binding.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
afterAll(() => pool.end());
beforeEach(() => pool.query('TRUNCATE access.write_rate_counter'));
const route = 0x7310;
const digest = (i: number) => i.toString(16).padStart(64, '0');
async function batch(client = pool, target = route) {
  const { expireWriteRateCounters } = await import('../../src/access/write-rate-expiry.ts');
  return expireWriteRateCounters(client, target);
}
async function populate(size: number, target = route) {
  await pool.query(
    `INSERT INTO access.write_rate_counter (route, identity_digest, family, count, expires_at)
    SELECT $1, lpad(to_hex(i),64,'0'), 'write', 1, '2020-01-01'::timestamptz
    FROM generate_series(1,$2::integer) i`,
    [target, size],
  );
}

test('empty, small and overfull expiry batches delete at most 1000 in expiry/key order on one route', async () => {
  expect(await batch()).toBe(0);
  await populate(3);
  expect(await batch()).toBe(3);
  await populate(1005);
  await populate(2, route + 1);
  // Earlier expiry outranks the identity key; equal expiries use identity then family.
  await pool.query(
    `UPDATE access.write_rate_counter SET expires_at='2019-01-01' WHERE route=$1 AND identity_digest=$2`,
    [route, digest(1005)],
  );
  expect(await batch()).toBe(1000);
  expect(
    (
      await pool.query(
        'SELECT identity_digest FROM access.write_rate_counter WHERE route=$1 ORDER BY identity_digest',
        [route],
      )
    ).rows,
  ).toEqual([1000, 1001, 1002, 1003, 1004].map((i) => ({ identity_digest: digest(i) })));
  expect(await batch()).toBe(5);
  expect(await batch()).toBe(0);
  expect(await batch(pool, route + 1)).toBe(2);
});

test('48h is strict, recent expired history and live windows survive', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Use a transaction-stable clock only in this test's copy of the native SQL to prove equality exactly.
    const product = (await import('../../src/access/write-rate-expiry.sql')).default;
    await client.query(
      `INSERT INTO access.write_rate_counter (route, identity_digest, family, count, expires_at)
      SELECT $1,$2,family,1,transaction_timestamp()+delta FROM (VALUES
      ('older',interval '-48 hours -1 microsecond'), ('boundary',interval '-48 hours'),
      ('recent',interval '-47 hours'), ('live',interval '1 hour')) v(family,delta)`,
      [route, digest(1)],
    );
    const result = await client.query({
      text: product.sql.replaceAll('statement_timestamp()', 'transaction_timestamp()'),
      values: product.params.map((p) => (p === 'route' ? route : undefined)),
    });
    expect(result.rows.map((r) => r.family)).toEqual(['older']);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('native concurrent workers skip locked keys, then retain a concurrently renewed live window', async () => {
  await populate(2002);
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    await a.query(`SELECT 1 FROM access.write_rate_counter WHERE route=$1 AND identity_digest=$2 FOR UPDATE`, [
      route,
      digest(1),
    ]);
    await b.query("SET LOCAL statement_timeout='2s'");
    const { expireWriteRateCounters } = await import('../../src/access/write-rate-expiry.ts');
    expect(await expireWriteRateCounters(b, route)).toBe(1000);
    expect(await expireWriteRateCounters(a, route)).toBe(1000);
    await b.query('COMMIT');
    await a.query('COMMIT');
    expect(await batch()).toBe(2);
    await populate(1);
    await a.query('BEGIN');
    await a.query(
      `UPDATE access.write_rate_counter SET expires_at=statement_timestamp()+interval '1 hour' WHERE route=$1`,
      [route],
    );
    expect(await batch()).toBe(0);
    await a.query('COMMIT');
    expect(await batch()).toBe(0);
  } finally {
    await a.query('ROLLBACK');
    await b.query('ROLLBACK');
    a.release();
    b.release();
  }
});

test('worker restart preserves normal retained history; crash-loss of the unlogged store is acceptable', async () => {
  await populate(1);
  await pool.query("UPDATE access.write_rate_counter SET expires_at=statement_timestamp()-interval '1 hour'");
  const restarted = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    expect(await batch(restarted)).toBe(0);
  } finally {
    await restarted.end();
  }
  expect(
    (await pool.query("SELECT relpersistence FROM pg_class WHERE oid='access.write_rate_counter'::regclass")).rows,
  ).toEqual([{ relpersistence: 'u' }]);
  // Model PostgreSQL's permitted crash/partition-movement reset, then recover normally.
  await pool.query('TRUNCATE access.write_rate_counter');
  expect(await batch()).toBe(0);
  await populate(1);
  expect(await batch()).toBe(1);
});

test('one native statement uses the route-led expiry index and remains bounded through common-seed growth', async () => {
  const db = await openGrowthDatabase();
  const product = (await import('../../src/access/write-rate-expiry.sql')).default;
  const { expireWriteRateCounters } = await import('../../src/access/write-rate-expiry.ts');
  const population: Population = {
    name: 'counter-retention',
    hotPartition: route >>> 4,
    rows: ({ ordinal, route: placed, hot }) => ({
      'access.write_rate_counter': ['old', 'recent', 'live'].map((family) => ({
        route: hot ? route : placed,
        identity_digest: digest(ordinal + 100000),
        family,
        count: 1,
        expires_at: new Date(
          family === 'old' ? '2020-01-01' : family === 'recent' ? Date.now() - 3600000 : Date.now() + 3600000,
        ),
      })),
    }),
  };
  try {
    expect(await checkStatement(db.admin, { sql: product.sql, params: [...product.params] })).toEqual({
      bound: true,
      parameter: 'route',
    });
    expect(product.raw).not.toMatch(/\b(?:OFFSET|COUNT|SUM)\s*\(?/i);
    // Same partition as the measured route, never chosen by the population: hot rows
    // are pinned to `route` and cold rows leave the hot partition.
    const spareRoute = route + 1;
    const report = await checkGrowth(db, {
      name: 'counter-expiry',
      scales: [1, 4, 16],
      repetitions: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        await seed(database, population, { from: previous * 2048, to: scale * 2048 });
        // One expiry batch the warmup can delete without taking the measured route's probe.
        await database.admin.query(
          `INSERT INTO access.write_rate_counter (route, identity_digest, family, count, expires_at)
          SELECT $1, lpad(to_hex(i),64,'0'), 'write', 1, '2020-01-01'::timestamptz
          FROM generate_series($2::integer,$3::integer) i`,
          [spareRoute, 9_000_000 + previous * 1000, 9_000_000 + previous * 1000 + 999],
        );
        await database.admin.query('VACUUM (ANALYZE) access.write_rate_counter');
      },
      async warmup(database) {
        expect(await expireWriteRateCounters(database.pool, spareRoute)).toBe(1000);
      },
      async operation(database) {
        const before = Number(
          (await database.admin.query('SELECT count(*) FROM access.write_rate_counter')).rows[0].count,
        );
        expect(await expireWriteRateCounters(database.pool, route)).toBe(1000);
        const after = Number(
          (await database.admin.query('SELECT count(*) FROM access.write_rate_counter')).rows[0].count,
        );
        expect(before - after).toBe(1000);
      },
    });
    for (const { cost } of report.samples) {
      expect(cost.statements).toBe(1);
      expect(cost.rows).toBeLessThanOrEqual(2000);
      expect(cost.relations?.['access.write_rate_counter']?.sequentialScans).toBe(0);
    }
  } finally {
    await db.close();
  }
}, 30000);

test('accounts registers once before shared launch, schedules one admitted route batch and survives recomposition', async () => {
  const program = `
    import assert from 'node:assert/strict';
    import pg from 'pg';
    import { DBOS } from '@dbos-inc/dbos-sdk';
    import { createWorkClient } from './src/work/client.ts';
    import { composeWork } from './src/work/registry.ts';
    import { createDiscoveryProducerEntry } from './src/composition/discovery.ts';
    import { createKernelWorkModules } from './src/work/modules.ts';
    const KERNEL_WORK_MODULES = createKernelWorkModules(createDiscoveryProducerEntry);
    const accountsWorkModule = KERNEL_WORK_MODULES.find(m=>m.name==='accounts');
    assert.equal(KERNEL_WORK_MODULES.filter(m=>m.name==='accounts').length,1);
    assert.ok(accountsWorkModule);
    const pool = new pg.Pool({connectionString:process.env.DATABASE_URL});
    const client=await createWorkClient(process.env.DATABASE_URL,pool);
    const options={databaseUrl:process.env.DATABASE_URL,pool,client,env:{KERNEL_WRITE_RATE_EXPIRY_PARTITION:'1841',KERNEL_WRITE_RATE_EXPIRY_NODE:'b',KERNEL_ROUTE_KEY:Buffer.alloc(32,59).toString('base64url'),KERNEL_WORKFLOW_REFERENCE_KEYS:JSON.stringify({current:1,keys:{1:Buffer.alloc(32,60).toString('base64url')}}),AUTH_ISSUER:'https://accounts.test',AUTH_AUDIENCE:'https://api.test',AUTH_JWKS_URL:'https://accounts.test/.well-known/jwks.json'}};
    await assert.rejects(composeWork([accountsWorkModule,accountsWorkModule],options),/Duplicate work module/);
    const work=await composeWork([accountsWorkModule],options);
    assert.equal(DBOS.isInitialized(),false);
    assert.equal((await client.listSchedules({scheduleNamePrefix:'accounts.write-rate-expiry.'})).length,1);
    await work.launch();
    const handle=await client.triggerSchedule('accounts.write-rate-expiry.1841');
    await handle.getResult();
    await assert.rejects(composeWork([accountsWorkModule],options),/already composed/);
    await work.shutdown(); await client.close(); await pool.end();
  `;
  // Two fresh processes each import the kernel work graph. That exceeds 30s once the suite is loaded.
  for (let restart = 0; restart < 2; restart++) {
    const child = Bun.spawn([process.execPath, '-e', program], {
      cwd: import.meta.dir + '/../..',
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, `${errors}${stdout}`).toBe(0);
  }
}, 300000);
