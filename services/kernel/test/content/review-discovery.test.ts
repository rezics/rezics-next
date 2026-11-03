import { afterAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createThread, revisePost } from '../../src/content/commands.ts';
import { runCommand, type CommandOutcome } from '../../src/command/command.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { softDeletePost } from '../../src/content/erase-post.ts';
import { restorePost } from '../../src/content/restore-post.ts';
import {
  createReviewDiscoveryDispatchEffect,
  createReviewDiscoveryEffect,
  processReviewDiscoveryPage,
  readReviewDiscoveryProgress,
} from '../../src/content/review-discovery-lifecycle.ts';
import {
  readReviewDiscoveryChanges,
  refreshReviewDiscoveryChanges,
} from '../../src/content/review-discovery-changes.ts';
import { REVIEW_DISCOVERY_OPENED, type ReviewDiscoveryWork } from '../../src/content/review-discovery-events.ts';
import { observeSql } from './support/sql-observer.ts';
import { erasePost, takedown } from '../../src/content/moderation.ts';
import { createReviewDiscoverySource } from '../../src/content/review-discovery.ts';
import { anchorRoute, routeOf, newId, partitionOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';

const fixture = await standingFixture();
afterAll(() => fixture.close());

const routeKey = new Uint8Array(32).fill(73);
const request = () => ({
  idempotencyKey: Bun.randomUUIDv7(),
  deadline: Date.now() + 30_000,
  requestId: Bun.randomUUIDv7(),
});
function requestAt(route: number) {
  for (;;) {
    const idempotencyKey = Bun.randomUUIDv7();
    if (anchorRoute(routeKey, idempotencyKey) === route)
      return { ...request(), idempotencyKey };
  }
}
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };

async function original(
  outcome: Pick<CommandOutcome<unknown>, 'partition' | 'position' | 'epoch'>,
  type: string,
): Promise<CloudEvent> {
  const row = (
    await fixture.reader.query(
      'SELECT id,type,subject,data,recorded_at FROM core.outbox WHERE partition_no=$1 AND position=$2 AND epoch=$3 AND type=$4',
      [outcome.partition, outcome.position.toString(), outcome.epoch, type],
    )
  ).rows[0]!;
  return {
    specversion: '1.0',
    datacontenttype: 'application/json',
    id: row.id,
    type: row.type,
    subject: row.subject ?? undefined,
    data: row.data,
    time: row.recorded_at.toISOString(),
    source: `urn:rezics:log:${outcome.partition}.${outcome.epoch}`,
    sequence: outcome.position.toString().padStart(19, '0'),
  };
}

const effect = createReviewDiscoveryEffect(fixture.pool);
async function invalidate(outcome: Pick<CommandOutcome<unknown>, 'partition' | 'position' | 'epoch'>, type: string) {
  const event = await original(outcome, type);
  await effect.run(event);
  const ref = { route: outcome.partition * 16, id: event.id };
  for (let pages = 0; pages < 20; pages++) {
    const page = await processReviewDiscoveryPage(fixture.pool, ref);
    expect(page.examined).toBeLessThanOrEqual(100);
    if (page.complete) return { event, ref };
  }
  throw new Error('Review discovery fixture exceeded its bounded continuation');
}

async function subjectGate(subject: string, visibility: 'hidden' | 'visible') {
  return runCommand(
    fixture.pool,
    { partition: partitionOf(routeOf(subject)!), deadline: Date.now() + 30_000 },
    async (tx) => {
      const changed = (
        await tx.query(
          'UPDATE semantic.subject SET visibility=$3,security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2 RETURNING security_revision::integer AS revision',
          [routeOf(subject), subject, visibility],
        )
      ).rows[0]!;
      return {
        value: null,
        events: [
          {
            type: 'com.rezics.subject.revised.v1',
            subject,
            data: { id: subject, revision: changed.revision, kind: 'identity' },
          },
        ],
      };
    },
  );
}

