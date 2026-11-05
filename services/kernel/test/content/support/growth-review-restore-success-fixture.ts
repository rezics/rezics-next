import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { revisePost } from '../../../src/content/commands.ts';
import { restorePost } from '../../../src/content/restore-post.ts';
import { STANDARD_QUESTION_ID } from '../../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import type { GrowthDatabase, Population } from '../../support/growth.ts';
import {
  createReviewLifecycleFixture,
  requestKey,
  type ReviewLifecycleFixture,
} from '../review-native-lifecycle-fixture.ts';

export const restoreBody = fromPlainText('A native review restored with its original licence and vote citation.');
export const restoreBodyBytes = Buffer.from(serializeDocument(restoreBody));
export const restoreBodyDigest = createHash('sha256').update(restoreBodyBytes).digest();
export const originalTitle = 'Native review restore growth original';
export const scales = [256, 1024, 4096] as const;

export type VoteCitation = Readonly<{ questionId: string; units: number; revision: number }>;
export type ReviewRecord = Readonly<{
  threadId: string;
  postId: string;
  revisionId: string;
  subjectId: string;
}>;
export type RestoreScenario = Readonly<{
  fixture: ReviewLifecycleFixture;
  originalCitation: VoteCitation;
  currentCitation: VoteCitation;
  original: ReviewRecord;
}>;
export type RevisionHistory = {
  readonly review: ReviewRecord;
  headRevisionId: string;
};

function expectStatus(response: { response: Response; text: string }, status: number): void {
  if (response.response.status !== status)
    throw new Error(`Expected HTTP ${status}, received ${response.response.status}: ${response.text}`);
}

async function createReview(
  fixture: ReviewLifecycleFixture,
  subjectId: string,
  title: string,
  citation: VoteCitation,
): Promise<ReviewRecord> {
  const result = await fixture.call('POST', '/v1/threads', {
    bearer: fixture.author.bearer,
    key: requestKey('restore-success-create-review'),
    body: {
      kind: 'review',
      title,
      body: restoreBody,
      licence: 'CC-BY-4.0',
      boardId: fixture.boardId,
      subjectIds: [subjectId],
      visibility: 'published',
      voteCitation: citation,
    },
  });
  expectStatus(result, 201);
  const review = result.value.thread;
  if (!review?.id || !review.firstPost?.id || !review.firstPost?.revisionId)
    throw new Error('Native review creation did not return its thread, opening post and revision');
  return {
    threadId: review.id as string,
    postId: review.firstPost.id as string,
    revisionId: review.firstPost.revisionId as string,
    subjectId,
  };
}

async function liveReviewSlot(fixture: ReviewLifecycleFixture, subjectId: string) {
  const route = routeOf(fixture.author.accountId)!;
  return fixture.admin.query<{ thread_id: string }>(
    `SELECT thread_id
     FROM content.thread
     WHERE route = $1 AND author_account_id = $2 AND board_id = $3 AND review_subject_id = $4
       AND kind = 'review' AND review_live AND availability = 'available' AND visibility <> 'taken_down'`,
    [route, fixture.author.accountId, fixture.boardId, subjectId],
  );
}

