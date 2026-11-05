import { afterAll, beforeEach, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createPost, createThread, revisePost } from '../../src/content/commands.ts';
import { createBoardEffect, readBoardCandidates } from '../../src/content/board-projection.ts';
import { createSubjectThreadEffect } from '../../src/content/subject-thread-index.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { standingFixture } from '../access/standing-fixture.ts';

const fixture = await standingFixture();
afterAll(() => fixture.close());
const routeKey = new Uint8Array(32).fill(73);
const context = () => ({
  idempotencyKey: Bun.randomUUIDv7(),
  deadline: Date.now() + 30_000,
  requestId: Bun.randomUUIDv7(),
});

beforeEach(() => fixture.reset());

test('review threads, posts, revisions and vote citations share the author partition across board projections', async () => {
  const { actor } = await fixture.context();
  const authorRoute = routeOf(actor.accountId)!;
  const board = (
    await fixture.reader.query<{ route: number; board_id: string }>(
      "SELECT route, board_id FROM content.board WHERE realm_id IS NULL AND purpose = 'reviews'",
    )
  ).rows[0]!;
  expect(partitionOf(board.route)).not.toBe(partitionOf(authorRoute));
  await fixture.grant(actor.accountId, 'thread:create', { route: board.route, id: board.board_id });
  const subjectId = newId(0x6b30);
  const citation = { questionId: STANDARD_QUESTION_ID, units: 14, revision: 3 };
  await fixture.reader.query(
    `INSERT INTO rating.vote(route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
     VALUES ($1, $2, $3, $4, 14, 3, now(), $5)`,
    [authorRoute, actor.accountId, STANDARD_QUESTION_ID, subjectId, newId(authorRoute)],
  );
  const dependencies = { pool: fixture.pool, access: fixture.access, routeKey };
  const created = await createThread(
    dependencies,
    actor,
    {
      kind: 'review',
      title: 'A routed review',
      body: fromPlainText('Opening review'),
      licence: 'MIT',
      subjectIds: [subjectId],
      boardId: board.board_id,
      visibility: 'published',
      voteCitation: citation,
    },
    context(),
  );
  expect(created.partition).toBe(partitionOf(authorRoute));
  const reply = await createPost(
    dependencies,
    actor,
    { threadId: created.value.threadId, body: fromPlainText('Reply'), licence: 'MIT' },
    context(),
  );
  const revised = await revisePost(
    dependencies,
    actor,
    {
      threadId: created.value.threadId,
      itemId: created.value.itemId,
      body: fromPlainText('Revised review'),
      voteCitation: citation,
    },
    context(),
  );
  const rows = await fixture.reader.query<{ kind: string; route: number }>(
    `SELECT 'thread' AS kind, route FROM content.thread WHERE thread_id = $1
     UNION ALL SELECT 'post', route FROM content.post WHERE thread_id = $1
     UNION ALL SELECT 'revision', route FROM content.revision WHERE thread_id = $1`,
    [created.value.threadId],
  );
  expect(rows.rows.filter(({ kind }) => kind === 'thread')).toHaveLength(1);
  expect(rows.rows.filter(({ kind }) => kind === 'post')).toHaveLength(2);
  expect(rows.rows.filter(({ kind }) => kind === 'revision')).toHaveLength(3);
  expect(rows.rows.every(({ route }) => route === authorRoute)).toBe(true);
  for (const command of [created, reply, revised]) {
    expect(command.partition).toBe(partitionOf(authorRoute));
    for (const id of Object.values(command.value)) expect(routeOf(id)).toBe(authorRoute);
  }
  const citations = await fixture.reader.query<{ vote_citation: unknown }>(
    'SELECT vote_citation FROM content.revision WHERE route = $1 AND revision_id = ANY($2::uuid[])',
    [authorRoute, [created.value.revisionId, revised.value.revisionId]],
  );
  expect(citations.rows).toEqual([{ vote_citation: citation }, { vote_citation: citation }]);

  const at = new Date().toISOString();
  const event: CloudEvent = {
    specversion: '1.0',
    id: Bun.randomUUIDv7(),
    source: `urn:rezics:log:${created.partition}.${created.epoch}`,
    type: 'com.rezics.content.thread.created.v1',
    subject: created.value.threadId,
    time: at,
    datacontenttype: 'application/json',
    sequence: created.position.toString().padStart(19, '0'),
    data: {
      ...created.value,
      actorId: actor.accountId,
      placeId: GLOBAL_CONTEXT,
      kind: 'review',
      subjectIds: [subjectId],
      activityAt: at,
    },
  };
  await createBoardEffect(fixture.pool).run(event);
  expect((await readBoardCandidates(fixture.pool, board.board_id, null, 10)).candidates.map(({ id }) => id)).toEqual([
    created.value.threadId,
  ]);
  await createSubjectThreadEffect(fixture.pool).run(event);
  const indexed = await fixture.reader.query(
    'SELECT thread_route, kind FROM content.subject_thread WHERE thread_id = $1',
    [created.value.threadId],
  );
  expect(indexed.rows).toEqual([{ thread_route: authorRoute, kind: 'review' }]);
});

for (const boardExists of [false, true]) {
  test(`discussion thread insert and update need no board in the thread partition (board exists: ${boardExists})`, async () => {
    const route = 0x5432;
    const boardRoute = 0x6789;
    expect(partitionOf(route)).not.toBe(partitionOf(boardRoute));
    const boardId = newId(boardRoute);
    if (boardExists) {
      await fixture.reader.query(
        `INSERT INTO content.board
           (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
         VALUES ($1, $2, $3, 'Other partition', 'published', 1, $4)`,
        [boardRoute, boardId, newId(boardRoute), newId(boardRoute)],
      );
    }
    const threadId = newId(route);
    await fixture.reader.query(
      `INSERT INTO content.thread
         (route, thread_id, author_account_id, board_id, title, visibility,
          security_revision, recorded_transaction_id)
       VALUES ($1, $2, $3, $4, 'Direct thread', 'published', 1, $5)`,
      [route, threadId, newId(route), boardId, newId(route)],
    );
    const updated = await fixture.reader.query(
      "UPDATE content.thread SET title = 'Updated directly' WHERE route = $1 AND thread_id = $2 RETURNING title",
      [route, threadId],
    );
    expect(updated.rows).toEqual([{ title: 'Updated directly' }]);
  });
}

test('review placement follows the author route and a removed review never becomes live again', async () => {
  const route = 0x5432;
  const authorId = newId(route);
  const boardId = newId(0x6789);
  const insert = (threadRoute: number, live = true) =>
    fixture.reader.query(
      `INSERT INTO content.thread
         (route, thread_id, author_account_id, board_id, title, visibility, security_revision,
          recorded_transaction_id, kind, review_subject_id, review_live)
       VALUES ($1, $2, $3, $4, 'Direct review', 'published', 1, $5, 'review', $6, $7)
       RETURNING thread_id`,
      [threadRoute, newId(threadRoute), authorId, boardId, newId(threadRoute), newId(route), live],
    );
  await expect(insert(routeOf(boardId)!)).rejects.toMatchObject({
    code: '23514',
    constraint: 'thread_review_route_check',
  });
  const removed = (await insert(route, false)).rows[0]!;
  await expect(
    fixture.reader.query('UPDATE content.thread SET review_live = true WHERE route = $1 AND thread_id = $2', [
      route,
      removed.thread_id,
    ]),
  ).rejects.toMatchObject({ code: '23514', message: 'A removed review cannot become live again' });
});
