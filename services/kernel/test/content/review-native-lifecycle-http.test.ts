import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import accountRead from '../../src/access/account-read.sql';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { observeSql } from './support/sql-observer.ts';
import {
  createReviewLifecycleFixture,
  requestKey,
  type ReviewLifecycleFixture,
  type ReviewLifecyclePerson,
  type ReviewLifecycleResponse,
} from './review-native-lifecycle-fixture.ts';

type ReviewResult = Readonly<{
  threadId: string;
  postId: string;
  revisionId: string;
}>;
type Citation = Readonly<{ questionId: string; units: number; revision: number }>;

let fixture: ReviewLifecycleFixture | undefined;

afterAll(async () => {
  await fixture?.close();
});

function expectStatus(result: ReviewLifecycleResponse, status: number): void {
  expect(result.response.status, result.text).toBe(status);
}

function createReviewBody(subjectId: string, boardId: string, title: string, citation?: Citation) {
  return {
    kind: 'review',
    title,
    body: fromPlainText(`${title} review body.`),
    licence: 'CC-BY-4.0',
    boardId,
    subjectIds: [subjectId],
    visibility: 'published',
    ...(citation === undefined ? {} : { voteCitation: citation }),
  };
}

async function createReview(
  f: ReviewLifecycleFixture,
  person: ReviewLifecyclePerson,
  subjectId: string,
  title: string,
  citation?: Citation,
): Promise<ReviewResult> {
  const result = await f.call('POST', '/v1/threads', {
    bearer: person.bearer,
    key: requestKey('review-create'),
    body: createReviewBody(subjectId, f.boardId, title, citation),
  });
  expectStatus(result, 201);
  const thread = result.value.thread;
  expect(thread).toBeDefined();
  expect(thread.kind).toBe('review');
  expect(thread.authorId).toBe(person.accountId);
  expect(thread.boardId).toBe(f.boardId);
  expect(thread.subjectIds).toEqual([subjectId]);
  expect(thread.route).toBe(routeOf(person.accountId));
  expect(thread.firstPost?.authorId).toBe(person.accountId);
  return {
    threadId: thread.id as string,
    postId: thread.firstPost.id as string,
    revisionId: thread.firstPost.revisionId as string,
  };
}

async function snapshot(f: ReviewLifecycleFixture, person: ReviewLifecyclePerson, subjectId: string) {
  const route = routeOf(person.accountId)!;
  const partition = partitionOf(route);
  const [position, receipts, outbox, heads, revisions, slots] = await Promise.all([
    f.admin.query('SELECT epoch, position::text FROM core.partition WHERE partition_no = $1', [partition]),
    f.admin.query(
      'SELECT principal_id, command_kind, idempotency_key, request_digest, epoch, position::text, transaction_id, response FROM core.receipt WHERE partition_no = $1 AND principal_id = $2 ORDER BY position, idempotency_key',
      [partition, person.accountId],
    ),
    f.admin.query(
      'SELECT position::text, event_seq, event_count, epoch, type, subject, data FROM core.outbox WHERE partition_no = $1 ORDER BY position, event_seq',
      [partition],
    ),
    f.admin.query(
      `SELECT p.thread_id, p.post_id, p.head_revision_id, p.availability
       FROM content.post p JOIN content.thread t USING (route, thread_id)
       WHERE p.route = $1 AND t.author_account_id = $2 AND t.board_id = $3 AND t.review_subject_id = $4
       ORDER BY p.thread_id`,
      [route, person.accountId, f.boardId, subjectId],
    ),
    f.admin.query(
      `SELECT r.thread_id, r.post_id, r.revision_id, r.body_sha256, r.licence, r.subject_ids, r.board_id, r.vote_citation
       FROM content.revision r JOIN content.thread t USING (route, thread_id)
       WHERE r.route = $1 AND t.author_account_id = $2 AND t.board_id = $3 AND t.review_subject_id = $4
       ORDER BY r.thread_id, r.revision_id`,
      [route, person.accountId, f.boardId, subjectId],
    ),
    f.admin.query(
      `SELECT thread_id, review_live, availability, visibility
       FROM content.thread
       WHERE route = $1 AND author_account_id = $2 AND board_id = $3 AND review_subject_id = $4
       ORDER BY thread_id`,
      [route, person.accountId, f.boardId, subjectId],
    ),
  ]);
  return {
    position: position.rows,
    receipts: receipts.rows,
    outbox: outbox.rows,
    heads: heads.rows,
    revisions: revisions.rows,
    slots: slots.rows,
  };
}

