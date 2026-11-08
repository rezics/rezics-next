import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createFeedQuestionSession } from '../../src/content/feed-question.ts';
import type { FeedItem, FeedLaneCandidate, FeedPublicSummary } from '../../src/content/contract/index.ts';
import { routeOf } from '../../src/route/route.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createReviewLifecycleFixture, requestKey } from './review-native-lifecycle-fixture.ts';

function publicSubject(id: string): FeedPublicSummary {
  return {
    id,
    type: 'schema:Book',
    types: ['schema:Book'],
    label: { value: id, language: 'en' },
    creativeWork: true,
    cover: null,
  };
}

function subjectItem(id: string): FeedItem {
  const summary = publicSubject(id);
  return {
    id: `continue:${id}`,
    source: 'continue',
    key: { owner: 'semantic', kind: summary.type, route: routeOf(id)!, id },
    occurredAt: '2026-01-01T00:00:00.000Z',
    summary,
    continue: {
      subjectId: id,
      state: 'active',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      activeProgressSession: null,
      subject: summary,
    },
    destination: { kind: 'subject', id, title: id },
  };
}

function reviewItem(threadId: string): FeedItem {
  return {
    id: `discovery:content:${threadId}`,
    source: 'discovery',
    key: { owner: 'content', kind: 'review', route: routeOf(threadId)!, id: threadId },
    occurredAt: null,
    summary: { id: threadId, kind: 'review', title: 'A review', createdAt: '2026-01-01T00:00:00.000Z' },
    destination: { kind: 'thread', id: threadId, title: 'A review' },
  };
}

function followingReviewItem(threadId: string): FeedItem {
  return {
    id: `following:thread:${threadId}`,
    source: 'following',
    key: { owner: 'content', kind: 'thread', route: routeOf(threadId)!, id: threadId },
    occurredAt: '2026-01-01T00:00:00.000Z',
    summary: { id: threadId, kind: 'review', title: 'A review' },
    destination: { kind: 'thread', id: threadId, title: 'A review' },
  };
}

function replyItem(threadId: string, postId: string): FeedItem {
  return {
    id: `following:post:${postId}`,
    source: 'following',
    key: { owner: 'content', kind: 'post', route: routeOf(postId)!, id: postId },
    occurredAt: '2026-01-01T00:00:00.000Z',
    summary: { id: postId, threadId, createdAt: '2026-01-01T00:00:00.000Z', title: 'A review' },
    destination: { kind: 'post', id: postId, postId, threadId, title: 'A review' },
  };
}

test('Home admits exact Subject, historical Review and reply witnesses and refuses changed anchors', async () => {
  const f = await createReviewLifecycleFixture();
  try {
    const subjectId = f.subjectId;
    const otherSubjectId = await f.subject('No matching review');
    const vote = await f.call('PUT', `/v1/subjects/${subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
      bearer: f.author.bearer,
      body: { units: 3 },
    });
    expect(vote.response.status, vote.text).toBe(200);
    const citation = { questionId: STANDARD_QUESTION_ID, units: 3, revision: vote.value.revision as number };
    const created = await f.call('POST', '/v1/threads', {
      bearer: f.author.bearer,
      body: {
        kind: 'review',
        title: 'A selected review',
        body: fromPlainText('A published review.'),
        licence: 'CC-BY-4.0',
        subjectIds: [subjectId],
        boardId: f.boardId,
        visibility: 'published',
        voteCitation: citation,
      },
    });
    expect(created.response.status, created.text).toBe(201);
    const thread = created.value.thread;
    const reply = await f.call('POST', `/v1/threads/${thread.id}/posts`, {
      bearer: f.author.bearer,
      body: { body: fromPlainText('A readable reply.'), licence: 'CC-BY-4.0' },
    });
    expect(reply.response.status, reply.text).toBe(201);
    const changedVote = await f.call('PUT', `/v1/subjects/${subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
      bearer: f.author.bearer,
      body: { units: 18 },
    });
    expect(changedVote.response.status, changedVote.text).toBe(200);

    const session = await createFeedQuestionSession(
      {
        pool: f.system.database.pool,
        access: f.system.access,
        tokens: f.system.tokenKeys,
        clock: () => new Date(),
      },
      { kind: 'anonymous' },
      STANDARD_QUESTION_ID,
      Date.now() + 120_000,
    );
    const review = reviewItem(thread.id);
    const followingReview = followingReviewItem(thread.id);
    const replyCard = replyItem(thread.id, reply.value.post.id);
    const candidates: FeedLaneCandidate[] = [
      { item: subjectItem(subjectId) },
      {
        item: review,
        questionWitness: {
          kind: 'thread',
          subjectId,
          threadId: thread.id,
          voteRevision: citation.revision,
        },
      },
      {
        item: followingReview,
        questionWitness: {
          kind: 'thread',
          subjectId,
          threadId: thread.id,
          voteRevision: citation.revision,
        },
      },
      {
        item: replyCard,
        questionWitness: {
          kind: 'post',
          subjectId,
          threadId: thread.id,
          postId: reply.value.post.id,
          voteRevision: citation.revision,
        },
      },
      { item: subjectItem(otherSubjectId) },
      {
        item: review,
        questionWitness: {
          kind: 'thread',
          subjectId,
          threadId: thread.id,
          voteRevision: citation.revision + 1,
        },
      },
      { item: review },
    ];

    expect(await session.qualify(candidates)).toEqual([
      'current',
      'current',
      'current',
      'current',
      'absent',
      'refused',
      'refused',
    ]);
    await session.finish();
  } finally {
    await f.close();
  }
});
