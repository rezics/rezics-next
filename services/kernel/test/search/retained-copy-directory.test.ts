import { afterAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
import { stepSearchErasure } from '../../src/search/erasure.ts';
import { encodePublicFilterNativeState as encode } from '../../src/search/public-filter-custody.ts';

const pool = createPool(process.env.DATABASE_URL!);
afterAll(() => pool.end());

type Database = Pick<PoolClient, 'query'>;

async function register(db: Database, target: string) {
  await db.query('INSERT INTO search.public_filter_target(partition_no,physical_target,incarnation) VALUES(0,$1,$2)', [
    target,
    'original',
  ]);
  await db.query(
    `INSERT INTO search.public_filter_registration(partition_no,id,physical_target,consumer,definition,state)
     VALUES(0,$1,$1,$2,'definition','active')`,
    [target, encode({ physicalTarget: target, incarnation: 'original' })],
  );
}

async function prepared(db: Database, target: string, build: string) {
  await db.query(
    `INSERT INTO search.public_filter_prepared(partition_no,registration,build,generation,rows)
     VALUES(0,$1,$2,1,$3) ON CONFLICT DO NOTHING`,
    [target, build, encode([{ original: build, terminal: build }])],
  );
}

async function revision(db: Database, target: string) {
  const result = await db.query(
    'SELECT copy_revision::text FROM search.retained_copy_directory WHERE (partition_no,physical_target)=(0,$1)',
    [target],
  );
  return BigInt(result.rows[0]!.copy_revision);
}

test('an erasure that finished its range reopens it for a later commit from an older transaction', async () => {
  const account = newId(0);
  const target = 'late-' + crypto.randomUUID();
  await register(pool, target);
  await pool.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES(0,$1,'actor','deleted',$1)",
    [account],
  );
  await pool.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES(0,$1,1,clock_timestamp())', [
    account,
  ]);
  const finishRange = async () => {
    for (let turn = 0; turn < 5; turn++) {
      const outcome = await stepSearchErasure(pool, account, false, { deadline: Date.now() + 5000 });
      expect(outcome).toMatchObject({ state: 'more', phase: 'copies' });
      const saved = await pool.query(
        'SELECT copies_complete,copy_revision::text FROM search.erasure_target WHERE (partition_no,account_id,physical_target)=(0,$1,$2)',
        [account, target],
      );
      if (saved.rows[0]?.copies_complete) return BigInt(saved.rows[0].copy_revision);
    }
    throw Error('Search erasure did not finish the native retained range');
  };
  const original = await revision(pool, target);
  expect(await finishRange()).toBe(original);
  const late = await pool.connect();
  const early = await pool.connect();
  const lane = 'SELECT (hashtextextended(pg_current_xact_id()::text,0) & 31)::integer AS lane';
  try {
    await late.query('BEGIN');
    const held = (await late.query(lane)).rows[0]!.lane;
    await prepared(late, target, 'late');
    for (let attempt = 0; ; attempt++) {
      if (attempt === 64) throw Error('No independent native transaction lane');
      await early.query('BEGIN');
      if ((await early.query(lane)).rows[0]!.lane !== held) break;
      await early.query('ROLLBACK');
    }
    await prepared(early, target, 'early');
    await early.query('COMMIT');
    expect(await finishRange()).toBe(original + 1n);
    await late.query('COMMIT');
    expect(await finishRange()).toBe(original + 2n);
    const cleaned = await pool.query(
      'SELECT rows,state FROM search.public_filter_prepared WHERE (partition_no,registration)=(0,$1) ORDER BY build',
      [target],
    );
    expect(cleaned.rows).toEqual(Array(2).fill({ rows: encode([]), state: 'erasing' }));
    await early.query('BEGIN');
    await prepared(early, target, 'rolled-back');
    await early.query('ROLLBACK');
    expect(await revision(pool, target)).toBe(original + 2n);
  } finally {
    await early.query('ROLLBACK');
    await late.query('ROLLBACK');
    early.release();
    late.release();
  }
});

test('admission rollback folds committed lanes into the scalar and restores coexisting native writers', async () => {
  const file = new URL('../../db/search/migrations/20261121162100_activate_retained_copy_lanes.sql', import.meta.url);
  const [activate, rollback] = (await Bun.file(file).text()).split('-- migrate:down') as [string, string];
  const db = await pool.connect();
  const writer = await pool.connect();
  const target = 'upgrade-' + crypto.randomUUID();
  const legacy = () =>
    db.query(
      'SELECT copy_revision::text FROM search.public_filter_target WHERE (partition_no,physical_target)=(0,$1)',
      [target],
    );
  try {
    await register(pool, target);
    await prepared(pool, target, 'first');
    const before = await revision(pool, target);
    await writer.query('BEGIN');
    await writer.query('SELECT * FROM search.lock_retained_copy_target(0,$1)', [target]);
    await prepared(writer, target, 'in-flight');
    const { pid: writerPid } = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0]!;
    const { pid: migrationPid } = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0]!;
    await db.query('BEGIN');
    const restoring = db.query(rollback);
    try {
      const deadline = Date.now() + 3000;
      while (
        !(await pool.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked', [writerPid, migrationPid]))
          .rows[0]!.blocked
      ) {
        if (Date.now() >= deadline) throw Error('The migration did not wait for the live admission');
        await Bun.sleep(5);
      }
    } finally {
      await writer.query('COMMIT');
      await restoring;
    }
    const initial = before + 1n;
    expect(BigInt((await legacy()).rows[0]!.copy_revision)).toBe(initial);
    expect((await db.query('SELECT count(*)::int AS n FROM search.retained_copy_lane')).rows[0]!.n).toBe(0);
    await db.query('SELECT * FROM search.lock_retained_copy_target(0,$1)', [target]);
    await prepared(db, target, 'scalar');
    expect(BigInt((await legacy()).rows[0]!.copy_revision)).toBe(initial + 1n);
    expect(await revision(db, target)).toBe(initial + 1n);
    await db.query(activate);
    await db.query('SAVEPOINT legacy_read');
    await expect(legacy()).rejects.toMatchObject({ code: '42703' });
    await db.query('ROLLBACK TO SAVEPOINT legacy_read');
    await db.query(
      'SELECT 1 FROM search.public_filter_target WHERE (partition_no,physical_target)=(0,$1) FOR NO KEY UPDATE',
      [target],
    );
    await prepared(db, target, 'older-writer');
    await prepared(db, target, 'older-writer');
    expect(await revision(db, target)).toBe(initial + 2n);
  } finally {
    await writer.query('ROLLBACK');
    await db.query('ROLLBACK');
    writer.release();
    db.release();
  }
});
