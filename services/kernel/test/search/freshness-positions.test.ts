import { expect, test } from 'bun:test';
import pg from 'pg';
import freshness from '../../src/search/freshness.sql';
import { subjectConsumer } from '../../src/search/consumer-name.ts';

const [foldHeads, restoreHeadGroups] = (
  await Bun.file(
    new URL('../../db/search/migrations/20261122023200_defer_freshness_head_group_writes.sql', import.meta.url),
  ).text()
).split('-- migrate:down');

test('whole-generation freshness follows native backfill, replay, retirement and rollback', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const [up, down] = (
    await Bun.file(
      new URL('../../db/search/migrations/20261121024000_freshness_home_lanes.sql', import.meta.url),
    ).text()
  ).split('-- migrate:down');
  const [bound, restore] = (
    await Bun.file(
      new URL('../../db/search/migrations/20261122012700_bound_shared_freshness_writes.sql', import.meta.url),
    ).text()
  ).split('-- migrate:down');
  const first = subjectConsumer('positions-', 1);
  const next = subjectConsumer('positions-', 2);
  const generic = 'other_freshness_reader';
  // Exercise bigint precision beyond the exact integer range of JavaScript numbers.
  const cut = '9007199254740993';
  const earlier = new Date('2026-01-01T00:00:01Z');
  const later = new Date('2026-01-01T00:00:02Z');
  const legacySql = await Bun.file(new URL('./freshness-original-reader.sql.txt', import.meta.url)).text();
  const legacy = async (consumer: string) => (await db.query(legacySql, [consumer])).rows[0]!;
  const read = async (consumer: string) => {
    const row = await freshness.run(db, { consumer });
    if (!row) throw new Error('Expected a freshness observation');
    return { behind: row.behind, oldest: row.oldest === null ? null : new Date(row.oldest) };
  };
  const tuples = async () =>
    Number(
      (
        await db.query(`
    SELECT sum(seq_tup_read + idx_tup_fetch) AS n FROM pg_stat_xact_user_tables
    WHERE relid IN ('search.freshness_groups'::regclass, 'search.freshness_positions'::regclass, 'core.partition'::regclass,
                    'core.consumer_checkpoint'::regclass, 'core.outbox'::regclass)`)
      ).rows[0]!.n,
    );

  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(restoreHeadGroups!);
    await db.query(restore!);
    await db.query(down!);
    const homes = (await db.query('SELECT count(*)::int AS homes FROM core.partition')).rows[0]!.homes;
    expect(homes).toBeGreaterThanOrEqual(4096);
    await db.query('UPDATE core.partition SET position = $1', [cut]);
    await db.query(
      `INSERT INTO core.consumer_checkpoint(partition_no, consumer, epoch, position)
      SELECT p.partition_no, c, p.epoch, p.position FROM core.partition p CROSS JOIN unnest($1::text[]) c`,
      [[first, next, generic]],
    );
    await db.query(up!);
    expect(await legacy(first)).toMatchObject({ behind: 0, oldest: null });
    await db.query(bound!);
    await db.query(foldHeads!);
    await db.query('ANALYZE search.freshness_groups, search.freshness_positions');
    const before = await tuples();
    expect(await read(first)).toMatchObject({ behind: 0, oldest: null });
    const caughtUpRows = (await tuples()) - before;
    expect(caughtUpRows).toBeLessThan(512);

    await db.query('UPDATE core.partition SET position = position + 1 WHERE partition_no IN (0,4095)');
    await db.query(
      `INSERT INTO core.outbox(partition_no, position, epoch, event_seq, event_count, id, type, data, recorded_at)
      SELECT partition_no, position, epoch, 0, 1, gen_random_uuid(), 'test', '{}',
        CASE WHEN partition_no = 4095 THEN $1::timestamptz ELSE $2::timestamptz END
      FROM core.partition WHERE partition_no IN (0,4095)`,
      [earlier, later],
    );
    // Both homes have changed since the last group write. The original query sees their real positions immediately.
    expect(
      (
        await db.query(
          "SELECT shard AS partition_no FROM search.freshness_positions WHERE consumer='' AND pending ORDER BY shard",
        )
      ).rows,
    ).toEqual([{ partition_no: 0 }, { partition_no: 4095 }]);
    const lagBefore = await tuples();
    expect(await read(first)).toMatchObject({ behind: 2, oldest: earlier });
    const behindRows = (await tuples()) - lagBefore;
    expect(behindRows).toBeLessThan(512);
    console.info(JSON.stringify({ homes, caughtUpRows, twoBehindRows: behindRows }));
    expect(await read(generic)).toMatchObject({ behind: 2, oldest: earlier });
    for (const consumer of [first, next, generic]) expect(await legacy(consumer)).toMatchObject(await read(consumer));

    const sharedUpdates = async () =>
      Number(
        (
          await db.query(
            "SELECT n_tup_upd FROM pg_stat_xact_user_tables WHERE relid='search.freshness_groups'::regclass",
          )
        ).rows[0]!.n_tup_upd,
      );
    const groupBefore = await sharedUpdates();
    await db.query('UPDATE core.partition SET position=position+100 WHERE partition_no=0');
    expect(await sharedUpdates()).toBe(groupBefore);
    expect(await read(first)).toMatchObject({ behind: 2, oldest: earlier });
    await db.query('SAVEPOINT late_checkpoint');
    await db.query('UPDATE core.consumer_checkpoint SET position=position+50 WHERE partition_no=0 AND consumer=$1', [
      generic,
    ]);
    expect(await read(generic)).toMatchObject({ behind: 2, oldest: earlier });
    expect(
      (
        await db.query(
          'SELECT head,checkpoint_ceiling,position AS published FROM search.freshness_home WHERE partition_no=0',
        )
      ).rows,
    ).toEqual([
      {
        head: String(BigInt(cut) + 101n),
        checkpoint_ceiling: String(BigInt(cut) + 50n),
        published: String(BigInt(cut) + 51n),
      },
    ]);
    await db.query('UPDATE core.partition SET position=9223372036854775807 WHERE partition_no=0');
    await db.query(
      'UPDATE core.consumer_checkpoint SET position=9223372036854775807 WHERE partition_no=0 AND consumer=$1',
      [generic],
    );
    expect(
      (await db.query('SELECT position AS published FROM search.freshness_home WHERE partition_no=0')).rows[0]!
        .published,
    ).toBe('9223372036854775807');
    await db.query('ROLLBACK TO late_checkpoint');

    await db.query('SAVEPOINT advances');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(
      'UPDATE core.consumer_checkpoint SET position = position + 1 WHERE consumer = $1 AND partition_no = 4095',
      [first],
    );
    expect(await read(first)).toMatchObject({ behind: 1, oldest: later });
    expect(
      (
        await db.query(
          "SELECT NOT EXISTS(SELECT 1 FROM search.freshness_positions WHERE consumer='' AND shard=4095 AND pending) AS folded",
        )
      ).rows,
    ).toEqual([{ folded: true }]);
    expect(await read(next)).toMatchObject({ behind: 2, oldest: earlier });
    await db.query('UPDATE core.partition SET position = 0 WHERE partition_no = 0');
    expect(await read(first)).toMatchObject({ behind: 0, oldest: null });
    expect(await read(next)).toMatchObject({ behind: 1, oldest: earlier });
    await db.query(
      'UPDATE core.consumer_checkpoint SET position = position + 1 WHERE consumer = $1 AND partition_no = 4095',
      [first],
    );
    expect(await read(first)).toMatchObject({ behind: 0, oldest: null });
    await db.query(
      "UPDATE core.consumer_checkpoint SET consumer = 'moved_reader' WHERE consumer = $1 AND partition_no = 4095",
      [first],
    );
    expect(await read(first)).toMatchObject({ behind: 1, oldest: null });
    await db.query(
      'UPDATE core.consumer_checkpoint SET position = 0, epoch = NULL WHERE consumer = $1 AND partition_no = 4095',
      [next],
    );
    expect(await read(next)).toMatchObject({ behind: 1, oldest: null });
    await db.query('ROLLBACK TO advances');
    expect(await read(first)).toMatchObject({ behind: 2, oldest: earlier });

    await db.query('DELETE FROM core.consumer_checkpoint WHERE consumer = $1', [first]);
    expect((await db.query('SELECT shard FROM search.freshness_positions WHERE consumer = $1', [first])).rows).toEqual(
      [],
    );
    // A missing checkpoint starts at zero; other native fixtures may already retain a first envelope.
    const firstEnvelope = (
      await db.query('SELECT min(recorded_at) AS oldest FROM core.outbox WHERE position=1 AND event_seq=0')
    ).rows[0]!.oldest;
    expect(await read(first)).toMatchObject({ behind: homes, oldest: firstEnvelope });
    expect(await read(next)).toMatchObject({ behind: 2, oldest: earlier });
    await db.query('TRUNCATE core.consumer_checkpoint');
    expect(await read(next)).toMatchObject({ behind: homes, oldest: firstEnvelope });
    await db.query(restoreHeadGroups!);
    await db.query(restore!);
    const exact = await db.query(
      "SELECT (positions->>'0')::bigint AS head FROM search.freshness_positions WHERE consumer='' AND shard=0",
    );
    expect(exact.rows[0]!.head).toBe(String(BigInt(cut) + 101n));
    await db.query('UPDATE core.partition SET position=position+1 WHERE partition_no=0');
    expect(await legacy(next)).toMatchObject({ behind: homes, oldest: firstEnvelope });
    await db.query(bound!);
    expect(await legacy(next)).toMatchObject({ behind: homes, oldest: firstEnvelope });
  } finally {
    try {
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
  }
}, 30_000);

