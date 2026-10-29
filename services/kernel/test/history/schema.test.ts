import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const route = 0x6a30;
// Artifact partitions deliberately differ from the account's home partition.
const partition = 1970;
const insert = `INSERT INTO core.history_locator
  (partition_no,account_route,account_id,artifact_type,locator,roles,minimizer_version)
  VALUES ($1,$2,$3,$4,$5,$6,$7)`;
const seal = `INSERT INTO core.history_seal (partition_no,account_route,account_id,barrier_id,phase)
  VALUES ($1,$2,$3,$3,'sealed') ON CONFLICT (partition_no,account_route,account_id)
  DO UPDATE SET barrier_id=EXCLUDED.barrier_id,phase=EXCLUDED.phase`;
const seek = `SELECT artifact_type,locator FROM core.history_locator
  WHERE partition_no=$1 AND account_route=$2 AND account_id=$3 AND state='pending'
    AND (artifact_type,locator)>($4::text COLLATE "C",$5::bytea)
  ORDER BY artifact_type,locator LIMIT 8`;
const values = (account: string, key = Buffer.from([1])) => [
  partition,
  route,
  account,
  'command-receipt/v1',
  key,
  1,
  1,
];

beforeAll(async () => {
  db = await openGrowthDatabase();
  await db.admin.query(
    "INSERT INTO core.partition(partition_no,node) VALUES($1,'history-test') ON CONFLICT DO NOTHING",
    [partition],
  );
}, 60_000);
afterAll(async () => {
  await db?.close();
});