async function storedRevision(f: ReviewLifecycleFixture, revisionId: string) {
  const route = routeOf(revisionId)!;
  const result = await f.admin.query(
    `SELECT body, body_sha256, licence, subject_ids, board_id, vote_citation
     FROM content.revision WHERE route = $1 AND revision_id = $2`,
    [route, revisionId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0] as {
    body: Buffer;
    body_sha256: Buffer;
    licence: string;
    subject_ids: string[];
    board_id: string;
    vote_citation: Citation | null;
  };
}

async function vote(f: ReviewLifecycleFixture, person: ReviewLifecyclePerson, subjectId: string, units: number) {
  const result = await f.call('PUT', `/v1/subjects/${subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
    bearer: person.bearer,
    key: requestKey('vote'),
    body: { units },
  });
  expectStatus(result, 200);
  return {
    questionId: STANDARD_QUESTION_ID,
    units: result.value.units as number,
    revision: result.value.revision as number,
  };
}

test('Ratings and reviews: native vote citations remain immutable through review slot replacement and owner restoration.', async () => {
  fixture = await createReviewLifecycleFixture();
  const f = fixture;
  expect(f.author.accountId).not.toBe(f.other.accountId);
  expect(f.author.bearer).not.toBe(f.other.bearer);
  const originalSubject = f.subjectId;
  const authorRoute = routeOf(f.author.accountId)!;

  const originalVote = await vote(f, f.author, originalSubject, 7);
  const unrelatedVote = await vote(f, f.other, originalSubject, 19);
  expect(unrelatedVote).toMatchObject({ questionId: STANDARD_QUESTION_ID, units: 19, revision: 1 });
  const otherReadOfAuthorVote = await f.call(
    'GET',
    `/v1/subjects/${originalSubject}/ratings/${STANDARD_QUESTION_ID}/vote`,
    { bearer: f.other.bearer },
  );
  expectStatus(otherReadOfAuthorVote, 404);

  const beforeInvalidCitation = await snapshot(f, f.author, originalSubject);
  const unrelatedCitation = await f.call('POST', '/v1/threads', {
    bearer: f.author.bearer,
    key: requestKey('unrelated-vote-citation'),
    body: createReviewBody(originalSubject, f.boardId, 'Unrelated vote citation', unrelatedVote),
  });
  expectStatus(unrelatedCitation, 400);
  expect(await snapshot(f, f.author, originalSubject)).toEqual(beforeInvalidCitation);

  const original = await createReview(f, f.author, originalSubject, 'Original cited review', originalVote);
  const originalCanonical = fromPlainText('Original cited review review body.');
  const originalBytes = Buffer.from(serializeDocument(originalCanonical));
  const originalDigest = createHash('sha256').update(originalBytes).digest();
  const originalStored = await storedRevision(f, original.revisionId);
  expect(originalStored.body).toEqual(originalBytes);
  expect(originalStored.body_sha256).toEqual(originalDigest);
  expect(originalStored).toMatchObject({
    licence: 'CC-BY-4.0',
    subject_ids: [originalSubject],
    board_id: f.boardId,
    vote_citation: originalVote,
  });
  const publicOriginal = await f.call('GET', `/v1/threads/${original.threadId}`);
  expectStatus(publicOriginal, 200);
  expect(publicOriginal.value.thread).toMatchObject({
    id: original.threadId,
    route: authorRoute,
    authorId: f.author.accountId,
    kind: 'review',
    boardId: f.boardId,
    subjectIds: [originalSubject],
    firstPost: { id: original.postId, revisionId: original.revisionId, voteCitation: originalVote },
  });

  const changedVote = await vote(f, f.author, originalSubject, 12);
  expect(changedVote).toEqual({ questionId: STANDARD_QUESTION_ID, units: 12, revision: 2 });
  const oldExactBeforeRevision = await f.call('GET', `/v1/posts/${original.postId}/revisions/${original.revisionId}`, {
    bearer: f.author.bearer,
  });
  expectStatus(oldExactBeforeRevision, 200);
  expect(oldExactBeforeRevision.value.post.voteCitation).toEqual(originalVote);

  const revisedBody = fromPlainText('A later revision cites the changed vote.');
  const reviseKey = requestKey('review-revise');
  const revised = await f.call('POST', `/v1/posts/${original.postId}/revisions`, {
    bearer: f.author.bearer,
    key: reviseKey,
    ifMatch: original.revisionId,
    body: {
      body: revisedBody,
      licence: 'CC-BY-4.0',
      subjectIds: [originalSubject],
      boardId: f.boardId,
      voteCitation: changedVote,
    },
  });
  expectStatus(revised, 200);
  const revisedRevisionId = revised.value.post.revisionId as string;
  expect(revised.value.post.voteCitation).toEqual(changedVote);
  const oldExactAfterRevision = await f.call('GET', `/v1/posts/${original.postId}/revisions/${original.revisionId}`, {
    bearer: f.author.bearer,
  });
  const newExact = await f.call('GET', `/v1/posts/${original.postId}/revisions/${revisedRevisionId}`, {
    bearer: f.author.bearer,
  });
  expectStatus(oldExactAfterRevision, 200);
  expectStatus(newExact, 200);
  expect(oldExactAfterRevision.value.post.voteCitation).toEqual(originalVote);
  expect(newExact.value.post.voteCitation).toEqual(changedVote);
  expect(await storedRevision(f, original.revisionId)).toEqual(originalStored);
  const revisedBytes = Buffer.from(serializeDocument(revisedBody));
  const revisedStored = await storedRevision(f, revisedRevisionId);
  expect(revisedStored.body).toEqual(revisedBytes);
  expect(revisedStored.body_sha256).toEqual(createHash('sha256').update(revisedBytes).digest());
  expect(revisedStored).toMatchObject({
    licence: 'CC-BY-4.0',
    subject_ids: [originalSubject],
    board_id: f.boardId,
    vote_citation: changedVote,
  });

  const originalDeleteKey = requestKey('original-delete');
  expectStatus(
    await f.call('DELETE', `/v1/posts/${original.postId}`, {
      bearer: f.author.bearer,
      key: originalDeleteKey,
    }),
    204,
  );
  const deletedThread = await f.call('GET', `/v1/threads/${original.threadId}`);
  expectStatus(deletedThread, 200);
  expect(deletedThread.value.thread.title).toBeNull();
  expect(deletedThread.value.thread.firstPost).toMatchObject({
    id: original.postId,
    removed: true,
    availability: 'erased',
    body: null,
    sha256: null,
  });
  expect(JSON.stringify(deletedThread.value)).not.toContain('Original cited review review body.');
  expectStatus(await f.call('GET', `/v1/posts/${original.postId}/revisions/${original.revisionId}`), 404);
  expectStatus(await f.call('GET', `/v1/boards/${f.boardId}`), 200);

  const replacement = await createReview(f, f.author, originalSubject, 'Replacement cited review', changedVote);
  const beforeConflictRestore = await snapshot(f, f.author, originalSubject);
  const conflictRestore = await f.call('POST', `/v1/posts/${original.postId}:restore`, {
    bearer: f.author.bearer,
    key: requestKey('conflicting-restore'),
  });
  expectStatus(conflictRestore, 409);
  expect(conflictRestore.value.code).toBe('conflict');
  expect(await snapshot(f, f.author, originalSubject)).toEqual(beforeConflictRestore);
  expect(await storedRevision(f, original.revisionId)).toEqual(originalStored);

  const replacementDeleteKey = requestKey('replacement-delete');
  expectStatus(
    await f.call('DELETE', `/v1/posts/${replacement.postId}`, {
      bearer: f.author.bearer,
      key: replacementDeleteKey,
    }),
    204,
  );
  expectStatus(
    await f.call('POST', `/v1/posts/${original.postId}:restore`, {
      bearer: f.author.bearer,
      key: requestKey('original-restore'),
    }),
    204,
  );
  const restoredThread = await f.call('GET', `/v1/threads/${original.threadId}`);
  expectStatus(restoredThread, 200);
  expect(restoredThread.value.thread.firstPost).toMatchObject({
    id: original.postId,
    revisionId: revisedRevisionId,
    voteCitation: changedVote,
    availability: 'available',
  });
  expect(
    (await f.call('GET', `/v1/posts/${original.postId}/revisions/${original.revisionId}`, { bearer: f.author.bearer }))
      .value.post.voteCitation,
  ).toEqual(originalVote);
  expect(
    (await f.call('GET', `/v1/posts/${original.postId}/revisions/${revisedRevisionId}`, { bearer: f.author.bearer }))
      .value.post.voteCitation,
  ).toEqual(changedVote);
  expect(await storedRevision(f, original.revisionId)).toEqual(originalStored);
  expect(await storedRevision(f, revisedRevisionId)).toEqual(revisedStored);
  expect(restoredThread.value.thread.title).toBe('Original cited review');
  const liveSlot = await f.admin.query(
    `SELECT thread_id FROM content.thread
     WHERE route = $1 AND author_account_id = $2 AND board_id = $3 AND review_subject_id = $4
       AND kind = 'review' AND review_live AND availability = 'available' AND visibility <> 'taken_down'`,
    [authorRoute, f.author.accountId, f.boardId, originalSubject],
  );
  expect(liveSlot.rows).toEqual([{ thread_id: original.threadId }]);

  const controlSubject = await f.subject('Unrelated restore control subject');
  const controlReview = await createReview(f, f.other, controlSubject, 'Other author restore control');
  const controlDeleteKey = requestKey('other-control-delete');
  expectStatus(
    await f.call('DELETE', `/v1/posts/${controlReview.postId}`, {
      bearer: f.other.bearer,
      key: controlDeleteKey,
    }),
    204,
  );
  const controlAfterDelete = await snapshot(f, f.other, controlSubject);
  const controlReplay = await f.call('DELETE', `/v1/posts/${controlReview.postId}`, {
    bearer: f.other.bearer,
    key: controlDeleteKey,
  });
  expectStatus(controlReplay, 204);
  expect(await snapshot(f, f.other, controlSubject)).toEqual(controlAfterDelete);
  const controlRestoreKey = requestKey('other-control-restore');
  const beforeControlRestore = await snapshot(f, f.other, controlSubject);
  expectStatus(
    await f.call('POST', `/v1/posts/${controlReview.postId}:restore`, {
      bearer: f.other.bearer,
      key: controlRestoreKey,
    }),
    204,
  );
  const afterControlRestore = await snapshot(f, f.other, controlSubject);
  expect(Number(afterControlRestore.position[0]?.position) - Number(beforeControlRestore.position[0]?.position)).toBe(
    1,
  );
  expect(
    afterControlRestore.receipts.filter(
      (row: { idempotency_key: string }) => row.idempotency_key === controlRestoreKey,
    ),
  ).toHaveLength(1);
  const controlRestoreEvents = afterControlRestore.outbox.filter(
    (row: { position: string }) => Number(row.position) > Number(beforeControlRestore.position[0]?.position),
  );
  expect(controlRestoreEvents).toHaveLength(1);
  expect(controlRestoreEvents[0]).toMatchObject({
    type: 'com.rezics.content.post.restored.v1',
    subject: controlReview.postId,
  });
  expect(afterControlRestore.slots).toEqual([
    {
      thread_id: controlReview.threadId,
      review_live: true,
      availability: 'available',
      visibility: 'published',
    },
  ]);
  expect(afterControlRestore.heads).toHaveLength(1);
  expect(afterControlRestore.heads[0]).toMatchObject({
    thread_id: controlReview.threadId,
    availability: 'available',
  });
  expect(afterControlRestore.revisions).toHaveLength(1);
  expectStatus(
    await f.call('POST', `/v1/posts/${controlReview.postId}:restore`, {
      bearer: f.other.bearer,
      key: controlRestoreKey,
    }),
    204,
  );
  expect(await snapshot(f, f.other, controlSubject)).toEqual(afterControlRestore);

  const raceSubject = await f.subject('Native review race subject');
  const decoy = await createReview(f, f.other, raceSubject, 'Other author race decoy');
  const raceOtherBefore = await snapshot(f, f.other, raceSubject);
  await vote(f, f.author, raceSubject, 9);
  const raceKeys = [requestKey('race-review-left'), requestKey('race-review-right')] as const;
  const observer = observeSql(f.system.database.pool);
  const firstGate = observer.hold({ statement: accountRead.sql, occurrence: 1 }, 'before');
  const secondGate = observer.hold({ statement: accountRead.sql, occurrence: 2 }, 'before');
  const raceInputs = raceKeys.map((key, index) => ({
    bearer: f.author.bearer,
    key,
    body: createReviewBody(raceSubject, f.boardId, `Concurrent review ${index + 1}`, {
      questionId: STANDARD_QUESTION_ID,
      units: 9,
      revision: 1,
    }),
  }));
  const raceBefore = await snapshot(f, f.author, raceSubject);
  let raced: ReviewLifecycleResponse[];
  try {
    const pending = raceInputs.map((input) => f.call('POST', '/v1/threads', input));
    await Promise.all([firstGate.entered, secondGate.entered]);
    firstGate.release();
    secondGate.release();
    raced = await Promise.all(pending);
  } finally {
    firstGate.release();
    secondGate.release();
    await observer.close();
  }
  expect(raced.map(({ response }) => response.status).sort()).toEqual([201, 409]);
  const winnerIndex = raced.findIndex(({ response }) => response.status === 201);
  const loserIndex = 1 - winnerIndex;
  const winnerThread = raced[winnerIndex]!.value.thread;
  expect(winnerThread.authorId).toBe(f.author.accountId);
  expect(winnerThread.boardId).toBe(f.boardId);
  expect(winnerThread.subjectIds).toEqual([raceSubject]);
  expect(winnerThread.route).toBe(authorRoute);
  const loser = raced[loserIndex]!;
  expect(loser.value.code).toBe('conflict');
  expect(loser.value.existingThreadId).toBe(winnerThread.id);
  expect(JSON.stringify(loser.value)).not.toContain(decoy.threadId);
  expect(JSON.stringify(loser.value)).not.toContain('Other author race decoy');
  const raceAfter = await snapshot(f, f.author, raceSubject);
  const raceOtherAfter = await snapshot(f, f.other, raceSubject);
  expect(Number(raceAfter.position[0]?.position) - Number(raceBefore.position[0]?.position)).toBe(1);
  expect(raceAfter.slots).toEqual([
    { thread_id: winnerThread.id, review_live: true, availability: 'available', visibility: 'published' },
  ]);
  expect(raceAfter.heads).toHaveLength(1);
  expect(raceAfter.heads[0]).toMatchObject({ thread_id: winnerThread.id, availability: 'available' });
  expect(raceAfter.revisions).toHaveLength(1);
  expect(raceAfter.revisions[0]).toMatchObject({
    thread_id: winnerThread.id,
    revision_id: winnerThread.firstPost.revisionId,
  });
  const raceReceipts = raceAfter.receipts.filter((row: { idempotency_key: string }) =>
    raceKeys.includes(row.idempotency_key as (typeof raceKeys)[number]),
  );
  expect(raceReceipts).toHaveLength(1);
  expect(raceReceipts[0]?.idempotency_key).toBe(raceKeys[winnerIndex]);
  const raceEvents = raceAfter.outbox.filter(
    (row: { position: string }) => Number(row.position) > Number(raceBefore.position[0]?.position),
  );
  expect(raceEvents).toHaveLength(1);
  expect(raceEvents[0]).toMatchObject({
    type: 'com.rezics.content.thread.created.v1',
    subject: winnerThread.id,
  });
  expect(raceOtherAfter.receipts).toEqual(raceOtherBefore.receipts);
  expect(raceOtherAfter.heads).toEqual(raceOtherBefore.heads);
  expect(raceOtherAfter.revisions).toEqual(raceOtherBefore.revisions);
  expect(raceOtherAfter.slots).toEqual(raceOtherBefore.slots);
  expect(raceOtherAfter.outbox.filter((row: { subject: string }) => row.subject === decoy.threadId)).toEqual(
    raceOtherBefore.outbox.filter((row: { subject: string }) => row.subject === decoy.threadId),
  );

  const revokedSubject = await f.subject('Review owner revocation subject');
  const revokedReview = await createReview(f, f.author, revokedSubject, 'Review with revoked owner grant');
  const revokedDeleteKey = requestKey('revoked-owner-delete');
  expectStatus(
    await f.call('DELETE', `/v1/posts/${revokedReview.postId}`, {
      bearer: f.author.bearer,
      key: revokedDeleteKey,
    }),
    204,
  );
  const ownerGrant = await f.admin.query<{ valid: string }>(
    `SELECT valid::text FROM access.resource_role_grant
     WHERE route = $1 AND resource_id = $2 AND subject_id = $3 AND grant_role = 'content.post.owner'`,
    [routeOf(revokedReview.postId), revokedReview.postId, f.author.accountId],
  );
  expect(ownerGrant.rows).toHaveLength(1);
  const revoke = await f.call('POST', '/v1/roleGrants:revoke', {
    bearer: f.governance.bearer,
    key: requestKey('revoke-review-owner'),
    body: {
      resource: { route: routeOf(revokedReview.postId), id: revokedReview.postId },
      subject: { kind: 'account', id: f.author.accountId },
      role: 'content.post.owner',
      valid: ownerGrant.rows[0]!.valid,
    },
  });
  expectStatus(revoke, 200);
  const afterRevoke = await snapshot(f, f.author, revokedSubject);
  const denied = await Promise.all([
    f.call('DELETE', `/v1/posts/${revokedReview.postId}`, {
      bearer: f.author.bearer,
      key: revokedDeleteKey,
    }),
    f.call('POST', `/v1/posts/${revokedReview.postId}:restore`, {
      bearer: f.author.bearer,
      key: requestKey('revoked-author-restore'),
    }),
    f.call('POST', `/v1/posts/${revokedReview.postId}:restore`, {
      bearer: f.other.bearer,
      key: requestKey('other-author-restore'),
    }),
    f.call('POST', `/v1/posts/${revokedReview.postId}:restore`, {
      key: requestKey('anonymous-restore'),
    }),
    f.call('DELETE', `/v1/posts/${revokedReview.postId}`, {
      bearer: f.other.bearer,
      key: requestKey('other-author-delete'),
    }),
    f.call('DELETE', `/v1/posts/${revokedReview.postId}`, {
      key: requestKey('anonymous-delete'),
    }),
    f.call('POST', `/v1/posts/${revokedReview.postId}/revisions`, {
      bearer: f.author.bearer,
      key: requestKey('revoked-author-revise'),
      ifMatch: revokedReview.revisionId,
      body: { body: fromPlainText('This unauthorized revision must not be written.') },
    }),
    f.call('POST', `/v1/posts/${revokedReview.postId}/revisions`, {
      bearer: f.other.bearer,
      key: requestKey('other-author-revise'),
      ifMatch: revokedReview.revisionId,
      body: { body: fromPlainText('This other-author revision must not be written.') },
    }),
    f.call('POST', `/v1/posts/${revokedReview.postId}/revisions`, {
      key: requestKey('anonymous-revise'),
      ifMatch: revokedReview.revisionId,
      body: { body: fromPlainText('This anonymous revision must not be written.') },
    }),
  ]);
  expect(denied.map(({ response }) => response.status)).toEqual([403, 404, 404, 401, 404, 401, 403, 404, 401]);
  expect(denied.slice(0, 3).map(({ value }) => value.code)).toEqual(['forbidden', 'not_found', 'not_found']);
  const unknownRestore = await f.call('POST', `/v1/posts/${Bun.randomUUIDv7()}:restore`, {
    bearer: f.other.bearer,
    key: requestKey('unknown-equivalent-restore'),
  });
  expect(unknownRestore.response.status).toBe(404);
  expect({ ...unknownRestore.value, request_id: null }).toEqual({ ...denied[2]!.value, request_id: null });
  expect(await snapshot(f, f.author, revokedSubject)).toEqual(afterRevoke);
});
