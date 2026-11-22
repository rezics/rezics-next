import { expect, test } from 'bun:test';
import pg from 'pg';
import { withQueryAccounting } from '../../src/database/pool.ts';
import { createFreshness, readFreshness } from '../../src/search/freshness.ts';

test('dense observations follow committed points, removed envelopes and a replaced backend', async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const writer = new pg.Client({ connectionString: url });
  const consumer = `search_observation_${crypto.randomUUID().replaceAll('-', '')}`;
  const first = '2024-01-01T00:00:00.000Z';
  const second = '2025-01-01T00:00:00.000Z';
  const late = '2025-02-01T00:00:00.000Z';
  const observed = createFreshness(pool, consumer);
  const statements: { text: string; operands: readonly unknown[] }[] = [];
  const check = async (count: number, oldest: string) => {
    statements.length = 0;
    const current = await withQueryAccounting(
      {
        query: (text, operands, dispatch) => {
          if (!text.startsWith('SELECT r.name AS fresh_table')) statements.push({ text, operands });
          return dispatch();
        },
        connection: (dispatch) => dispatch(),
      },
      () => observed.current(),
    );
    expect(current).toEqual(await readFreshness(pool, consumer));
    expect(current.behind).toBe(count);
    expect(current.asOf.toISOString()).toBe(oldest);
    expect(statements, statements.map((statement) => statement.text.slice(0, 160)).join(' | ')).toHaveLength(1);
  };
  const hasPrior = () =>
    statements[0]!.operands.some((operand) => typeof operand === 'string' && /^\d+:\d+:/.test(operand));
  const checkpoint = (home: number) =>
    writer.query(
      'INSERT INTO core.consumer_checkpoint(partition_no, consumer, epoch, position) SELECT partition_no,$2,epoch,position FROM core.partition WHERE partition_no=$1',
      [home, consumer],
    );
  let homes: number[] = [];
  await writer.connect();
  try {
    await writer.query('BEGIN');
    homes = (
      await writer.query<{ partition_no: number }>(
        'SELECT partition_no FROM core.partition WHERE position=0 AND partition_no BETWEEN 850 AND 1250 ORDER BY partition_no LIMIT 160 FOR UPDATE',
      )
    ).rows.map((row) => row.partition_no);
    expect(homes).toHaveLength(160);
    await writer.query(
      `INSERT INTO core.consumer_checkpoint(partition_no, consumer, epoch, position)
      SELECT partition_no,$1,epoch,position FROM core.partition WHERE position>0`,
      [consumer],
    );
    await writer.query('UPDATE core.partition SET position=1 WHERE partition_no=ANY($1)', [homes]);
    const append = (selected: number[], earliest: number) =>
      writer.query(
        `INSERT INTO core.outbox(partition_no,position,epoch,event_seq,event_count,id,type,data,recorded_at)
       SELECT partition_no,position,epoch,0,1,gen_random_uuid(),'test','{}',
         CASE WHEN partition_no=$2 THEN $3::timestamptz ELSE $4::timestamptz END
       FROM core.partition WHERE partition_no=ANY($1::int[])`,
        [selected, earliest, first, second],
      );
    await append(homes, homes[0]!);
    await writer.query('COMMIT');
    await check(160, first);
    expect(statements[0]!.text).not.toContain('pg_current_snapshot()');

    await writer.query('BEGIN');
    await writer.query('SAVEPOINT inner_change');
    await checkpoint(homes[0]!);
    await writer.query('RELEASE SAVEPOINT inner_change');
    const pending = (await writer.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid;
    await pool.query('SELECT pg_current_xact_id()');
    await check(160, first);
    expect(hasPrior()).toBe(false);
    await check(160, first);
    expect(hasPrior()).toBe(true);
    const prior = statements[0]!.operands.find((operand) => typeof operand === 'string' && /^\d+:\d+:/.test(operand));
    const inFlight = await pool.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT FROM pg_snapshot_xip($1::pg_snapshot) active WHERE active = $2::xid8) AS present',
      [prior, pending],
    );
    expect(inFlight.rows[0]!.present).toBe(true);
    await writer.query('COMMIT');
    await check(159, second);
    expect(hasPrior()).toBe(true);

    await writer.query('BEGIN');
    await checkpoint(homes[1]!);
    await writer.query('ROLLBACK');
    await check(159, second);
    await writer.query('UPDATE core.outbox SET recorded_at=$2 WHERE partition_no=$1 AND position=1', [homes[1], first]);
    await check(159, first);
    await writer.query('DELETE FROM core.outbox WHERE partition_no=$1 AND position=1', [homes[1]]);
    await check(159, second);
    await append([homes[1]!], homes[1]!);
    await check(159, first);
    expect(hasPrior()).toBe(false);
    const replaced = await pool.connect();
    replaced.release(true);
    await check(159, first);
    expect(hasPrior()).toBe(false);
    await checkpoint(homes[1]!);
    await check(158, second);
    await writer.query('DELETE FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2', [
      consumer,
      homes[0],
    ]);
    await check(159, first);
    await writer.query('UPDATE core.outbox SET recorded_at=$2 WHERE partition_no=$1 AND position=1', [homes[0], late]);
    await check(159, second);
    await writer.query('DELETE FROM core.outbox WHERE partition_no=ANY($1) AND position=1', [homes]);
    await expect(observed.current()).rejects.toThrow('without an envelope');
    await expect(readFreshness(pool, consumer)).rejects.toThrow('without an envelope');
    await append([homes[0]!], homes[0]!);
    await check(159, first);
  } finally {
    try {
      await writer.query('ROLLBACK');
      await writer.query('BEGIN');
      await writer.query('SET LOCAL session_replication_role=replica');
      await writer.query('DELETE FROM core.consumer_checkpoint WHERE consumer=$1', [consumer]);
      await writer.query('DELETE FROM core.outbox WHERE partition_no=ANY($1) AND position=1', [homes]);
      await writer.query('UPDATE core.partition SET position=0 WHERE partition_no=ANY($1)', [homes]);
      await writer.query('COMMIT');
    } finally {
      await Promise.all([writer.end(), pool.end()]);
    }
  }
}, 30_000);
