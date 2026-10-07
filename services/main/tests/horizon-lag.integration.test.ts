import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { Pool } from 'pg';
import { horizonLagSql, readHorizonLag } from '../src/modules/horizon/lag.ts';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('held writer ages rise while all three horizon consumers retain pending rows', async () => {
  const state = resolve(import.meta.dir, '../../../.temp', `horizon-lag-${Bun.randomUUIDv7()}`);
  const data = join(state, 'data');
  const socket = resolve(import.meta.dir, '../../../.temp/pg-sock');
  mkdirSync(state, { recursive: true });
  mkdirSync(socket, { recursive: true });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 4 });
  try {
    // Minimal owner tables exercise the actual read query without unrelated schema or graph preparation.
    await pool.query(`CREATE SCHEMA access;
      CREATE TABLE access.notification_producer_event(epoch bigint,xid xid8,id bigint,created_at timestamptz);
      CREATE INDEX ON access.notification_producer_event(epoch,xid,id);
      CREATE TABLE access.notification_producer_cursor(consumer text,epoch bigint,xid xid8,id bigint);
      CREATE TABLE access.reader_review_rank_change(epoch bigint,xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
        id bigint,position bigint,work text,occurred_at timestamptz,delta smallint);
      CREATE INDEX ON access.reader_review_rank_change(epoch,xid,id) WHERE position IS NULL;
      CREATE TABLE access.recovery_fence(id boolean PRIMARY KEY, generation bigint NOT NULL);
      INSERT INTO access.recovery_fence VALUES (true, 0);
      CREATE TABLE access.editorial_event(epoch bigint,xid xid8,entry bigint,sequence bigint,created_at timestamptz);
      CREATE INDEX ON access.editorial_event(epoch,xid,entry) WHERE sequence IS NULL;`);
    await pool.query(`INSERT INTO access.reader_review_rank_change
      (epoch,xid,id,position,work,occurred_at,delta) VALUES
      (0,'1',1,NULL,'legacy',clock_timestamp()-interval '1 year',1)`);
    await pool.query(readFileSync(resolve(import.meta.dir, '../migrations/access/1332_review_rank_enqueue_time.sql'), 'utf8'));
    const legacyRow = (await pool.query<{ missing: boolean; old_review: boolean }>(`
      SELECT enqueued_at IS NULL AS missing,
        occurred_at < clock_timestamp() - interval '11 months' AS old_review
      FROM access.reader_review_rank_change WHERE id = 1`)).rows[0];
    expect(legacyRow).toEqual({ missing: true, old_review: true });
    const legacy = await readHorizonLag(pool);
    expect(legacy.reviewRank.oldestPendingRowAgeBasis).toBe('unknown');
    expect(legacy.reviewRank.oldestPendingRowAgeSeconds).toBeNull();
    await pool.query('TRUNCATE access.reader_review_rank_change');
    const planner = await pool.connect();
    try {
      await planner.query('SET enable_seqscan = off');
      const plan = (await planner.query(`EXPLAIN (FORMAT JSON) ${horizonLagSql}`)).rows[0]['QUERY PLAN'];
      const scans: Record<string, string> = {};
      const visit = (node: Record<string, any>) => {
        if (node['Relation Name']) scans[node['Relation Name']] = node['Node Type'];
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(plan[0].Plan);
      for (const table of ['notification_producer_event', 'reader_review_rank_change', 'editorial_event']) {
        expect(scans[table]).toBe('Index Scan');
      }
    } finally { await planner.query('RESET enable_seqscan'); planner.release(); }
    expect((await readHorizonLag(pool)).notification.oldestWriterAgeSeconds).toBeNull();
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT 1');
      expect((await readHorizonLag(pool)).notification.oldestWriterAgeSeconds).toBeNull();
      await writer.query('SELECT pg_current_xact_id()');
      await pool.query(`INSERT INTO access.notification_producer_event VALUES
        (0,'1',1,clock_timestamp()-interval '1 hour'),(0,'2',2,clock_timestamp()-interval '10 seconds');
        INSERT INTO access.notification_producer_cursor VALUES ('notification-producer-v1',0,'1',1);
        INSERT INTO access.reader_review_rank_change
          (epoch,xid,id,position,occurred_at,enqueued_at) VALUES
          (0,'1',1,1,clock_timestamp()-interval '1 year',clock_timestamp()-interval '1 year'),
          (0,'2',2,NULL,clock_timestamp()-interval '1 year',clock_timestamp()-interval '10 seconds');
        INSERT INTO access.editorial_event VALUES
        (0,'1',1,1,clock_timestamp()-interval '1 hour'),(0,'2',2,NULL,clock_timestamp()-interval '10 seconds');`);
      const before = await readHorizonLag(pool);
      expect(before.writerVisibility).toBe('all-sessions');
      await pool.query(`CREATE ROLE horizon_observer;
        GRANT USAGE ON SCHEMA access TO horizon_observer;
        GRANT SELECT ON ALL TABLES IN SCHEMA access TO horizon_observer`);
      const observer = await pool.connect();
      try {
        await observer.query('SET ROLE horizon_observer');
        const restricted = await readHorizonLag(observer);
        expect(restricted.writerVisibility).toBe('own-role');
        expect(restricted.notification.oldestWriterAgeSeconds).toBeNull();
        expect(restricted.notification.oldestPendingRowAgeSeconds!).toBeGreaterThanOrEqual(10);
      } finally { await observer.query('RESET ROLE'); observer.release(); }
      await writer.query('SELECT pg_sleep(0.15)');
      const after = await readHorizonLag(pool);
      for (const consumer of ['notification', 'reviewRank', 'editorial'] as const) {
        expect(after[consumer].oldestWriterAgeSeconds!).toBeGreaterThan(before[consumer].oldestWriterAgeSeconds! + 0.1);
        expect(after[consumer].oldestPendingRowAgeSeconds!).toBeGreaterThanOrEqual(10);
        expect(after[consumer].oldestPendingRowAgeSeconds!).toBeLessThan(30);
      }
      // The pending review occurred a year ago. Waiting age is its enqueue clock.
      expect(after.reviewRank.oldestPendingRowAgeBasis).toBe('enqueue');
      await writer.query('ROLLBACK');
      expect((await readHorizonLag(pool)).editorial.oldestWriterAgeSeconds).toBeNull();
      await pool.query(`TRUNCATE access.notification_producer_event,access.reader_review_rank_change,access.editorial_event`);
      const empty = await readHorizonLag(pool);
      expect(empty.notification.oldestPendingRowAgeSeconds).toBeNull();
      expect(empty.reviewRank.oldestPendingRowAgeBasis).toBe('none');
      await pool.query(`SELECT access.append_reader_review_rank_change($1, clock_timestamp() - interval '1 year', 1)`,
        ['urn:rezics:work:old-review']);
      const queued = await readHorizonLag(pool);
      expect(queued.reviewRank.oldestPendingRowAgeBasis).toBe('enqueue');
      expect(queued.reviewRank.oldestPendingRowAgeSeconds!).toBeGreaterThanOrEqual(0);
      expect(queued.reviewRank.oldestPendingRowAgeSeconds!).toBeLessThan(60);
      expect((await pool.query<{ old_review: boolean; just_enqueued: boolean }>(`
        SELECT occurred_at < clock_timestamp() - interval '11 months' AS old_review,
          enqueued_at > clock_timestamp() - interval '1 minute' AS just_enqueued
        FROM access.reader_review_rank_change`)).rows[0]).toEqual({ old_review: true, just_enqueued: true });
      await pool.query(`INSERT INTO access.reader_review_rank_change(epoch,work,occurred_at,delta)
        SELECT generation,$1,clock_timestamp()-interval '1 year',1 FROM access.recovery_fence WHERE id`,
        ['direct-omit']);
      expect((await pool.query<{ old_review: boolean; just_enqueued: boolean }>(`
        SELECT occurred_at < clock_timestamp() - interval '11 months' AS old_review,
          enqueued_at > clock_timestamp() - interval '1 minute' AS just_enqueued
        FROM access.reader_review_rank_change WHERE work = 'direct-omit'`)).rows[0])
        .toEqual({ old_review: true, just_enqueued: true });
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  } finally {
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 30_000);