test('a concurrent head and checkpoint preserve the same committed freshness comparison', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const head = await pool.connect();
  const checkpoint = await pool.connect();
  // This fenced fixture home cannot accept a routed application command.
  const home = 16_384 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 32_768);
  const consumer = 'search_concurrent_freshness';
  const writerPid = (await head.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const checkpointPid = (await checkpoint.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const waitForLock = async (blocker: number, waiter: number) => {
    const deadline = Date.now() + 5000;
    while (
      !(await pool.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked', [blocker, waiter])).rows[0]!
        .blocked
    ) {
      if (Date.now() >= deadline) throw new Error('Expected native freshness lock was not observed');
      await Bun.sleep(5);
    }
  };
  let created = false;
  const observe = () =>
    pool.query(
      `SELECT h.head,h.checkpoint_ceiling,h.position AS published,
        (p.positions->>h.partition_no::text)::bigint AS group_head,
        (c.positions->>h.partition_no::text)::bigint AS group_checkpoint
      FROM search.freshness_home h
      JOIN search.grouped_freshness_positions p ON p.consumer='' AND p.shard=h.partition_no/64
      JOIN search.grouped_freshness_positions c ON c.consumer=$2 AND c.shard=h.partition_no/64
      WHERE h.partition_no=$1`,
      [home, consumer],
    );
  try {
    await head.query(
      "INSERT INTO core.partition(partition_no,node,write_state,position) VALUES($1,'freshness-test','fenced',10)",
      [home],
    );
    created = true;
    await checkpoint.query(
      'INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position) VALUES($1,$2,1,1)',
      [home, consumer],
    );
    await head.query('BEGIN');
    await head.query('UPDATE core.partition SET position=20 WHERE partition_no=$1', [home]);
    await checkpoint.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await checkpoint.query('SELECT position FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2', [
      home,
      consumer,
    ]);
    const advance = () =>
      checkpoint.query('UPDATE core.consumer_checkpoint SET position=12 WHERE partition_no=$1 AND consumer=$2', [
        home,
        consumer,
      ]);
    const concurrent = advance().then(
      () => undefined,
      (error: { code?: string }) => error.code,
    );
    try {
      await waitForLock(writerPid, checkpointPid);
    } finally {
      await head.query('COMMIT');
    }
    expect(await concurrent).toBe('40001');
    await checkpoint.query('ROLLBACK');
    await advance();
    expect((await observe()).rows).toEqual([
      { head: '20', checkpoint_ceiling: '12', published: '13', group_head: '13', group_checkpoint: '12' },
    ]);

    await checkpoint.query('BEGIN');
    await checkpoint.query('UPDATE core.consumer_checkpoint SET position=25 WHERE partition_no=$1 AND consumer=$2', [
      home,
      consumer,
    ]);
    await head.query('BEGIN');
    const waitingHead = head.query('UPDATE core.partition SET position=30 WHERE partition_no=$1', [home]);
    try {
      await waitForLock(checkpointPid, writerPid);
    } finally {
      await checkpoint.query('COMMIT');
      await waitingHead;
    }
    await head.query('COMMIT');
    expect((await observe()).rows).toEqual([
      { head: '30', checkpoint_ceiling: '25', published: '26', group_head: '26', group_checkpoint: '25' },
    ]);

    const [, restore] = (
      await Bun.file(
        new URL('../../db/search/migrations/20261122012700_bound_shared_freshness_writes.sql', import.meta.url),
      ).text()
    ).split('-- migrate:down');
    await head.query('BEGIN');
    await head.query('UPDATE core.partition SET position=60 WHERE partition_no=$1', [home]);
    await checkpoint.query('BEGIN');
    const restoring = checkpoint.query(restoreHeadGroups! + restore!);
    try {
      await waitForLock(writerPid, checkpointPid);
    } finally {
      await head.query('COMMIT');
      await restoring;
    }
    expect(
      (
        await checkpoint.query(
          "SELECT (positions->>$1::text)::bigint AS value FROM search.freshness_positions WHERE consumer='' AND shard=$2",
          [String(home), Math.floor(home / 64)],
        )
      ).rows,
    ).toEqual([{ value: '60' }]);
    await checkpoint.query('ROLLBACK');
    expect((await observe()).rows[0]!.group_head).toBe('26');
  } finally {
    try {
      await Promise.all([head.query('ROLLBACK'), checkpoint.query('ROLLBACK')]);
      if (created) {
        await head.query('DELETE FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2', [
          home,
          consumer,
        ]);
        await head.query('DELETE FROM core.partition WHERE partition_no=$1', [home]);
        await head.query('DELETE FROM search.freshness_home WHERE partition_no=$1 AND head=0', [home]);
      }
    } finally {
      head.release();
      checkpoint.release();
      await pool.end();
    }
  }
}, 30_000);

test('cutover reconciles native checkpoints that replica replay delivered before their homes', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const [bound, restore] = (
    await Bun.file(
      new URL('../../db/search/migrations/20261122012700_bound_shared_freshness_writes.sql', import.meta.url),
    ).text()
  ).split('-- migrate:down');
  const [reconcile] = (
    await Bun.file(
      new URL('../../db/search/migrations/20261122014300_reconcile_replayed_freshness_ceilings.sql', import.meta.url),
    ).text()
  ).split('-- migrate:down');
  const first = 65536 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 32768);
  const homes = [first, first + 1];
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(restoreHeadGroups!);
    await db.query(restore!);
    await db.query('SET LOCAL session_replication_role=replica');
    await db.query(
      "INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position) SELECT n,'generic_orphan_freshness',1,50 FROM unnest($1::int[]) n",
      [homes],
    );
    await db.query('SET LOCAL session_replication_role=origin');
    await db.query(bound!);
    await db.query(
      "INSERT INTO core.partition(partition_no,node,write_state,position) VALUES($1,'freshness-test','fenced',100)",
      [first],
    );
    expect((await db.query('SELECT position FROM search.freshness_home WHERE partition_no=$1', [first])).rows).toEqual([
      { position: '1' },
    ]);
    const homeWrites = async () =>
      Number(
        (
          await db.query(
            "SELECT n_tup_ins+n_tup_upd AS writes FROM pg_stat_xact_user_tables WHERE relid='search.freshness_home'::regclass",
          )
        ).rows[0]!.writes,
      );
    const before = await homeWrites();
    await db.query(reconcile!);
    const repaired = await homeWrites();
    expect(repaired - before).toBeGreaterThanOrEqual(2);
    await db.query(reconcile!);
    expect(await homeWrites()).toBe(repaired);
    await db.query(
      "INSERT INTO core.partition(partition_no,node,write_state,position) VALUES($1,'freshness-test','fenced',100)",
      [first + 1],
    );
    expect(
      (
        await db.query(
          'SELECT head,checkpoint_ceiling,position FROM search.freshness_home WHERE partition_no=ANY($1::int[]) ORDER BY partition_no',
          [homes],
        )
      ).rows,
    ).toEqual(homes.map(() => ({ head: '100', checkpoint_ceiling: '50', position: '51' })));
  } finally {
    try {
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
  }
}, 30_000);