test('public review discovery refreshes the same thread and omits protected or removed reviews', async () => {
  const author = (await fixture.context()).actor;
  const subjectId = newId(0x6b30);
  await fixture.reader.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
     VALUES ($1,$2,'schema:Book',$2,'visible',1)`,
    [routeOf(subjectId), subjectId],
  );
  const board = (
    await fixture.reader.query<{ route: number; board_id: string }>(
      "SELECT route, board_id FROM content.board WHERE realm_id IS NULL AND purpose = 'reviews'",
    )
  ).rows[0]!;
  await fixture.grant(author.accountId, 'thread:create', { route: board.route, id: board.board_id });

  const create = (reviewAuthor: typeof author, target: string, body: string) =>
    createThread(
      { pool: fixture.pool, access: fixture.access, routeKey },
      reviewAuthor,
      {
        kind: 'review',
        title: 'A public review title',
        body: fromPlainText(body),
        licence: 'MIT',
        subjectIds: [target],
        boardId: board.board_id,
        visibility: 'published',
      },
      request(),
    );
  const published = await create(author, subjectId, 'Current review excerpt.');
  const partition = partitionOf(routeOf(published.value.threadId)!);
  const source = createReviewDiscoverySource({ pool: fixture.pool, access: fixture.access, tokens }, () => ({
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  }));

  const admitted = await invalidate(published, 'com.rezics.content.thread.created.v1');
  let changePage = await readReviewDiscoveryChanges(fixture.pool, partition);
  expect(changePage.changes).toHaveLength(1);
  expect(changePage.changes[0]!.origin).toMatchObject({
    partition: published.partition,
    epoch: published.epoch,
    position: published.position.toString(),
    id: admitted.event.id,
    type: admitted.event.type,
  });
  expect((await refreshReviewDiscoveryChanges(source, changePage)).reviews[0]?.id).toBe(published.value.threadId);
  const first = await source.read(partition, [published.value.threadId]);
  expect(first.reviews.map((item) => item.id)).toEqual([published.value.threadId]);
  expect(first.reviews[0]!.sourceVersion).toMatch(/^rv1_[A-Za-z0-9_-]{43}$/u);
  expect(first.reviews[0]).toMatchObject({
    subjectId,
    title: 'A public review title',
    excerpt: 'Current review excerpt.',
  });
  expect((await source.hydrate(partition, [published.value.threadId])).reviews[0]).toMatchObject({
    authorId: author.accountId,
    excerpt: 'Current review excerpt.',
  });
  expect(await source.count(partition)).toMatchObject({ partition, position: first.position, unavailable: true });

  await fixture.reader.query(
    "UPDATE content.board SET visibility='protected', security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
    [board.route, board.board_id],
  );
  expect((await source.read(partition, [published.value.threadId])).reviews).toEqual([]);
  await fixture.reader.query(
    "UPDATE content.board SET visibility='published', security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
    [board.route, board.board_id],
  );

  const hiddenAuthor = (await fixture.context()).actor;
  await fixture.grant(hiddenAuthor.accountId, 'thread:create', { route: board.route, id: board.board_id });
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    const hiddenSubject = newId(0x6b32);
    await fixture.reader.query(
      `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
       VALUES ($1,$2,'schema:Book',$2,'hidden',1)`,
      [routeOf(hiddenSubject), hiddenSubject],
    );
    await create(hiddenAuthor, hiddenSubject, `Hidden target ${ordinal}`);
  }
  const hiddenPartition = partitionOf(routeOf(hiddenAuthor.accountId)!);
  const closed = await subjectGate(subjectId, 'hidden');
  await invalidate(closed, 'com.rezics.subject.revised.v1');
  const closedPage = await readReviewDiscoveryChanges(fixture.pool, partition, changePage.after);
  expect((await refreshReviewDiscoveryChanges(source, closedPage)).removed).toEqual([published.value.threadId]);
  const sparse = await source.page(hiddenPartition, null, 1);
  expect(sparse.reviews).toEqual([]);
  expect(sparse.next).not.toBeNull();
  const terminal = await source.page(hiddenPartition, sparse.next, 1);
  expect(terminal).toMatchObject({ reviews: [], next: null });
  const opened = await subjectGate(subjectId, 'visible');
  await invalidate(opened, 'com.rezics.subject.revised.v1');
  const publicPage = await readReviewDiscoveryChanges(fixture.pool, partition, closedPage.after);
  expect((await refreshReviewDiscoveryChanges(source, publicPage)).reviews[0]?.id).toBe(published.value.threadId);
  // Reordered originals and authorized native replay cannot put an old body back.
  await effect.run(admitted.event);
  await processReviewDiscoveryPage(fixture.pool, admitted.ref);
  expect((await readReviewDiscoveryChanges(fixture.pool, partition)).through).toBe(publicPage.through);
  expect((await readReviewDiscoveryProgress(fixture.pool, admitted.ref)).continuation).toBeNull();
  changePage = publicPage;

  const revised = await revisePost(
    { pool: fixture.pool, access: fixture.access, routeKey },
    author,
    {
      threadId: published.value.threadId,
      itemId: published.value.itemId,
      title: 'A revised review title',
      body: fromPlainText('Revised review excerpt.'),
    } as never,
    request(),
  );
  expect((await source.read(partition, [published.value.threadId])).reviews[0]?.excerpt).toBe(
    'Revised review excerpt.',
  );

  await invalidate(revised, 'com.rezics.content.revision.created.v1');
  const revisionPage = await readReviewDiscoveryChanges(fixture.pool, partition, changePage.after);
  const revisedReview = (await refreshReviewDiscoveryChanges(source, revisionPage)).reviews[0]!;
  expect(revisedReview).toMatchObject({
    title: 'A revised review title',
    excerpt: 'Revised review excerpt.',
  });
  expect(revisedReview.sourceVersion).not.toBe(first.reviews[0]!.sourceVersion);
  await fixture.grant(author.accountId, 'post:erase', {
    route: routeOf(published.value.itemId)!,
    id: published.value.itemId,
  });
  const deleted = await softDeletePost(
    { pool: fixture.pool, access: fixture.access, routeKey },
    author,
    { postId: published.value.itemId, reason: 'Withdraw' },
    request(),
  );
  const deletion = await invalidate(deleted, 'com.rezics.content.post.erased.v1');
  const withdrawn = await readReviewDiscoveryChanges(fixture.pool, partition, revisionPage.after);
  expect((await refreshReviewDiscoveryChanges(source, withdrawn)).removed).toEqual([published.value.threadId]);
  const restored = await restorePost(
    { pool: fixture.pool, access: fixture.access, routeKey },
    author,
    published.value.itemId,
    request(),
  );
  await invalidate(restored, 'com.rezics.content.post.restored.v1');
  const restoredPage = await readReviewDiscoveryChanges(fixture.pool, partition, withdrawn.after);
  const restoredReview = (await refreshReviewDiscoveryChanges(source, restoredPage)).reviews[0]!;
  expect(restoredReview.id).toBe(published.value.threadId);
  expect(restoredReview.revisionId).toBe(revisedReview.revisionId);
  expect(restoredReview.sourceVersion).not.toBe(revisedReview.sourceVersion);
  // The old withdrawal arrives after restoration; current hydration still wins.
  await effect.run(deletion.event);
  expect((await refreshReviewDiscoveryChanges(source, withdrawn)).removed).toEqual([]);
  expect((await source.read(partition, [published.value.threadId])).reviews[0]?.sourceVersion).toBe(
    restoredReview.sourceVersion,
  );
  const erased = await erasePost(
    { pool: fixture.pool, access: fixture.access, routeKey },
    author,
    { postId: published.value.itemId, reason: 'Author removed the review' },
    request(),
  );
  expect((await source.hydrate(partition, [published.value.threadId])).reviews).toEqual([]);
  await invalidate(erased, 'com.rezics.content.post.erased.v1');
  expect(
    (
      await refreshReviewDiscoveryChanges(
        source,
        await readReviewDiscoveryChanges(fixture.pool, partition, restoredPage.after),
      )
    ).removed,
  ).toEqual([published.value.threadId]);
  await expect(
    effect.run({ ...admitted.event, data: { ...(admitted.event.data as object), title: 'Forged' } }),
  ).rejects.toThrow();
});

test('coherent review pages restart when a hidden lower key becomes eligible or a dependency changes during hydration', async () => {
  const author = (await fixture.context()).actor;
  const board = (
    await fixture.reader.query("SELECT route,board_id FROM content.board WHERE realm_id IS NULL AND purpose='reviews'")
  ).rows[0]!;
  await fixture.grant(author.accountId, 'thread:create', { route: board.route, id: board.board_id });
  const deps = { pool: fixture.pool, access: fixture.access, routeKey };
  const create = (subject: string, title: string, route: number) =>
    createThread(
      deps,
      author,
      {
        kind: 'review',
        title,
        body: fromPlainText(title),
        licence: 'MIT',
        subjectIds: [subject],
        boardId: board.board_id,
        visibility: 'published',
      },
      requestAt(route),
    );
  const partition = 0x63a;
  const hiddenSubject = newId(0x6b40);
  const visibleSubject = newId(0x6b41);
  await fixture.reader.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
     VALUES ($1,$2,'schema:Book',$2,'hidden',1),($3,$4,'schema:Book',$4,'visible',1)`,
    [routeOf(hiddenSubject), hiddenSubject, routeOf(visibleSubject), visibleSubject],
  );
  const hidden = await create(hiddenSubject, 'Hidden lower review', partition * 16 + 1);
  const visible = await create(visibleSubject, 'Visible middle review', partition * 16 + 2);
  const later = await create(visibleSubject, 'Visible upper review', partition * 16 + 3);
  for (const outcome of [hidden, visible, later]) await invalidate(outcome, 'com.rezics.content.thread.created.v1');

  const source = createReviewDiscoverySource({ ...deps, tokens }, () => ({
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  }));
  const empty = await source.pageWithCut!(0xfff, null, 1);
  expect(empty).toMatchObject({ state: 'ready', reviews: [], next: null });
  const first = await source.pageWithCut!(partition, null, 1);
  expect(first).toMatchObject({ state: 'ready', reviews: [{ id: visible.value.threadId }] });
  if (first.state !== 'ready' || first.next === null) throw new Error('Expected a signed review continuation');

  const opened = await subjectGate(hiddenSubject, 'visible');
  await invalidate(opened, 'com.rezics.subject.revised.v1');
  const stale = await source.pageWithCut!(partition, first.next, 1);
  expect(stale).toMatchObject({ state: 'changed', missing: 'population-cut', reviews: [], next: null });
  const restarted = await source.pageWithCut!(partition, null, 1);
  expect(restarted).toMatchObject({ state: 'ready', reviews: [{ id: hidden.value.threadId }] });

  const probe = observeSql(fixture.pool);
  await source.pageWithCut!(partition, null, 1);
  const candidateStatement = probe.records.find(
    ({ statement }) =>
      statement.includes("WHERE t.kind = 'review'") &&
      statement.includes('ORDER BY t.route, t.thread_id LIMIT $5'),
  )!.statement;
  await probe.close();
  const raceObserver = observeSql(fixture.pool);
  const barrier = raceObserver.hold({ statement: candidateStatement }, 'after');
  const pendingPage = source.pageWithCut!(partition, null, 1);
  await barrier.entered;
  const closed = await subjectGate(hiddenSubject, 'hidden');
  barrier.release();
  const raced = await pendingPage;
  expect(raced).toMatchObject({ state: 'changed', missing: 'eligibility-dependency', reviews: [], next: null });
  await raceObserver.close();
  await invalidate(closed, 'com.rezics.subject.revised.v1');
});

