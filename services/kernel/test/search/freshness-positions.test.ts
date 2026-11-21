import { expect, test } from 'bun:test';
import pg from 'pg';
import freshness from '../../src/search/freshness.sql';
import { subjectConsumer } from '../../src/search/consumer-name.ts';

test('whole-generation freshness follows native backfill, replay, retirement and rollback', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const [up, down] = (
    await Bun.file(
      new URL('../../db/search/migrations/20261121024000_freshness_home_lanes.sql', import.meta.url),
    ).text()
  ).split('-- migrate:down');
  const first = subjectConsumer('positions-', 1);
  const next = subjectConsumer('positions-', 2);
  const generic = 'other_freshness_reader';
  // Exercise bigint precision beyond the exact integer range of JavaScript numbers.
  const cut = '9007199254740993';
  const earlier = new Date('2026-01-01T00:00:01Z');
  const later = new Date('2026-01-01T00:00:02Z');
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
    WHERE relid IN ('search.freshness_home'::regclass, 'search.freshness_gap'::regclass, 'core.partition'::regclass,
                    'core.consumer_checkpoint'::regclass, 'core.outbox'::regclass)`)
      ).rows[0]!.n,
    );

  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(down!);
    await db.query('UPDATE core.partition SET position = $1', [cut]);
    await db.query(
      `INSERT INTO core.consumer_checkpoint(partition_no, consumer, epoch, position)
      SELECT p.partition_no, c, p.epoch, p.position FROM core.partition p CROSS JOIN unnest($1::text[]) c`,
      [[first, next, generic]],
    );
    await db.query(up!);
    await db.query('ANALYZE search.freshness_home; ANALYZE search.freshness_gap');
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
    const lagBefore = await tuples();
    expect(await read(first)).toMatchObject({ behind: 2, oldest: earlier });
    const behindRows = (await tuples()) - lagBefore;
    expect(behindRows).toBeLessThan(512);
    console.info(JSON.stringify({ homes: 4096, caughtUpRows, twoBehindRows: behindRows }));
    expect(await read(generic)).toMatchObject({ behind: 2, oldest: earlier });

    await db.query('SAVEPOINT advances');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(
      'UPDATE core.consumer_checkpoint SET position = position + 1 WHERE consumer = $1 AND partition_no = 4095',
      [first],
    );
    expect(await read(first)).toMatchObject({ behind: 1, oldest: later });
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
    expect(
      (await db.query('SELECT partition_no FROM search.freshness_home WHERE checkpoints ? $1', [first])).rows,
    ).toEqual([]);
    // The next envelope after a missing checkpoint is position one, absent from this history.
    expect(await read(first)).toMatchObject({ behind: 4096, oldest: null });
    expect(await read(next)).toMatchObject({ behind: 2, oldest: earlier });
    await db.query('TRUNCATE core.consumer_checkpoint');
    expect(await read(next)).toMatchObject({ behind: 4096, oldest: null });
  } finally {
    try {
      await db.query('ROLLBACK');
    } finally {
      await db.end();
    }
  }
}, 30_000);

test('different homes in one former shard can advance before either transaction finishes', async () => {
  const connections = [new pg.Client(process.env.DATABASE_URL), new pg.Client(process.env.DATABASE_URL)];
  await Promise.all(connections.map((client) => client.connect()));
  try {
    for (const client of connections) {
      await client.query(
        "BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL lock_timeout = '1s'; SELECT pg_current_snapshot()",
      );
    }
    for (const [i, client] of connections.entries()) {
      const home = 64 + i;
      await client.query('UPDATE core.partition SET position = position + 1 WHERE partition_no = $1', [home]);
      await client.query(
        `INSERT INTO core.consumer_checkpoint(partition_no, consumer, epoch, position)
         SELECT partition_no, 'search_pair_regression', epoch, position FROM core.partition WHERE partition_no = $1`,
        [home],
      );
    }
  } finally {
    await Promise.all(
      connections.map(async (client) => {
        try {
          await client.query('ROLLBACK');
        } finally {
          await client.end();
        }
      }),
    );
  }
});
