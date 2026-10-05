import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FeedItem, FeedVoteResult } from '../../../services/main/src/modules/feed/contract.ts';
import { FeedStore } from '../../../services/main/src/modules/feed/store.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { seedHome, startHomeStack, type HomeStack } from './feed-read-support.ts';

/** Every probe below must finish while another vote's or refresh's transaction is still open. */
const UNBLOCKED_MS = 1000;
const SETUP_MS = 600_000;
interface Page { items: FeedItem[]; nextCursor: string | null }

let home: HomeStack, seed: Awaited<ReturnType<typeof seedHome>>, epoch: string;
/** Two root discussions by the reader in one Realm, and two Work posts outside it. */
let first: string, second: string, works: string[];

/** A FeedStore whose transaction that sent `marker` stops at COMMIT, still holding every lock it took. */
function holdCommit(pool: Pool, marker: string) {
  let reached!: () => void, release!: () => void;
  const atCommit = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const held = { connect: async () => {
    const client = await pool.connect();
    let marked = false;
    return { release: (error?: Error | boolean) => client.release(error),
      query: (text: string, values?: unknown[]) => {
        if (text.includes(marker)) marked = true;
        if (text === 'COMMIT' && marked) {
          reached();
          return released.then(() => client.query(text));
        }
        return client.query(text, values);
      } } as unknown as PoolClient;
  } } as unknown as Pool;
  return { store: new FeedStore(held), atCommit, release };
}

/** The reader's vote on their own post appends no notification, so it holds
 * only the feed's locks: the producer log's ordering is its owner's concern. */
async function holdOwnVote(target: string) {
  const held = holdCommit(home.stack.accessPool, 'INSERT INTO access.feed_vote (');
  const vote = held.store.vote({ ...home.reader.principal, emailVerified: true }, target, epoch,
    { profile: 'feed-vote-command-v1', actingSubject: seed.reader, value: 1, expectedRevision: null },
    randomUUID(), async () => ({ actor: seed.reader, work: null }));
  await Promise.race([held.atCommit, vote.then(() => { throw new Error('The vote committed without being held'); })]);
  return { release: held.release, result: vote };
}

const voteBy = (token: string, actingSubject: string, target: string, value: -1 | 0 | 1 = 1,
  expectedRevision: string | null = null) => home.call('POST', `/v1/feed/${target.slice(-36)}/vote`,
  { profile: 'feed-vote-command-v1', actingSubject, value, expectedRevision }, token);

/** Status, body and elapsed time; the body explains an unexpected status. */
async function timed(response: Promise<Response>) {
  const started = performance.now();
  const settled = await response;
  const body = await settled.text();
  return { status: settled.status, body, ms: performance.now() - started };
}

/** A refresh turn that has locked and written the checkpoint, held before COMMIT. */
async function holdRefresh() {
  const held = holdCommit(home.stack.accessPool, 'UPDATE access.feed_checkpoint SET sequence');
  const checkpoint = await home.deps.feed.initialize(epoch);
  const advance = held.store.advance(checkpoint, checkpoint.sequence, [], new Map());
  await Promise.race([held.atCommit, advance.then(() => { throw new Error('The refresh committed without being held'); })]);
  return { checkpoint, release: async () => { held.release(); await advance; } };
}

const graphPosition = () => workRead(home.deps, new Request('http://main.internal/feed-vote-position'), {},
  session => Promise.resolve(session.position));
const placement = async (reply: string) => (await home.stack.accessPool.query<{ placement: string }>(
  'SELECT placement FROM access.realm_thread_reference WHERE data_epoch=$1 AND reply=$2', [epoch, reply])).rows[0]!.placement;
const realmRevision = async () => (await home.stack.accessPool.query<{ revision: string }>(
  'SELECT revision::text FROM access.realm_thread_state WHERE data_epoch=$1 AND realm=$2', [epoch, seed.realm.realm])).rows[0]?.revision;
const scores = async (ids: string[]) => Object.fromEntries((await home.stack.accessPool.query<{ id: string; score: number }>(
  'SELECT id, score FROM access.feed_item WHERE data_epoch=$1 AND id=ANY($2::text[])', [epoch, ids])).rows
  .map(row => [row.id, row.score]));