test('durable cross-partition gate pages retain disappearance, fixed catch-up cuts and retryable dispatch', async () => {
  const subject = newId(0x6b36);
  await fixture.reader.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
    VALUES($1,$2,'schema:Book',$2,'visible',1)`,
    [routeOf(subject), subject],
  );
  // Retained identity keys model native rows removed before delayed gate work arrives.
  const ids = Array.from({ length: 103 }, (_, index) => newId(index < 101 ? 0x7310 : 0x7320));
  const unrelated = Array.from({ length: 205 }, () => newId(0x7310));
  await fixture.reader.query(
    `INSERT INTO content.review_discovery_dependency(route,thread_id,gate_kind,gate_key)
    SELECT route,id,'subject',gate FROM jsonb_to_recordset($1::jsonb) AS k(route integer,id uuid,gate uuid)`,
    [
      JSON.stringify([
        ...ids.map((id) => ({ route: routeOf(id), id, gate: subject })),
        ...unrelated.map((id) => ({ route: routeOf(id), id, gate: newId(0x6b37) })),
      ]),
    ],
  );
  const gate = await subjectGate(subject, 'hidden');
  const event = await original(gate, 'com.rezics.subject.revised.v1');
  await effect.run(event);
  const ref = { route: gate.partition * 16, id: event.id };
  const task = (
    await fixture.reader.query(
      'SELECT position::text,epoch FROM core.outbox WHERE partition_no=$1 AND type=$2 AND subject=$3',
      [gate.partition, REVIEW_DISCOVERY_OPENED, ref.id],
    )
  ).rows[0]!;
  const opened = await original(
    { partition: gate.partition, position: BigInt(task.position), epoch: task.epoch },
    REVIEW_DISCOVERY_OPENED,
  );
  const queued: ReviewDiscoveryWork[] = [];
  const dispatch = createReviewDiscoveryDispatchEffect(fixture.pool, async (key) => {
    queued.push(key);
  });
  await dispatch.run(opened);
  await dispatch.run(opened);
  expect(queued).toEqual([ref, ref]);
  const observer = observeSql(fixture.pool);
  const first = await processReviewDiscoveryPage(fixture.pool, ref);
  const advance = observer.records.find(({ statement }) =>
    statement.includes('UPDATE content.review_discovery_work SET scope_no'),
  )!.statement;
  expect(first).toMatchObject({ complete: false, examined: 100, delivered: 100 });
  expect((await readReviewDiscoveryProgress(fixture.pool, ref)).continuation).not.toBeNull();
  const partition = partitionOf(routeOf(ids[0]!)!);
  const cut = await readReviewDiscoveryChanges(fixture.pool, partition, 0n, 7);
  expect(cut.through).toBe(100n);
  expect(cut.next).not.toBeNull();
  observer.armFault({ match: { statement: advance }, boundary: 'before', error: new Error('lost source cursor') });
  await expect(processReviewDiscoveryPage(fixture.pool, ref)).rejects.toThrow('lost source cursor');
  expect(await processReviewDiscoveryPage(fixture.pool, ref)).toMatchObject({
    complete: true,
    examined: 3,
    delivered: 0,
  });
  await observer.close();
  let page = cut;
  const caught: string[] = [];
  for (;;) {
    caught.push(...page.changes.map((change) => change.id));
    if (page.next === null) break;
    page = await readReviewDiscoveryChanges(fixture.pool, partition, page.next, 7, cut.through);
  }
  expect(caught).toHaveLength(100);
  expect(page.after).toBe(cut.through);
  const source = createReviewDiscoverySource({ pool: fixture.pool, access: fixture.access, tokens }, () => ({
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  }));
  const late = await readReviewDiscoveryChanges(fixture.pool, partition, cut.through);
  expect(late.changes).toHaveLength(1);
  expect((await refreshReviewDiscoveryChanges(source, late)).removed).toEqual(late.changes.map((change) => change.id));
  const current = late.through;
  await effect.run(event);
  expect(await processReviewDiscoveryPage(fixture.pool, ref)).toMatchObject({
    complete: true,
    examined: 0,
    delivered: 0,
  });
  expect((await readReviewDiscoveryChanges(fixture.pool, partition, current)).after).toBe(current);
});

test('opening publication and native takedown refresh the discovered review identity', async () => {
  const author = (await fixture.context()).actor;
  const subject = newId(0x6b38);
  await fixture.reader.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
    VALUES($1,$2,'schema:Book',$2,'visible',1)`,
    [routeOf(subject), subject],
  );
  const board = (
    await fixture.reader.query("SELECT route,board_id FROM content.board WHERE realm_id IS NULL AND purpose='reviews'")
  ).rows[0]!;
  await fixture.grant(author.accountId, 'thread:create', { route: board.route, id: board.board_id });
  const deps = { pool: fixture.pool, access: fixture.access, routeKey };
  const draft = await createThread(
    deps,
    author,
    {
      kind: 'review',
      title: 'Draft',
      body: fromPlainText('Draft body'),
      licence: 'MIT',
      subjectIds: [subject],
      boardId: board.board_id,
      visibility: 'draft',
    },
    request(),
  );
  const partition = draft.partition;
  const source = createReviewDiscoverySource({ ...deps, tokens }, () => ({
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  }));
  await invalidate(draft, 'com.rezics.content.thread.created.v1');
  const before = await readReviewDiscoveryChanges(fixture.pool, partition);
  expect(
    (await refreshReviewDiscoveryChanges(source, before)).reviews.some((review) => review.id === draft.value.threadId),
  ).toBe(false);
  const published = await revisePost(
    deps,
    author,
    {
      threadId: draft.value.threadId,
      itemId: draft.value.itemId,
      title: 'Published title',
      body: fromPlainText('Published body'),
      visibility: 'published',
    },
    request(),
  );
  await invalidate(published, 'com.rezics.content.post.published.v1');
  const current = await readReviewDiscoveryChanges(fixture.pool, partition, before.after);
  expect((await refreshReviewDiscoveryChanges(source, current)).reviews).toMatchObject([
    { id: draft.value.threadId, title: 'Published title', excerpt: 'Published body' },
  ]);
  await fixture.grant(author.accountId, 'moderation:takedown', {
    route: routeOf(draft.value.itemId)!,
    id: draft.value.itemId,
  });
  const taken = await takedown(
    deps,
    author,
    { target: { kind: 'post', id: draft.value.itemId }, reason: 'Native takedown' },
    request(),
  );
  await invalidate(taken, 'com.rezics.content.moderation.takedown.v1');
  const removed = await readReviewDiscoveryChanges(fixture.pool, partition, current.after);
  expect((await refreshReviewDiscoveryChanges(source, removed)).removed).toEqual([draft.value.threadId]);
});
