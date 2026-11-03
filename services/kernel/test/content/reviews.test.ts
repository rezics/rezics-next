import { afterAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { erasePost, takedown } from '../../src/content/moderation.ts';
import { createThread, revisePost } from '../../src/content/commands.ts';
import { createSubjectThreadEffect } from '../../src/content/subject-thread-index.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { standingFixture } from '../access/standing-fixture.ts';

const fixture = await standingFixture();
afterAll(() => fixture.close());

const context = (idempotencyKey = Bun.randomUUIDv7()) => ({
  idempotencyKey,
  deadline: Date.now() + 30_000,
  requestId: Bun.randomUUIDv7(),
});
const routeKey = new Uint8Array(32).fill(73);

type Board = { route: number; id: string };
type ReviewVoteCitation = { questionId: string; units: number; revision: number };
let author: Awaited<ReturnType<typeof fixture.context>>['actor'];
let reviewsBoard: Board;
let discussionBoard: Board;
let subjectId: string;

async function globalReviewsBoard(): Promise<Board> {
  const result = await fixture.reader.query<{ route: number; board_id: string }>(
    `SELECT route, board_id FROM content.board
     WHERE realm_id IS NULL AND purpose = 'reviews'`,
  );
  expect(result.rows).toHaveLength(1);
  return { route: result.rows[0]!.route, id: result.rows[0]!.board_id };
}

async function prepareBoard(purpose: 'discussion' | 'reviews' = 'discussion'): Promise<Board> {
  const id = newId(0x6b10);
  const conceptId = newId(0x6b20);
  await fixture.reader.query(
    `INSERT INTO content.board
      (route, board_id, realm_id, subject_id, title, visibility, security_revision,
       recorded_transaction_id, purpose)
     VALUES ($1, $2, NULL, $3, 'Review fixture', 'published', 1, $4, $5)`,
    [routeOf(id), id, conceptId, newId(routeOf(id)!), purpose],
  );
  return { route: routeOf(id)!, id };
}

async function grantThreadCreate(board: Board): Promise<void> {
  await fixture.grant(author.accountId, 'thread:create', { route: board.route, id: board.id });
}

function reviewInput(board: Board, subject: string, extras: Record<string, unknown> = {}) {
  return {
    kind: 'review',
    title: 'A short review',
    body: fromPlainText('A review body.'),
    licence: 'MIT',
    subjectIds: [subject],
    boardId: board.id,
    visibility: 'published' as const,
    ...extras,
  } as any;
}

async function createReview(board = reviewsBoard, subject = subjectId, extras: Record<string, unknown> = {}) {
  return createThread(
    { pool: fixture.pool, access: fixture.access, routeKey },
    author,
    reviewInput(board, subject, extras),
    context(),
  );
}

async function applyReviewIndex(result: Awaited<ReturnType<typeof createThread>>, subject: string): Promise<void> {
  const at = new Date().toISOString();
  const source = {
    specversion: '1.0',
    id: randomUUID(),
    source: `urn:rezics:log:${result.partition}.${result.epoch}`,
    type: 'com.rezics.content.thread.created.v1',
    subject: result.value.threadId,
    time: at,
    datacontenttype: 'application/json',
    sequence: result.position.toString().padStart(19, '0'),
    data: {
      ...result.value,
      actorId: author.accountId,
      placeId: GLOBAL_CONTEXT,
      kind: 'review',
      subjectIds: [subject],
      activityAt: at,
    },
  } as CloudEvent;
  await createSubjectThreadEffect(fixture.pool).run(source);
}

async function reviewCitation(revisionId: string) {
  return (
    await fixture.reader.query<{ vote_citation: ReviewVoteCitation | null }>(
      'SELECT vote_citation FROM content.revision WHERE route = $1 AND revision_id = $2',
      [routeOf(revisionId), revisionId],
    )
  ).rows[0]?.vote_citation;
}

beforeEach(async () => {
  await fixture.reset();
  author = (await fixture.context()).actor;
  reviewsBoard = await globalReviewsBoard();
  discussionBoard = await prepareBoard();
  subjectId = newId(0x6b30);
  await grantThreadCreate(reviewsBoard);
  await grantThreadCreate(discussionBoard);
});

test('a review is a one-subject thread on the reviews board and indexes as a review', async () => {
  const created = await createReview();
  const stored = await fixture.reader.query<{ kind: string; board_id: string; review_subject_id: string }>(
    'SELECT kind, board_id, review_subject_id FROM content.thread WHERE route=$1 AND thread_id=$2',
    [routeOf(created.value.threadId), created.value.threadId],
  );
  expect(stored.rows).toEqual([{ kind: 'review', board_id: reviewsBoard.id, review_subject_id: subjectId }]);
  const revision = await fixture.reader.query<{ subject_ids: string[] }>(
    'SELECT subject_ids FROM content.revision WHERE route=$1 AND revision_id=$2',
    [routeOf(created.value.revisionId), created.value.revisionId],
  );
  expect(revision.rows[0]?.subject_ids).toEqual([subjectId]);

  await applyReviewIndex(created, subjectId);
  const indexed = await fixture.reader.query<{ subject_id: string; place_id: string; kind: string }>(
    'SELECT subject_id, place_id, kind FROM content.subject_thread WHERE thread_id=$1',
    [created.value.threadId],
  );
  expect(indexed.rows).toEqual([{ subject_id: subjectId, place_id: GLOBAL_CONTEXT, kind: 'review' }]);

  await expect(createReview(reviewsBoard, newId(0x6b31), { subjectIds: [subjectId, newId(0x6b32)] })).rejects.toThrow();
  await expect(
    createThread(
      { pool: fixture.pool, access: fixture.access, routeKey },
      author,
      { ...reviewInput(reviewsBoard, subjectId), kind: 'discussion' } as never,
      context(),
    ),
  ).rejects.toThrow();
  await expect(
    createThread(
      { pool: fixture.pool, access: fixture.access, routeKey },
      author,
      { ...reviewInput(discussionBoard, subjectId), kind: 'review' } as never,
      context(),
    ),
  ).rejects.toThrow();
});

test('one live review per author, subject and board is released by erasure and takedown', async () => {
  const first = await createReview();
  await expect(createReview()).rejects.toThrow();

  await fixture.grant(author.accountId, 'post:erase', { route: routeOf(first.value.itemId)!, id: first.value.itemId });
  await erasePost(
    { pool: fixture.pool, access: fixture.access, routeKey },
    author,
    { postId: first.value.itemId, reason: 'Author removed the review' },
    context(),
  );
  const second = await createReview();

  await fixture.grant(author.accountId, 'moderation:takedown', {
    route: routeOf(second.value.threadId)!,
    id: second.value.threadId,
  });
  await takedown(
    { pool: fixture.pool, access: fixture.access, routeKey },
    author,
    { target: { kind: 'thread', id: second.value.threadId }, reason: 'Removed after review' },
    context(),
  );
  await expect(createReview()).resolves.toHaveProperty('value.threadId');
});

test('a review stores only the author’s cited vote revision and preserves prior citations', async () => {
  const voterRoute = routeOf(author.accountId)!;
  await fixture.reader.query(
    `INSERT INTO rating.vote(route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
     VALUES ($1, $2, $3, $4, 14, 3, now(), $5)`,
    [voterRoute, author.accountId, STANDARD_QUESTION_ID, subjectId, newId(voterRoute)],
  );
  const firstCitation = { questionId: STANDARD_QUESTION_ID, units: 14, revision: 3 };
  const created = await createReview(reviewsBoard, subjectId, { voteCitation: firstCitation });
  expect(await reviewCitation(created.value.revisionId)).toEqual(firstCitation);

  await fixture.reader.query(
    `UPDATE rating.vote SET units=18, revision=4, changed_at=now(), transaction_id=$4
     WHERE route=$1 AND voter_id=$2 AND question_id=$3 AND target_id=$5`,
    [voterRoute, author.accountId, STANDARD_QUESTION_ID, newId(voterRoute), subjectId],
  );
  expect(await reviewCitation(created.value.revisionId)).toEqual(firstCitation);

  const nextCitation = { questionId: STANDARD_QUESTION_ID, units: 18, revision: 4 };
  const revised = await revisePost(
    { pool: fixture.pool, access: fixture.access, routeKey },
    author,
    {
      threadId: created.value.threadId,
      itemId: created.value.itemId,
      body: fromPlainText('A revised review body.'),
      voteCitation: nextCitation,
    } as never,
    context(),
  );
  expect(await reviewCitation(created.value.revisionId)).toEqual(firstCitation);
  expect(await reviewCitation(revised.value.revisionId)).toEqual(nextCitation);

  await expect(
    createReview(reviewsBoard, subjectId, { voteCitation: { ...nextCitation, units: 14 } }),
  ).rejects.toThrow();
});

test('a review accepts only citations on the exact bounded custom question scale', async () => {
  const voterRoute = routeOf(author.accountId)!;
  const realmId = newId(0x6b40);
  const questionId = newId(0x6b40);
  await fixture.reader.query(
    `INSERT INTO rating.question
      (id, owner_id, revision, label, grain, minimum_units, maximum_units, step_units, realm_id, meaning)
     VALUES ($1, $2, 1, 'Bounded citation question', 'work', 10, 4096, 6, $3, 'Fixture question metadata')`,
    [questionId, author.accountId, realmId],
  );
  await fixture.reader.query(
    `INSERT INTO rating.vote(route, voter_id, question_id, target_id, units, revision, changed_at, transaction_id)
     VALUES ($1, $2, $3, $4, 4096, 1, now(), $5)`,
    [voterRoute, author.accountId, questionId, subjectId, newId(voterRoute)],
  );
  const citation = { questionId, units: 4096, revision: 1 };
  const created = await createReview(reviewsBoard, subjectId, { voteCitation: citation });
  expect(await reviewCitation(created.value.revisionId)).toEqual(citation);

  await fixture.reader.query(
    `UPDATE rating.vote SET units=4095, revision=2, changed_at=now(), transaction_id=$4
     WHERE route=$1 AND voter_id=$2 AND question_id=$3 AND target_id=$5`,
    [voterRoute, author.accountId, questionId, newId(voterRoute), subjectId],
  );
  await expect(
    createReview(reviewsBoard, subjectId, { voteCitation: { questionId, units: 4095, revision: 2 } }),
  ).rejects.toThrow('Vote citation is outside its question scale');
});

test('a Realm can designate only one reviews board', async () => {
  const client = await fixture.reader.connect();
  const realmId = newId(0x6b40);
  const route = routeOf(realmId)!;
  const insertBoard = (boardId: string, conceptId: string) =>
    client.query(
      `INSERT INTO content.board
        (route, board_id, realm_id, subject_id, title, visibility, security_revision,
         recorded_transaction_id, purpose)
       VALUES ($1, $2, $3, $4, 'Realm reviews', 'published', 1, $5, 'reviews')`,
      [route, boardId, realmId, conceptId, newId(route)],
    );
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await insertBoard(newId(route), newId(0x6b50));
    const duplicate = await insertBoard(newId(route), newId(0x6b51)).catch((error: unknown) => error);
    expect(duplicate).toMatchObject({ code: '23505' });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});