test('a newly registered checkpoint leaves the exact head visible until the first advance', async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const home = 65_536 + crypto.getRandomValues(new Uint16Array(1))[0]!;
  const consumer = 'search_checkpoint_registration';
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO core.partition(partition_no,node,write_state,position) VALUES($1,'freshness-test','fenced',3)",
      [home],
    );
    for (const position of [0, 1]) {
      await client.query('SAVEPOINT registration');
      await client.query(
        'INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position) VALUES($1,$2,$3,$4)',
        [home, consumer, position === 0 ? null : 1, position],
      );
      const point = async () =>
        (
          await client.query(
            "SELECT pending,(positions->>$1::text)::integer AS head FROM search.freshness_positions WHERE consumer='' AND shard=$1::integer",
            [home],
          )
        ).rows[0];
      const grouped = async () =>
        (
          await client.query(
            'SELECT consumer,(positions->>$1::text)::integer AS value FROM search.grouped_freshness_positions WHERE shard=$1::integer/64 AND consumer=ANY($2::text[]) ORDER BY consumer',
            [home, ['', consumer]],
          )
        ).rows;
      const ceiling = position + 1;
      expect(await point()).toEqual({ pending: true, head: ceiling });
      expect(await grouped()).toEqual([
        { consumer: '', value: ceiling },
        ...(position ? [{ consumer, value: position }] : []),
      ]);
      await client.query('UPDATE core.consumer_checkpoint SET epoch=1,position=2 WHERE partition_no=$1 AND consumer=$2', [
        home,
        consumer,
      ]);
      expect(await point()).toEqual({ pending: false, head: 3 });
      expect(await grouped()).toEqual([
        { consumer: '', value: 3 },
        { consumer, value: 2 },
      ]);
      await client.query('ROLLBACK TO registration');
    }
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  }
});
