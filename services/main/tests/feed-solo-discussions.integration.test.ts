import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { digest } from '../src/modules/recommendation/derived-generation.ts';
import { FeedStore } from '../src/modules/feed/store.ts';

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

test('a kind seek returns discussions that are older than the newest catalogue posts', async () => {
  await pool.query(readFileSync(join(accessDir, SOLO), 'utf8'));
  const epoch = 'kind-seek';
  await pool.query(`INSERT INTO access.feed_checkpoint (data_epoch, sequence, revision)
    VALUES ($1, 1, gen_random_uuid()) ON CONFLICT (id) DO UPDATE
    SET data_epoch = EXCLUDED.data_epoch, sequence = EXCLUDED.sequence, revision = EXCLUDED.revision`, [epoch]);
  const realm = id(910);
  await pool.query(`INSERT INTO access.feed_item (data_epoch, id, sequence, kind, occurred_at, time_basis, score,
      best_key, realm, group_bucket, group_key, group_leader, group_members, sort_time)
    SELECT $1, 'https://rezics.com/id/00000000-0000-4000-8000-' || lpad(n::text, 12, '0'), n, 'adoption',
      now(), 'revision', 0, 0, NULL, 'adopt-' || n, 'adopt-' || n, true,
      ARRAY['https://rezics.com/id/00000000-0000-4000-8000-' || lpad(n::text, 12, '0')], now()
    FROM generate_series(1, 200) AS n`, [epoch]);
  const put = (n: number, score: number) => pool.query(
    `INSERT INTO access.feed_item (data_epoch, id, sequence, kind, occurred_at, time_basis, score, best_key,
      realm, group_bucket, group_key, group_leader, group_members, sort_time)
     VALUES ($1,$2,$3,'discussion', now() - make_interval(hours => 1), 'revision', $4::int, $4::float8, $5, $2, $2, true, ARRAY[$2],
      now() - make_interval(hours => 1))`,
    [epoch, id(n), n, score, realm]);
  await put(2001, 8);
  await put(2002, 6);
  const store = new FeedStore(pool);
  const position = { dataEpoch: epoch, sequence: '1' };
  const revision = (await store.checkpoint(epoch)).revision;
  const asOf = Date.now() + 60_000;
  const newest = await store.page(position, revision, 'new', 8, undefined, undefined, 'all', asOf);
  expect(newest.every(row => row.kind === 'adoption')).toBe(true);
  const discussed = await store.page(position, revision, 'new', 8, undefined, undefined, 'all', asOf, ['discussion']);
  expect(discussed.map(row => row.id).sort()).toEqual([id(2001), id(2002)].sort());
  // Best keeps those older discussions in its cohort, past a full page of newer posts.
  const buried = await store.page(position, revision, 'best', 20, undefined, undefined, 'all', asOf);
  expect(buried.map(row => row.id)).not.toEqual(expect.arrayContaining([id(2001)]));
  let cursor: { key: string; id: string } | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const rows = await store.page(position, revision, 'best', 20, cursor, undefined, 'all', asOf);
    for (const row of rows.slice(0, 20)) seen.add(row.id);
    const last = rows[19];
    if (!last) break;
    cursor = { key: last.order_key, id: last.id };
  }
  expect(seen.has(id(2001))).toBe(true);
  expect(seen.has(id(2002))).toBe(true);
});