async function erasure(account = newId(route)) {
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES($1,$2,'actor','deleted',$2)`,
    [route, account],
  );
  await db.admin.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now())', [
    route,
    account,
  ]);
  return account;
}
async function barrier(blocked: PoolClient, blocker: PoolClient) {
  const pid = async (client: PoolClient) =>
    (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  return { blocked: await pid(blocked), blocker: await pid(blocker) };
}
async function awaitBlocked(ids: { blocked: number; blocker: number }) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = await db.pool.query<{ waiting: boolean }>('SELECT $2::int=ANY(pg_blocking_pids($1)) AS waiting', [
      ids.blocked,
      ids.blocker,
    ]);
    if (result.rows[0]!.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error('The second real connection did not reach the guard lock barrier');
}

test('locator seal progress and work have the exact unique keys and pending partial index', async () => {
  const keys = await db.admin.query<{ table_name: string; key: string }>(`SELECT c.relname AS table_name,
    pg_get_constraintdef(k.oid) AS key FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    WHERE k.connamespace='core'::regnamespace AND c.relname LIKE 'history_%' AND k.contype IN ('p','u') ORDER BY c.relname`);
  expect(keys.rows).toEqual([
    {
      table_name: 'history_locator',
      key: 'PRIMARY KEY (partition_no, account_route, account_id, artifact_type, locator)',
    },
    {
      table_name: 'history_progress',
      key: 'PRIMARY KEY (account_route, account_id, barrier_id, store_kind, partition_no)',
    },
    { table_name: 'history_seal', key: 'PRIMARY KEY (partition_no, account_route, account_id)' },
    { table_name: 'history_work', key: 'PRIMARY KEY (partition_no, work_id)' },
  ]);
  const index = (
    await db.admin.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname='core' AND indexname='history_locator_pending'",
    )
  ).rows[0]!.indexdef;
  expect(index).toContain('(partition_no, account_route, account_id, artifact_type, locator)');
  expect(index).toContain("WHERE (state = 'pending'::text)");
  const account = await erasure();
  const args = [partition, route, account];
  await db.admin.query(seal, args);
  await expect(
    db.admin.query(seal.replace("$3,'sealed'", "$4,'sealed'"), [...args, newId(route)]),
  ).rejects.toMatchObject({ code: '23514' });
  for (const statement of [
    "UPDATE core.history_seal SET phase='open',barrier_id=NULL",
    'DELETE FROM core.history_seal',
  ])
    await expect(
      db.admin.query(`${statement} WHERE partition_no=$1 AND account_route=$2 AND account_id=$3`, args),
    ).rejects.toMatchObject({ code: '23514' });
  await db.admin.query(
    `INSERT INTO core.history_progress(account_route,account_id,barrier_id,store_kind,partition_no,partition_epoch)
    VALUES($1,$2,$2,'kernel',$3,1)`,
    [route, account, partition],
  );
  await expect(
    db.admin.query("UPDATE core.history_progress SET store_kind='unknown' WHERE account_id=$1", [account]),
  ).rejects.toMatchObject({ code: '22P02' });
  await expect(
    db.admin.query("UPDATE core.history_progress SET state='complete' WHERE account_id=$1", [account]),
  ).rejects.toMatchObject({ code: '23514' });
  await db.admin.query("UPDATE core.history_progress SET state='complete',proof='none' WHERE account_id=$1", [account]);
  const work = newId(route);
  await db.admin.query('INSERT INTO core.history_work(partition_no,work_id,request_digest) VALUES($1,$2,$3)', [
    partition,
    work,
    Buffer.alloc(32),
  ]);
  await expect(
    db.admin.query("UPDATE core.history_work SET state='ready' WHERE work_id=$1", [work]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    db.admin.query("UPDATE core.history_work SET state='retired' WHERE work_id=$1", [work]),
  ).rejects.toMatchObject({ code: '23514' });
  await db.admin.query("UPDATE core.history_work SET state='retired',retired_at=now() WHERE work_id=$1", [work]);
});

test('a producer holding the shared guard orders before the exclusive seal and later producers are refused', async () => {
  const account = await erasure();
  const args = [partition, route, account];
  await db.admin.query('INSERT INTO core.history_seal(partition_no,account_route,account_id) VALUES($1,$2,$3)', args);
  const producer = await db.admin.connect(),
    eraser = await db.admin.connect();
  let sealing: Promise<unknown> | undefined;
  try {
    const ids = await barrier(eraser, producer);
    await producer.query('BEGIN');
    await producer.query(insert, values(account));
    // Another producer can share this guard: no exclusive upsert on the ordinary path.
    await eraser.query('BEGIN');
    await eraser.query(
      'SELECT 1 FROM core.history_seal WHERE partition_no=$1 AND account_route=$2 AND account_id=$3 FOR SHARE NOWAIT',
      args,
    );
    await eraser.query('COMMIT');
    await eraser.query('BEGIN');
    sealing = eraser.query(seal, args);
    await awaitBlocked(ids);
    await producer.query('COMMIT');
    await sealing;
    await eraser.query('COMMIT');
    expect((await producer.query('SELECT 1 FROM core.history_locator WHERE account_id=$1', [account])).rowCount).toBe(
      1,
    );
    await expect(producer.query(insert, values(account, Buffer.from([2])))).rejects.toMatchObject({ code: '23514' });
  } finally {
    await producer.query('ROLLBACK');
    await sealing?.catch(() => {});
    await eraser.query('ROLLBACK');
    producer.release();
    eraser.release();
  }
}, 30_000);

test('an exclusive seal on an empty prefix refuses a producer waiting behind it', async () => {
  const account = await erasure();
  const producer = await db.admin.connect(),
    eraser = await db.admin.connect();
  let producing: Promise<unknown> | undefined;
  try {
    const ids = await barrier(producer, eraser);
    await eraser.query('BEGIN');
    await eraser.query(seal, [partition, route, account]);
    producing = producer.query(insert, values(account)).catch((error: unknown) => error);
    await awaitBlocked(ids);
    await eraser.query('COMMIT');
    expect(await producing).toMatchObject({ code: '23514' });
    expect((await producer.query('SELECT 1 FROM core.history_locator WHERE account_id=$1', [account])).rowCount).toBe(
      0,
    );
    await expect(producer.query(insert, values(account))).rejects.toMatchObject({ code: '23514' });
  } finally {
    await eraser.query('ROLLBACK');
    await producing;
    producer.release();
    eraser.release();
  }
}, 30_000);

test('a rolled back producer leaves neither locator nor guard row', async () => {
  const account = newId(route),
    client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(insert, values(account));
    await client.query('ROLLBACK');
    for (const table of ['history_locator', 'history_seal'])
      expect((await client.query(`SELECT 1 FROM core.${table} WHERE account_id=$1`, [account])).rowCount).toBe(0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('oversize locators and unknown artifact types versions roles states routes and proofs are rejected', async () => {
  const account = newId(route);
  for (const [column, value] of [
    [4, Buffer.alloc(257)],
    [4, Buffer.alloc(0)],
    [3, 'unknown/v1'],
    [3, 'command-receipt/v2'],
    [5, 0],
    [5, 64],
    [5, -1],
    [6, 2],
    [1, -1],
    [1, 65536],
    [1, route + 1],
    [0, 4096],
  ] as const) {
    const args = values(account);
    args[column] = value;
    await expect(db.admin.query(insert, args)).rejects.toMatchObject({ code: '23514' });
  }
  for (const type of ['outbox-event/v1', 'durable-work/v1']) {
    const args = values(account);
    args[3] = type;
    args[5] = 63;
    await db.admin.query(insert, args);
  }
  await db.admin.query(insert, values(account));
  await expect(db.admin.query(insert, values(account))).rejects.toMatchObject({ code: '23505' });
  for (const patch of ["state='unknown'", "state='minimized'", `proof_barrier='${account}'`])
    await expect(
      db.admin.query(`UPDATE core.history_locator SET ${patch} WHERE account_id=$1`, [account]),
    ).rejects.toMatchObject({ code: '23514' });
  await expect(db.admin.query(seal, [partition, route, account])).rejects.toMatchObject({ code: '23503' });
  await erasure(account);
  await db.admin.query(seal, [partition, route, account]);
  await db.admin.query("UPDATE core.history_locator SET state='minimized',proof_barrier=$1 WHERE account_id=$1", [
    account,
  ]);
  expect((await db.admin.query(seek, [partition, route, account, '', Buffer.alloc(0)])).rowCount).toBe(0);
});

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return [node, ...Object.values(node).flatMap(nodes)];
}

test('eight maximum locator keys fit within a 4 KiB page and prefix seeks stay logarithmic at 64 512 and 4096 unrelated locators', async () => {
  const account = newId(route),
    keys = Array.from({ length: 9 }, (_, n) => Buffer.alloc(256, n + 1));
  for (const key of keys) await db.admin.query(insert, values(account, key));
  const args = [partition, route, account, '', Buffer.alloc(0)];
  const read = () => db.pool.query<{ artifact_type: string; locator: Buffer }>(seek, args);
  const page = await read();
  expect(page.rows.map((row) => row.locator)).toEqual(keys.slice(0, 8));
  expect(
    Buffer.byteLength(
      JSON.stringify({
        partition,
        route,
        account,
        keys: page.rows.map((row) => ({ type: row.artifact_type, locator: row.locator.toString('base64') })),
      }),
    ),
  ).toBeLessThanOrEqual(4096);
  expect(
    (await db.admin.query(seek, [partition, route, account, 'command-receipt/v1', keys[7]])).rows.map(
      (row) => row.locator,
    ),
  ).toEqual([keys[8]]);
  const report = await checkGrowth(db, {
    name: 'pending history account prefix',
    scales: [64, 512, 4096],
    warmups: 1,
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    indexProbes: 1,
    async grow(_database, scale, previous) {
      await db.admin.query(
        `INSERT INTO core.history_locator(partition_no,account_route,account_id,artifact_type,locator,roles,minimizer_version)
        SELECT $1,$2,('10000000-0000-7000-8000-6a30'||lpad(to_hex(n),8,'0'))::uuid,
        'command-receipt/v1',decode(lpad(to_hex(n),8,'0'),'hex'),1,1 FROM generate_series($3::int+1,$4::int) n`,
        [partition, route, previous, scale],
      );
    },
    async warmup() {
      const measured = await db.pool.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${seek}`,
        args,
      );
      const scans = nodes(measured.rows[0]!['QUERY PLAN']).filter(
        (node) => node['Relation Name'] === 'history_locator' && Number(node['Actual Loops']) > 0,
      );
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) {
        expect(scan['Index Name']).toBe('history_locator_pending');
        for (const prefix of ['partition_no =', 'account_route =', 'account_id ='])
          expect(String(scan['Index Cond'])).toContain(prefix);
        expect(Number(scan['Actual Rows']) + Number(scan['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(8);
      }
    },
    async operation() {
      expect((await read()).rows.map((row) => row.locator)).toEqual(keys.slice(0, 8));
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  for (const sample of report.samples) expect(sample.cost.statements).toBe(1);
}, 300_000);
