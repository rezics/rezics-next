import { afterAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createThread, revisePost } from '../../src/content/commands.ts';
import { createReviewDiscoverySource } from '../../src/content/review-discovery.ts';
import { maintainReviewCensusBatch, REVIEW_CENSUS_BATCH_PAGES } from '../../src/content/review-census-work.ts';
import { softDeletePost } from '../../src/content/erase-post.ts';
import { restorePost } from '../../src/content/restore-post.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

const fixture = await standingFixture();
afterAll(() => fixture.close());
const routeKey = new Uint8Array(32).fill(73);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const source = createReviewDiscoverySource({ pool: fixture.pool, access: fixture.access, tokens }, () => ({
  actor: { kind: 'anonymous' },
  deadline: Date.now() + 30_000,
}));

test('a census maintenance turn yields after bounded progress and stops when authority is preparing', async () => {
  let pages = 0;
  const changed = { state: 'changed' as const, generation: Bun.randomUUIDv7(), examined: 0 };
  expect(await maintainReviewCensusBatch(1, async () => { pages++; return changed; })).toBe(changed);
  expect(pages).toBe(REVIEW_CENSUS_BATCH_PAGES);
  pages = 0;
  expect(await maintainReviewCensusBatch(1, async () => {
    pages++;
    return { ...changed, state: 'preparing' };
  })).toMatchObject({ state: 'preparing' });
  expect(pages).toBe(1);
});