beforeAll(async () => {
  home = await startHomeStack('feed-vote-concurrency', { projectionStart: 'current' });
  seed = await seedHome(home, 3);
  const another = await seed.post('A second reviewed Home discussion');
  await home.project();
  epoch = home.stack.env.lineage.dataEpoch;
  [first, second] = [await placement(seed.discussion.reply), await placement(another.reply)];
  const listed = await home.json<Page>(await home.call('GET', '/v1/feed?sort=new&kinds=work&limit=20'));
  works = listed.items.filter(item => item.actor.id === seed.author).map(item => item.id);
  expect(works.length).toBeGreaterThanOrEqual(2);
  // Both discussions are ranked roots, so a vote on either maintains the Realm's order rows.
  expect((await home.stack.accessPool.query(`SELECT DISTINCT reply FROM access.realm_thread_order
    WHERE data_epoch=$1 AND realm=$2 AND reply=ANY($3::text[])`,
  [epoch, seed.realm.realm, [seed.discussion.reply, another.reply]])).rowCount).toBe(2);
}, SETUP_MS);

afterAll(async () => { await home?.stop(); });

test('with one vote held open before commit, a vote on another post and a feed watermark PUT complete', async () => {
  const revision = (await home.deps.feed.checkpoint(epoch)).revision;
  const sequence = (await home.deps.feed.checkpoint(epoch)).sequence;
  const held = await holdOwnVote(first);
  const watermark = { actingSubject: seed.reader, scope: 'following', dataEpoch: epoch, sequence };
  const [other, put] = await Promise.all([
    timed(voteBy(home.author.token, seed.author, works[0]!)),
    timed(home.call('PUT', '/v1/me/feed-watermarks/following', watermark, home.reader.token)),
  ]).finally(held.release);
  const result = await held.result;
  expect([other, put].map(({ status, body }) => ({ status, body }))).toMatchObject([{ status: 200 }, { status: 200 }]);
  expect(other.ms).toBeLessThan(UNBLOCKED_MS);
  expect(put.ms).toBeLessThan(UNBLOCKED_MS);
  expect(result).toMatchObject({ target: first, score: 1, replayed: false });
  expect(JSON.parse(other.body)).toMatchObject({ target: works[0], score: 1 });
  expect(await scores([first, works[0]!])).toEqual({ [first]: 1, [works[0]!]: 1 });
  // A score is not part of the projection's population revision.
  expect((await home.deps.feed.checkpoint(epoch)).revision).toBe(revision);
}, SETUP_MS);

test('two votes on posts in the same Realm do not block each other', async () => {
  const revision = await realmRevision();
  const held = await holdOwnVote(second);
  const other = await timed(voteBy(home.author.token, seed.author, first)).finally(held.release);
  const result = await held.result;
  expect({ status: other.status, body: other.body }).toMatchObject({ status: 200 });
  expect(other.ms).toBeLessThan(UNBLOCKED_MS);
  expect(result).toMatchObject({ target: second, score: 1 });
  expect(await scores([first, second])).toEqual({ [first]: 2, [second]: 1 });
  // Both scores reach the Realm's ranked rows in the votes' own transactions,
  // without moving the Realm's population revision.
  expect((await home.stack.accessPool.query<{ reply: string; score: number; rank_key: number }>(`SELECT r.reply, r.score, o.rank_key
    FROM access.realm_thread_reference r JOIN access.realm_thread_order o USING (data_epoch, realm, reply)
    WHERE r.data_epoch=$1 AND r.realm=$2 AND o.sort='top' AND o.period='all' ORDER BY r.score DESC`,
  [epoch, seed.realm.realm])).rows.map(row => [row.score, row.rank_key])).toEqual([[2, -2], [1, -1]]);
  expect(await realmRevision()).toBe(revision);
}, SETUP_MS);

