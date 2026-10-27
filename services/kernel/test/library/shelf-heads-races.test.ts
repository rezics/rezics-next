import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { HeadSnapshot, ShelfWrite } from '../../src/library/shelf-contract.ts';
import { createProgressActivity, createShelfHeads } from '../../src/library/shelf-heads.ts';
import { newId } from '../../src/route/route.ts';
import { capture, openGrowthDatabase, withoutCatalogStatements, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const heads = createShelfHeads();
const activity = createProgressActivity();
const changed = '2026-10-27T00:00:10.123456Z';
const older = '2026-10-27T00:00:05.654321Z';
const entryTime = '2026-10-20T00:00:00.000001Z';

beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

function owner(client: ShelfWrite['client'] = db.admin): ShelfWrite {
  const route = 0x6a30;
  return { client, route, accountId: newId(route) };
}

// Seed the entry statement that follows ensure; command admission and writer hooks belong to their owners.
async function insertEntry(write: ShelfWrite, subjectId: string, head: HeadSnapshot) {
  await write.client.query(
    `INSERT INTO library.entry
       (route, account_id, subject_id, state, revision, created_at, updated_at, transaction_id,
        incarnation_id, activity_at, finished_at)
     VALUES ($1, $2, $3, 'planned', 7, $4, $4, $5, $5,
             GREATEST($4::timestamptz, $6::timestamptz), $7::timestamptz)`,
    [write.route, write.accountId, subjectId, entryTime, newId(write.route), head.lastChangedAt, head.lastCompletedAt],
  );
}

async function entry(write: ShelfWrite, subjectId: string) {
  return (
    await db.admin.query(
      `SELECT to_jsonb(e) - 'activity_at' - 'finished_at' AS identity,
            activity_at = $4::timestamptz AS activity_matches,
            finished_at = $4::timestamptz AS finish_matches,
            activity_at::text, finished_at::text
     FROM library.entry AS e WHERE route = $1 AND account_id = $2 AND subject_id = $3`,
      [write.route, write.accountId, subjectId, changed],
    )
  ).rows;
}

async function begin(client: PoolClient): Promise<number> {
  await client.query('BEGIN');
  expect((await client.query('SHOW transaction_isolation')).rows[0]!.transaction_isolation).toBe('read committed');
  return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
}

async function waitForHeadLock(waiter: number, holder: number) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const { rows } = await db.admin.query('SELECT $2::integer = ANY(pg_blocking_pids($1)) AS blocked', [
      waiter,
      holder,
    ]);
    if (rows[0]!.blocked) return;
    await Bun.sleep(10);
  }
  throw new Error('Expected the second transaction to wait for the first transaction head lock');
}