export async function createRestoreScenario(): Promise<RestoreScenario> {
  const fixture = await createReviewLifecycleFixture();
  try {
    const vote = await fixture.call('PUT', `/v1/subjects/${fixture.subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
      bearer: fixture.author.bearer,
      key: requestKey('restore-success-vote'),
      body: { units: 7 },
    });
    expectStatus(vote, 200);
    const originalCitation: VoteCitation = {
      questionId: STANDARD_QUESTION_ID,
      units: vote.value.units as number,
      revision: vote.value.revision as number,
    };

    const original = await createReview(fixture, fixture.subjectId, originalTitle, originalCitation);
    const changedVote = await fixture.call(
      'PUT',
      `/v1/subjects/${fixture.subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`,
      {
        bearer: fixture.author.bearer,
        key: requestKey('restore-success-change-vote'),
        body: { units: 12 },
      },
    );
    expectStatus(changedVote, 200);
    const currentCitation: VoteCitation = {
      questionId: STANDARD_QUESTION_ID,
      units: changedVote.value.units as number,
      revision: changedVote.value.revision as number,
    };
    expectStatus(
      await fixture.call('DELETE', `/v1/posts/${original.postId}`, {
        bearer: fixture.author.bearer,
        key: requestKey('restore-success-original-delete'),
      }),
      204,
    );
    const replacement = await createReview(
      fixture,
      fixture.subjectId,
      'Native review restore growth slot replacement',
      currentCitation,
    );
    const occupied = await liveReviewSlot(fixture, fixture.subjectId);
    if (occupied.rows.length !== 1 || occupied.rows[0]!.thread_id !== replacement.threadId)
      throw new Error('The replacement review did not own the selected author/subject/board slot');
    expectStatus(
      await fixture.call('DELETE', `/v1/posts/${replacement.postId}`, {
        bearer: fixture.author.bearer,
        key: requestKey('restore-success-replacement-delete'),
      }),
      204,
    );
    if ((await liveReviewSlot(fixture, fixture.subjectId)).rows.length !== 0)
      throw new Error('Deleting the replacement did not free the selected review slot');

    return { fixture, originalCitation, currentCitation, original };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

export async function createRevisionHistory(scenario: RestoreScenario): Promise<RevisionHistory> {
  const subjectId = await scenario.fixture.subject('Unrelated retained review history subject');
  const review = await createReview(
    scenario.fixture,
    subjectId,
    'Unrelated retained review history anchor',
    scenario.currentCitation,
  );
  return { review, headRevisionId: review.revisionId };
}

function commandContext(key: string) {
  return {
    idempotencyKey: key,
    deadline: Date.now() + 30_000,
    requestId: Bun.randomUUIDv7(),
  };
}

export async function restoreSelectedReview(scenario: RestoreScenario, pool: GrowthDatabase['pool'], key: string) {
  const { fixture, original } = scenario;
  return restorePost(
    { pool, access: fixture.system.access, routeKey: fixture.system.routeKey },
    fixture.system.actors.author.actor,
    original.postId,
    commandContext(key),
  );
}

export async function ensureSelectedReviewRestoredForWarmup(
  scenario: RestoreScenario,
  database: GrowthDatabase,
): Promise<void> {
  const { fixture, original } = scenario;
  const current = await fixture.call('GET', `/v1/threads/${original.threadId}`);
  expectStatus(current, 200);
  if (current.value.thread?.firstPost?.availability === 'available') {
    expectStatus(
      await fixture.call('DELETE', `/v1/posts/${original.postId}`, {
        bearer: fixture.author.bearer,
        key: requestKey('restore-success-warmup-delete'),
      }),
      204,
    );
  } else if (current.value.thread?.firstPost?.availability !== 'erased') {
    throw new Error(`Unexpected review warmup availability: ${current.value.thread?.firstPost?.availability}`);
  }
  const result = await restoreSelectedReview(scenario, database.pool, requestKey('restore-success-warmup'));
  if (result.replayed) throw new Error('A fresh warmup restore unexpectedly replayed');
}

export function unrelatedReviewPopulation(scenario: RestoreScenario): Population {
  const { fixture } = scenario;
  const authorRoute = routeOf(fixture.author.accountId)!;
  const subjectRoute = routeOf(fixture.subjectId)!;
  const authorPartition = partitionOf(authorRoute);
  return {
    name: `review-restore-success-${randomUUID()}`,
    hotPartition: authorPartition,
    hotShare: 1,
    rows: ({ ordinal }) => {
      const subjectId = newId(subjectRoute);
      const voteTargetId = newId(subjectRoute);
      const threadId = newId(authorRoute);
      const postId = newId(authorRoute);
      const revisionId = newId(authorRoute);
      const transactionId = newId(authorRoute);
      return {
        'content.thread': [
          {
            route: authorRoute,
            thread_id: threadId,
            author_account_id: fixture.author.accountId,
            board_id: fixture.boardId,
            title: `Unrelated restore population ${ordinal}`,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            first_post_id: postId,
            availability: 'available',
            kind: 'review',
            review_subject_id: subjectId,
            review_live: true,
          },
        ],
        'content.post': [
          {
            route: authorRoute,
            thread_id: threadId,
            post_id: postId,
            reply_to_post_id: null,
            author_account_id: fixture.author.accountId,
            head_revision_id: revisionId,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            availability: 'available',
            deleted_at: null,
          },
        ],
        'content.revision': [
          {
            route: authorRoute,
            thread_id: threadId,
            post_id: postId,
            revision_id: revisionId,
            body: restoreBodyBytes,
            body_sha256: restoreBodyDigest,
            search_text: 'A native review restored with its original licence and vote citation.',
            licence: 'CC-BY-4.0',
            subject_ids: [subjectId],
            board_id: fixture.boardId,
            availability: 'available',
            recorded_transaction_id: transactionId,
            media_ids: [],
            vote_citation: null,
          },
        ],
        'rating.vote': [
          {
            route: authorRoute,
            voter_id: fixture.author.accountId,
            question_id: STANDARD_QUESTION_ID,
            target_id: voteTargetId,
            units: ordinal % 21,
            revision: 1,
            changed_at: '2026-10-30T00:00:00.000Z',
            transaction_id: newId(authorRoute),
          },
        ],
      };
    },
  };
}

export async function growRetainedRevisionHistory(
  scenario: RestoreScenario,
  history: RevisionHistory,
  pool: GrowthDatabase['pool'],
  from: number,
  to: number,
): Promise<void> {
  const { fixture } = scenario;
  const review = history.review;
  for (let ordinal = from; ordinal < to; ordinal++) {
    const revised = await revisePost(
      { pool, access: fixture.system.access, routeKey: fixture.system.routeKey },
      fixture.system.actors.author.actor,
      {
        threadId: review.threadId,
        itemId: review.postId,
        expectedRevisionId: history.headRevisionId,
        body: restoreBody,
        licence: 'CC-BY-4.0',
        subjectIds: [review.subjectId],
        boardId: fixture.boardId,
        voteCitation: scenario.currentCitation,
      },
      commandContext(requestKey('restore-success-history-revision')),
    );
    if (revised.replayed) throw new Error('A fresh retained-history revision unexpectedly replayed');
    history.headRevisionId = revised.value.revisionId;
  }
}
