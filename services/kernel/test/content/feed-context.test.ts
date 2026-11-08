import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { prepareFeedContentContext } from '../../src/content/feed-context.ts';
import { readSubjectSummaries, readSubjectSummaryObservation } from '../../src/semantic/summaries.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { readVisibleRatingQuestion, STANDARD_QUESTION_ID } from '../../src/rating/index.ts';
import type { FeedEnrichmentPorts } from '../../src/content/feed-enrichment-ports.ts';
import { createReviewLifecycleFixture, requestKey } from './review-native-lifecycle-fixture.ts';

const enrichment: FeedEnrichmentPorts = {
  readSubjectSummaries,
  readSubjectSummaryObservation,
  readVisibleRatingQuestion,
  standardQuestionId: STANDARD_QUESTION_ID,
};

test('native Home context retains a review target, zero citation and only the immediate reply parent', async () => {
  const fixture = await createReviewLifecycleFixture();
  try {
    const vote = await fixture.call('PUT', `/v1/subjects/${fixture.subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
      bearer: fixture.author.bearer,
      key: requestKey('feed-context-vote'),
      body: { units: 0 },
    });
    expect(vote.response.status, vote.text).toBe(200);
    const citation = {
      questionId: STANDARD_QUESTION_ID,
      units: vote.value.units as number,
      revision: vote.value.revision as number,
    };
    const created = await fixture.call('POST', '/v1/threads', {
      bearer: fixture.author.bearer,
      key: requestKey('feed-context-review'),
      body: {
        kind: 'review',
        title: 'Native context review',
        body: fromPlainText('A review with a recorded score.'),
        licence: 'CC-BY-4.0',
        boardId: fixture.boardId,
        subjectIds: [fixture.subjectId],
        visibility: 'published',
        voteCitation: citation,
      },
    });
    expect(created.response.status, created.text).toBe(201);
    const threadId = created.value.thread.id as string;
    const openingId = created.value.thread.firstPost.id as string;
    const firstReply = await fixture.call('POST', `/v1/threads/${threadId}/posts`, {
      bearer: fixture.author.bearer,
      key: requestKey('feed-context-first-reply'),
      body: { body: fromPlainText('First reply preview.'), licence: 'CC0-1.0', subjectIds: [] },
    });
    expect(firstReply.response.status, firstReply.text).toBe(201);
    const firstReplyId = firstReply.value.post.id as string;
    const secondReply = await fixture.call('POST', `/v1/threads/${threadId}/posts`, {
      bearer: fixture.author.bearer,
      key: requestKey('feed-context-second-reply'),
      body: {
        body: fromPlainText('Second reply preview.'),
        licence: 'CC0-1.0',
        subjectIds: [],
        parentId: firstReplyId,
      },
    });
    expect(secondReply.response.status, secondReply.text).toBe(201);
    const secondReplyId = secondReply.value.post.id as string;

    const dependencies = {
      clock: () => new Date(),
      pool: fixture.system.database.pool,
      routeKey: fixture.system.routeKey,
      access: fixture.system.access,
      tokens: fixture.system.tokenKeys,
    };
    const context = { actor: { kind: 'anonymous' as const }, deadline: Date.now() + 60_000 };
    const prepared = await prepareFeedContentContext(
      dependencies,
      enrichment,
      [
        { key: 'review', threadId },
        { key: 'opening', threadId, postId: openingId },
        { key: 'first-reply', threadId, postId: firstReplyId },
        { key: 'second-reply', threadId, postId: secondReplyId },
      ],
      context,
      ['en'],
    );
    const result = await prepared.finish();
    expect(result.contexts.get('review')?.reviewContext).toMatchObject({
      target: { state: 'available', subject: { id: fixture.subjectId, kind: 'schema:Book' } },
      citation: {
        state: 'available',
        question: { id: STANDARD_QUESTION_ID, revision: fixture.question.revision, scale: { min: 0, max: 20 } },
        units: 0,
        voteRevision: citation.revision,
      },
    });
    expect(result.contexts.get('opening')?.parentContext).toEqual({ kind: 'opening' });
    expect(result.contexts.get('second-reply')?.parentContext).toMatchObject({
      kind: 'reply',
      parent: { state: 'available', id: firstReplyId, excerpt: 'First reply preview.' },
    });
    expect(JSON.stringify(result.contexts.get('second-reply')?.parentContext)).not.toContain(openingId);

    const subjectPage = await fixture.call(
      'GET',
      `/v1/subjects/${fixture.subjectId}/threads?place=${GLOBAL_CONTEXT}&kind=review`,
    );
    expect(subjectPage.response.status, subjectPage.text).toBe(200);
    expect(subjectPage.value.threads[0]?.reviewContext).toEqual(result.contexts.get('review')?.reviewContext);
  } finally {
    await fixture.close();
  }
}, 240_000);