test('page frames and cursors opened before a vote on another post keep paging', async () => {
  const frame = await home.deps.feed.openFrame(epoch);
  const sorts = ['new', 'top', 'best'] as const;
  const firstPages = new Map<string, Page>();
  for (const sort of sorts) {
    const page = await home.json<Page>(await home.call('GET', `/v1/feed?sort=${sort}&limit=1`));
    expect(page.nextCursor).toBeTruthy();
    firstPages.set(sort, page);
  }
  const realmThreads = `/v1/realms/${seed.realm.realm.slice(-36)}/threads`;
  const realmPage = await home.json<{ nextCursor: string | null }>(await home.call('GET', `${realmThreads}?sort=top&limit=1`));
  expect(realmPage.nextCursor).toBeTruthy();
  const served = new Set([...firstPages.values()].map(page => page.items[0]!.id));
  const target = works.find(id => id !== works[0] && !served.has(id))!;
  expect(target).toBeDefined();
  await home.json<FeedVoteResult>(await voteBy(home.author.token, seed.author, target));
  await home.json<FeedVoteResult>(await voteBy(home.author.token, seed.author, second));
  // The read's closing cut no longer reports "Feed changed" for another post's vote.
  await frame.close();
  // Each continues from its keyset position. Time order is vote-independent;
  // a re-ranked Top or Best item may repeat, which the owner tolerates.
  for (const sort of sorts) {
    const previous = firstPages.get(sort)!;
    const next = await home.json<Page>(await home.call('GET',
      `/v1/feed?sort=${sort}&limit=1&cursor=${encodeURIComponent(previous.nextCursor!)}`));
    if (sort === 'new') expect(next.items.map(item => item.id)).not.toContain(previous.items[0]!.id);
  }
  expect((await home.call('GET', `${realmThreads}?sort=top&limit=1&cursor=${
    encodeURIComponent(realmPage.nextCursor!)}`)).status).toBe(200);
}, SETUP_MS);

test('page frames and cursors survive the refresh of a graph event that ingests nothing', async () => {
  // A new Agent is a graph write but no feed activity. Relay it now; the feed
  // refresh that passes it runs only after the pages below are open.
  const graph = await graphPosition();
  await home.provision('Unrelated agent', home.author.token);
  await home.projectRelay();
  expect(BigInt((await graphPosition()).sequence)).toBeGreaterThan(BigInt(graph.sequence));
  const before = await home.deps.feed.checkpoint(epoch);
  const frame = await home.deps.feed.openFrame(epoch,
    { principal: { ...home.reader.principal, emailVerified: true }, agent: seed.reader });
  frame.useFollowingIndex();
  const reads = { new: '/v1/feed?sort=new&limit=1', top: '/v1/feed?sort=top&limit=1', best: '/v1/feed?sort=best&limit=1',
    following: seed.signed('/v1/feed?scope=following&sort=new&limit=1') };
  const firstPages = new Map<string, Page>();
  for (const [name, path] of Object.entries(reads)) {
    const page = await home.json<Page>(await home.call('GET', path, undefined,
      name === 'following' ? home.reader.token : undefined));
    expect(page.nextCursor).toBeTruthy();
    firstPages.set(name, page);
  }
  await home.project();
  const after = await home.deps.feed.checkpoint(epoch);
  expect(BigInt(after.sequence)).toBeGreaterThan(BigInt(before.sequence));
  expect(after.revision).toBe(before.revision);
  // Neither the checkpoint nor the Following target index moved its population.
  await frame.close();
  for (const [name, path] of Object.entries(reads)) {
    const previous = firstPages.get(name)!;
    const next = await home.json<Page>(await home.call('GET', `${path}&cursor=${encodeURIComponent(previous.nextCursor!)}`,
      undefined, name === 'following' ? home.reader.token : undefined));
    if (name === 'new' || name === 'following') expect(next.items.map(item => item.id)).not.toContain(previous.items[0]!.id);
  }
}, SETUP_MS);

test('feed pages, head probes and watermark PUTs do not wait behind a held refresh transaction', async () => {
  const held = await holdRefresh();
  const { checkpoint } = held;
  const position = { dataEpoch: epoch, sequence: checkpoint.sequence };
  const reads = Promise.all([
    timed(home.call('GET', '/v1/feed?sort=new&limit=1')),
    timed(home.call('GET', `/v1/feed/head?scope=all&after=${checkpoint.sequence}`)),
    (async () => {
      const started = performance.now();
      const rows = await home.deps.feed.page(position, checkpoint.revision, 'new', 1, undefined, undefined, 'all', Date.now());
      return { rows: rows.length, ms: performance.now() - started };
    })(),
    timed(home.call('PUT', '/v1/me/feed-watermarks/following', { actingSubject: seed.reader, scope: 'following',
      dataEpoch: epoch, sequence: checkpoint.sequence }, home.reader.token)),
  ]);
  // A probe that fails must still let the held refresh finish.
  let settled: Awaited<typeof reads>;
  try { settled = await reads; } finally { await held.release(); }
  const [page, head, frameless, watermark] = settled;
  expect([page, head, watermark].map(({ status, body }) => ({ status, body })))
    .toMatchObject([{ status: 200 }, { status: 200 }, { status: 200 }]);
  for (const read of [page, head, frameless, watermark]) expect(read.ms).toBeLessThan(UNBLOCKED_MS);
  expect(frameless.rows).toBeGreaterThan(0);
}, SETUP_MS);
