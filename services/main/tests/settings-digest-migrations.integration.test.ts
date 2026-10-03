import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `settings-digest-${Bun.randomUUIDv7()}`);
const accessDir = join(root, 'services/main/migrations/access');
let pool: Pool | null = null;

const port = () => new Promise<number>((done, fail) => {
  const server = createServer();
  server.once('error', fail);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return fail(new Error('No PostgreSQL port'));
    server.close(() => done(address.port));
  });
});

afterAll(async () => {
  await pool?.end();
  try { execFileSync('pg_ctl', ['-D', join(state, 'pgdata'), '-m', 'immediate', 'stop']); }
  catch { /* PostgreSQL may not have started. */ }
  rmSync(state, { recursive: true, force: true });
});

test('settings Access migrations preserve prior notification kinds and create digest ledgers', async () => {
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const pgPort = await port();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${pgPort} -k ${socket}`, '-w', 'start'], { cwd: state });
  pool = new Pool({ host: '127.0.0.1', port: pgPort, user: process.env.USER,
    database: 'postgres', max: 2 });
  for (const file of schemaFiles(root, 'access')) {
    await pool.query(readFileSync(join(accessDir, file), 'utf8'));
  }
  const tables = (await pool.query<{ name: string }>(`SELECT table_name AS name
    FROM information_schema.tables WHERE table_schema = 'access'
      AND table_name IN ('notification_seen', 'notification_digest_day',
        'notification_digest_candidate', 'chapter_notification_event', 'feed_post_vote_event')`)).rows;
  expect(tables.map(row => row.name).sort()).toEqual([
    'chapter_notification_event', 'feed_post_vote_event', 'notification_digest_candidate',
    'notification_digest_day', 'notification_seen']);
  const kinds = (await pool.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid = 'access.notification_producer_event'::regclass
      AND contype = 'c'`)).rows.map(row => row.definition).join(' ');
  expect(kinds).toContain('chapter_published');
  expect(kinds).toContain('feed_post_vote');
  expect(kinds).toContain('realm_invitation');
}, 120_000);
