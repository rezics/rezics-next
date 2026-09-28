import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { digest } from '../src/modules/recommendation/derived-generation.ts';

// Migration 820 on a real Access schema: discussions and replies grouped
// before it become posts of their own, with the keys refresh gives them
// alone, and a second run changes nothing.

const root = resolve(import.meta.dir, '../../..');
const accessDir = join(root, 'services/main/migrations/access');
const SOLO = '820_feed_solo_discussions.sql';
const state = join(root, '.temp', `feed-solo-${Bun.randomUUIDv7()}`);
let pool: Pool;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

beforeAll(async () => {
  const data = join(state, 'pgdata');
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
  pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 2 });
  for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: accessDir })].sort().filter(file => file < SOLO)) {
    await pool.query(readFileSync(join(accessDir, file), 'utf8'));
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  try { execFileSync('pg_ctl', ['-D', join(state, 'pgdata'), '-m', 'immediate', 'stop']); } catch { /* not started */ }
  rmSync(state, { recursive: true, force: true });
});

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const realm = id(900), work = id(901);

async function insert(n: number, kind: string, bucket: string, leader: boolean, members: number[], score = 0) {
  await pool.query(`INSERT INTO access.feed_item (data_epoch, id, sequence, kind, occurred_at, time_basis, score,
    best_key, realm, group_bucket, group_key, group_leader, group_members, sort_time)
    VALUES ('epoch', $1, $2, $3, now(), 'revision', $4, 0, $5, $6, $7, $8, $9, now())`,
  [id(n), n, kind, score, realm, bucket, `group-${bucket}`, leader, members.map(id)]);
}

const rows = async () => (await pool.query<{ id: string; group_leader: boolean; group_members: string[];
  group_key: string; group_bucket: string; score: number }>(
  'SELECT id, group_leader, group_members, group_key, group_bucket, score FROM access.feed_item ORDER BY id')).rows;

test('G401: grouped discussions and replies become posts of their own, and replaying the migration changes nothing', async () => {
  const bucket = digest(['discussion', realm, work, '2026-09-28']);
  // Three discussions of one Work on one day, grouped under the first; two replies under another.
  await insert(1, 'discussion', bucket, true, [1, 2, 3], 7);
  await insert(2, 'discussion', bucket, false, [2]);
  await insert(3, 'discussion', bucket, false, [3]);
  await insert(4, 'reply', 'reply-bucket', true, [4, 5], 3);
  await insert(5, 'reply', 'reply-bucket', false, [5]);
  // Other kinds keep their groups: a day's chapters are one post.
  await insert(6, 'contribution', 'chapters', true, [6, 7], 2);
  await insert(7, 'contribution', 'chapters', false, [7]);
  await pool.query(readFileSync(join(accessDir, SOLO), 'utf8'));
  const after = await rows();
  for (const n of [1, 2, 3, 4, 5]) {
    expect(after.find(row => row.id === id(n))).toMatchObject({ group_leader: true, group_members: [id(n)],
      group_bucket: digest(['home-solo-v1', id(n)]) });
  }
  // A promoted post takes the key refresh would have given it alone; a former leader keeps its key and score.
  expect(after.find(row => row.id === id(2))!.group_key).toBe(digest(['home-group-v1', id(2)]));
  expect(after.find(row => row.id === id(1))).toMatchObject({ group_key: `group-${bucket}`, score: 7 });
  expect(after.find(row => row.id === id(6))).toMatchObject({ group_leader: true, group_members: [id(6), id(7)] });
  expect(after.find(row => row.id === id(7))).toMatchObject({ group_leader: false });

  await pool.query(readFileSync(join(accessDir, SOLO), 'utf8'));
  expect(await rows()).toEqual(after);
}, 60_000);