test('ensure and touch issue only their three sequential statements on the supplied transaction', async () => {
  const client = await db.pool.connect();
  const write = owner(client);
  const subjectId = newId(0x7b20);
  try {
    await begin(client);
    const measured = await capture(db, async () => {
      expect(await heads.ensure(write, subjectId)).toEqual({ lastChangedAt: null, lastCompletedAt: null });
      await activity.touch(write, { subjectId, time: changed, completed: true });
    });
    const statements = withoutCatalogStatements('shelf head statement boundaries', measured.capture).statements;
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('INSERT INTO library.progress_head');
    expect(statements[1]).toContain('INSERT INTO library.progress_head');
    expect(statements[2]).toContain('UPDATE library.entry');
    // Another connection cannot see these writes until the caller chooses to commit.
    expect((await heads.ensure({ ...write, client }, subjectId)).lastChangedAt).toContain('10.123456');
    expect(
      (
        await db.admin.query('SELECT 1 FROM library.progress_head WHERE route = $1 AND account_id = $2', [
          write.route,
          write.accountId,
        ])
      ).rows,
    ).toEqual([]);
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

for (const outcome of ['COMMIT', 'ROLLBACK'] as const) {
  test(`entry create ${outcome} ahead of progress uses a fresh statement snapshot`, async () => {
    const creator = await db.pool.connect();
    const progress = await db.pool.connect();
    const write = owner(creator);
    const subjectId = newId(0x7b20);
    try {
      const creatorPid = await begin(creator);
      const progressPid = await begin(progress);
      const head = await heads.ensure(write, subjectId);
      expect(head).toEqual({ lastChangedAt: null, lastCompletedAt: null });
      await insertEntry(write, subjectId, head);
      const pending = activity.touch({ ...write, client: progress }, { subjectId, time: changed, completed: true });
      void pending.catch(() => {});
      // The first statement's snapshot predates the entry commit. A combined upsert/update CTE misses that entry.
      await waitForHeadLock(progressPid, creatorPid);
      await creator.query(outcome);
      await pending;
      await progress.query('COMMIT');
      const rows = await entry(write, subjectId);
      if (outcome === 'COMMIT') {
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ activity_matches: true, finish_matches: true });
      } else {
        expect(rows).toEqual([]);
      }
      expect((await heads.ensure({ ...write, client: db.admin }, subjectId)).lastChangedAt).toContain('10.123456');
    } finally {
      await creator.query('ROLLBACK');
      await progress.query('ROLLBACK');
      creator.release();
      progress.release();
    }
  }, 30_000);

  test(`progress ${outcome} ahead of entry create supplies the locked head snapshot`, async () => {
    const progress = await db.pool.connect();
    const creator = await db.pool.connect();
    const write = owner(progress);
    const subjectId = newId(0x7b20);
    try {
      const progressPid = await begin(progress);
      const creatorPid = await begin(creator);
      await activity.touch(write, { subjectId, time: changed, completed: true });
      expect(await entry(write, subjectId)).toEqual([]);
      const entryWrite = { ...write, client: creator };
      const pending = heads.ensure(entryWrite, subjectId);
      void pending.catch(() => {});
      await waitForHeadLock(creatorPid, progressPid);
      await progress.query(outcome);
      const head = await pending;
      if (outcome === 'ROLLBACK') expect(head).toEqual({ lastChangedAt: null, lastCompletedAt: null });
      else {
        expect(head.lastChangedAt).toContain('10.123456');
        expect(head.lastCompletedAt).toBe(head.lastChangedAt);
      }
      await insertEntry(entryWrite, subjectId, head);
      await creator.query('COMMIT');
      const rows = await entry(write, subjectId);
      expect(rows).toHaveLength(1);
      if (outcome === 'COMMIT') expect(rows[0]).toMatchObject({ activity_matches: true, finish_matches: true });
      else expect(rows[0]).toMatchObject({ activity_matches: false, finished_at: null });
    } finally {
      await progress.query('ROLLBACK');
      await creator.query('ROLLBACK');
      progress.release();
      creator.release();
    }
  }, 30_000);
}

test('progress preserves entry identity, precision and maxima across older completion and later record or abandon', async () => {
  const write = owner();
  const subjectId = newId(0x7b20);
  await insertEntry(write, subjectId, await heads.ensure(write, subjectId));
  await db.admin.query(
    `UPDATE library.entry SET type_id = $4, type_source_id = subject_id, type_source_partition = $5,
       type_source_epoch = 2, type_source_position = 123 WHERE route = $1 AND account_id = $2 AND subject_id = $3`,
    [write.route, write.accountId, subjectId, newId(write.route), 0x7b20 >>> 4],
  );
  const before = (await entry(write, subjectId))[0]!.identity;
  await activity.touch(write, { subjectId, time: changed, completed: true });
  await activity.touch(write, { subjectId, time: older, completed: true });
  await activity.touch(write, { subjectId, time: older, completed: false });
  expect((await entry(write, subjectId))[0]).toMatchObject({
    identity: before,
    activity_matches: true,
    finish_matches: true,
  });
  const later = '2026-10-28T00:00:00.999999Z';
  // Both record and abandon pass completed:false; neither may erase completion evidence.
  await activity.touch(write, { subjectId, time: later, completed: false });
  const head = await heads.ensure(write, subjectId);
  expect(head.lastChangedAt).toContain('00.999999');
  expect(head.lastCompletedAt).toContain('10.123456');
  const row = (await entry(write, subjectId))[0]!;
  expect(row.identity).toEqual(before);
  expect(row.activity_at).toContain('00.999999');
  expect(row.finish_matches).toBe(true);
});

test('absent entry touch retains a reusable head through deletion and recreation', async () => {
  const client = await db.pool.connect();
  const write = owner(client);
  const subjectId = newId(0x7b20);
  try {
    await begin(client);
    await activity.touch(write, { subjectId, time: changed, completed: true });
    await client.query('COMMIT');
    expect(await entry(write, subjectId)).toEqual([]);
    for (let incarnation = 0; incarnation < 2; incarnation++) {
      await begin(client);
      await insertEntry(write, subjectId, await heads.ensure(write, subjectId));
      await client.query('COMMIT');
      expect((await entry(write, subjectId))[0]).toMatchObject({ activity_matches: true, finish_matches: true });
      await begin(client);
      await heads.ensure(write, subjectId);
      await client.query('DELETE FROM library.entry WHERE route = $1 AND account_id = $2 AND subject_id = $3', [
        write.route,
        write.accountId,
        subjectId,
      ]);
      await client.query('COMMIT');
      expect((await heads.ensure({ ...write, client: db.admin }, subjectId)).lastCompletedAt).toContain('10.123456');
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('nullable transition activity raises from command time and rollback restores existing head and entry', async () => {
  const write = owner();
  const subjectId = newId(0x7b20);
  await insertEntry(write, subjectId, await heads.ensure(write, subjectId));
  await db.admin.query(
    'UPDATE library.entry SET activity_at = NULL WHERE route = $1 AND account_id = $2 AND subject_id = $3',
    [write.route, write.accountId, subjectId],
  );
  await activity.touch(write, { subjectId, time: older, completed: false });
  const before = await entry(write, subjectId);
  const head = await heads.ensure(write, subjectId);
  expect(before[0]!.activity_at).toContain('05.654321');
  expect(before[0]!.finished_at).toBeNull();
  expect(head.lastCompletedAt).toBeNull();
  const client = await db.pool.connect();
  try {
    await begin(client);
    await activity.touch({ ...write, client }, { subjectId, time: changed, completed: true });
    await client.query('ROLLBACK');
    expect(await entry(write, subjectId)).toEqual(before);
    expect(await heads.ensure(write, subjectId)).toEqual(head);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('head and entry point keys isolate owners and subjects and reject inconsistent routes', async () => {
  const write = owner();
  const other = owner();
  const subjectId = newId(0x7b20);
  const otherSubject = newId(0x7b20);
  await insertEntry(write, subjectId, await heads.ensure(write, subjectId));
  await insertEntry(other, subjectId, await heads.ensure(other, subjectId));
  await insertEntry(write, otherSubject, await heads.ensure(write, otherSubject));
  await activity.touch(write, { subjectId, time: changed, completed: true });
  expect((await entry(write, subjectId))[0]!.activity_matches).toBe(true);
  for (const [untouched, subject] of [
    [other, subjectId],
    [write, otherSubject],
  ] as const) {
    expect(await heads.ensure(untouched, subject)).toEqual({ lastChangedAt: null, lastCompletedAt: null });
    expect((await entry(untouched, subject))[0]).toMatchObject({ activity_matches: false, finished_at: null });
  }
  await expect(heads.ensure({ ...write, route: write.route + 1 }, subjectId)).rejects.toBeInstanceOf(RangeError);
  await expect(
    activity.touch({ ...write, route: -1 }, { subjectId, time: changed, completed: true }),
  ).rejects.toBeInstanceOf(RangeError);
  await expect(heads.ensure({ ...write, accountId: 'invalid' }, subjectId)).rejects.toBeInstanceOf(TypeError);
  await expect(activity.touch(write, { subjectId: 'invalid', time: changed, completed: true })).rejects.toBeInstanceOf(
    TypeError,
  );
});