test('a retained native census resumes, replaces restored lifecycles and keeps incomplete authority preparing', async () => {
  const author = (await fixture.context()).actor;
  const board = (
    await fixture.reader.query("SELECT route,board_id FROM content.board WHERE realm_id IS NULL AND purpose='reviews'")
  ).rows[0]!;
  await fixture.grant(author.accountId, 'thread:create', { route: board.route, id: board.board_id });
  const subject = newId(0x6bd0);
  await fixture.reader.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
     VALUES($1,$2,'schema:Book',$2,'visible',1)`,
    [routeOf(subject), subject],
  );
  const create = (target: string) =>
    createThread(
      { pool: fixture.pool, access: fixture.access, routeKey },
      author,
      {
        kind: 'review',
        title: 'A census review',
        body: fromPlainText('A readable opening.'),
        licence: 'MIT',
        subjectIds: [target],
        boardId: board.board_id,
        visibility: 'published',
      },
      { idempotencyKey: Bun.randomUUIDv7(), requestId: Bun.randomUUIDv7(), deadline: Date.now() + 30_000 },
    );
  const written = await create(subject);
  for (let index = 1; index < 26; index++) {
    const target = newId(0x6bd0);
    await fixture.reader.query(
      `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
       VALUES($1,$2,'schema:Book',$2,'visible',1)`,
      [routeOf(target), target],
    );
    await create(target);
  }
  const partition = partitionOf(routeOf(written.value.threadId)!);
  expect(await source.censusCoverage(partition)).toMatchObject({ state: 'preparing', installed: false });
  expect(await source.maintainCensus(partition)).toMatchObject({ state: 'progress', examined: 25 });
  const beforeRepair = await source.censusCoverage(partition);
  const commitObserver = observeSql(fixture.pool);
  try {
    await source.pageWithCut(partition, null, 1);
    const statement = commitObserver.records.find(({ statement }) =>
      statement.includes('AS "lifecycleState"') && statement.includes('ORDER BY t.route,t.thread_id'),
    )!.statement;
    const barrier = commitObserver.hold({ statement }, 'after');
    const pending = source.maintainCensus(partition);
    try {
      await barrier.entered;
      await fixture.reader.query(
        'UPDATE content.thread SET security_revision=security_revision+1 WHERE route >= $1 AND route < $2',
        [partition * 16, (partition + 1) * 16],
      );
    } finally {
      barrier.release();
    }
    expect(await pending).toMatchObject({ state: 'changed', examined: 0 });
    expect((await source.censusCoverage(partition)).generation).not.toBe(beforeRepair.generation);
  } finally {
    await commitObserver.close();
  }
  expect(await source.maintainCensus(partition)).toMatchObject({ state: 'progress', examined: 25 });
  expect(await source.censusCoverage(partition)).toMatchObject({ installed: false, missing: 'census-installation' });
  const resumed = createReviewDiscoverySource({ pool: fixture.pool, access: fixture.access, tokens }, () => ({
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  }));
  expect(await resumed.maintainCensus(partition)).toMatchObject({ state: 'exhausted', examined: 1 });
  const installed = await source.censusCoverage(partition);
  expect(installed).toMatchObject({ state: 'preparing', installed: true, missing: 'native-eligibility-coverage' });
  expect(await source.count(partition)).toMatchObject({ unavailable: true });
  const replay = await source.maintainCensus(partition);
  expect(replay).toMatchObject({ state: 'exhausted', examined: 0, generation: installed.generation });
  const retained = await fixture.reader.query(
    'SELECT board_id,subject_id,opening_id,source_version,eligible FROM content.review_census_episode WHERE route=$1 AND thread_id=$2',
    [routeOf(written.value.threadId), written.value.threadId],
  );
  expect(retained.rows).toHaveLength(2);
  expect(new Set(retained.rows.map((row) => row.source_version)).size).toBe(2);
  for (const row of retained.rows)
    expect(row).toMatchObject({
      board_id: board.board_id,
      subject_id: subject,
      opening_id: written.value.itemId,
      source_version: expect.stringMatching(/^rv1_/),
      eligible: true,
    });
  await revisePost(
    { pool: fixture.pool, access: fixture.access, routeKey },
    author,
    {
      itemId: written.value.itemId,
      threadId: written.value.threadId,
      body: fromPlainText('A replacement opening.'),
      subjectIds: [subject],
      mediaIds: [],
      licence: 'MIT',
      title: 'A replacement title',
    },
    { idempotencyKey: Bun.randomUUIDv7(), requestId: Bun.randomUUIDv7(), deadline: Date.now() + 30_000 },
  );
  expect(await resumed.censusCoverage(partition)).toMatchObject({ installed: false, missing: 'population-cut' });
  expect(await resumed.maintainCensus(partition)).toMatchObject({ state: 'changed' });
  expect(
    (
      await fixture.reader.query(
        'SELECT count(*)::integer AS count FROM content.review_census_episode WHERE route=$1 AND thread_id=$2',
        [routeOf(written.value.threadId), written.value.threadId],
      )
    ).rows[0]?.count,
  ).toBe(2);
  expect(await maintainReviewCensusBatch(partition, resumed.maintainCensus)).toMatchObject({ state: 'exhausted' });
  expect(
    (
      await fixture.reader.query(
        'SELECT observed_public::integer AS count FROM content.review_census_installation WHERE route=$1',
        [partition * 16],
      )
    ).rows[0]?.count,
  ).toBe(26);
  const before = (await source.hydrate(partition, [written.value.threadId])).reviews[0]!;
  const deps = { pool: fixture.pool, access: fixture.access, routeKey };
  const request = () => ({ idempotencyKey: Bun.randomUUIDv7(), requestId: Bun.randomUUIDv7(), deadline: Date.now() + 30_000 });
  await fixture.grant(author.accountId, 'post:erase', { route: routeOf(written.value.itemId)!, id: written.value.itemId });
  await softDeletePost(deps, author, { postId: written.value.itemId, reason: 'Withdraw review' }, request());
  await restorePost(deps, author, written.value.itemId, request());
  const restored = (await source.hydrate(partition, [written.value.threadId])).reviews[0]!;
  expect(restored.revisionId).toBe(before.revisionId);
  expect(restored.sourceVersion).not.toBe(before.sourceVersion);
  expect(await source.censusCoverage(partition)).toMatchObject({ installed: false, missing: 'population-cut' });
  expect(await maintainReviewCensusBatch(partition, resumed.maintainCensus)).toMatchObject({ state: 'exhausted' });
  expect((await source.censusCoverage(partition)).generation).not.toBe(installed.generation);
  expect(await source.count(partition)).toMatchObject({ unavailable: true });

  // A native projection repair need not publish a new domain position. Its source
  // row must still match after owner hydration before a census episode is retained.
  const observer = observeSql(fixture.pool);
  try {
    await source.pageWithCut(partition, null, 1);
    const statement = observer.records.find(({ statement }) =>
      statement.includes('AS "lifecycleState"') && statement.includes('LIMIT $5'),
    )!.statement;
    const barrier = observer.hold({ statement }, 'after');
    const pending = source.pageWithCut(partition, null, 1);
    try {
      await barrier.entered;
      await fixture.reader.query(
        'UPDATE content.thread SET security_revision=security_revision+1 WHERE route >= $1 AND route < $2',
        [partition * 16, (partition + 1) * 16],
      );
    } finally {
      barrier.release();
    }
    expect(await pending).toMatchObject({ state: 'changed', missing: 'source-lifecycle', reviews: [], next: null });
  } finally {
    await observer.close();
  }
  expect(await source.pageWithCut(partition, null, 1)).not.toHaveProperty('census');
}, 60_000);

test('an empty census and a stale cut remain distinguishable from a complete zero total', async () => {
  const partition = 0xfed;
  expect(await source.maintainCensus(partition)).toMatchObject({ state: 'exhausted', examined: 0 });
  const before = await source.censusCoverage(partition);
  expect(before).toMatchObject({ state: 'preparing', installed: true });
  await fixture.reader.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [partition]);
  try {
    expect(await source.censusCoverage(partition)).toMatchObject({ state: 'unavailable', installed: false });
  } finally {
    await fixture.reader.query("UPDATE core.partition SET write_state='active' WHERE partition_no=$1", [partition]);
  }
  expect(await source.count(partition)).toMatchObject({ unavailable: true });
});
