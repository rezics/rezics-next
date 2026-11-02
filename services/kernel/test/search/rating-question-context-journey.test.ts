import { afterAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId } from '../../src/route/route.ts';
import type { ReadContext } from '../../src/content/model.ts';
import {
  REVIEW_CONTEXT_MAX_WITNESSES,
  type ReviewContextCandidate,
} from '../../src/content/review-context-eligibility.ts';
import {
  assertCurrentRatingQuestionConditions,
  qualifyRatingQuestionConditionWitnesses,
  resolveRatingQuestionConditions,
} from '../../src/search/rating-question-condition.ts';
import {
  createReviewLifecycleFixture,
  type ReviewLifecycleFixture,
} from '../content/review-native-lifecycle-fixture.ts';

let fixture: ReviewLifecycleFixture | undefined;
afterAll(async () => fixture?.close());

// Mount ordinary Content and Rating writes before qualifying their native
// witnesses. Retained Source population and the three feed lanes are separate.
test('exact question witnesses follow current published citations, disclosure and retirement', async () => {
  const f = (fixture = await createReviewLifecycleFixture());
  const deps = { pool: f.system.database.pool, access: f.system.access, tokens: f.system.tokenKeys };
  const context: ReadContext = { actor: { kind: 'anonymous' }, deadline: Date.now() + 120_000 };
  const selected = await resolveRatingQuestionConditions(
    deps,
    { ratingQuestion: { id: STANDARD_QUESTION_ID } },
    context,
  );
  expect(selected.keys).toEqual([
    { kind: 'reviewQuestion', question: STANDARD_QUESTION_ID, revision: String(f.question.revision) },
  ]);
  const votePath = `/v1/subjects/${f.subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`;
  const vote = async (units: number) => {
    const result = await f.call('PUT', votePath, { bearer: f.author.bearer, body: { units } });
    expect(result.response.status, result.text).toBe(200);
    return { questionId: STANDARD_QUESTION_ID, units, revision: result.value.revision as number };
  };
  const citation = await vote(14);
  const reviewBody = {
    kind: 'review',
    title: 'Context witness',
    body: fromPlainText('Published review'),
    licence: 'CC-BY-4.0',
    subjectIds: [f.subjectId],
    boardId: f.boardId,
    visibility: 'published',
    voteCitation: citation,
  };
  const created = await f.call('POST', '/v1/threads', { bearer: f.author.bearer, body: reviewBody });
  expect(created.response.status, created.text).toBe(201);
  const thread = created.value.thread;
  const primary: ReviewContextCandidate = { kind: 'subject', subjectId: f.subjectId, threadId: thread.id };
  const qualify = (pairs: readonly ReviewContextCandidate[] = [primary]) =>
    qualifyRatingQuestionConditionWitnesses(deps, selected, STANDARD_QUESTION_ID, pairs, context);
  expect(await qualify([primary, primary, { ...primary, kind: 'thread' }])).toEqual(['current', 'current', 'current']);
  expect(await qualify([{ ...primary, subjectId: newId(0x1234) }])).toEqual(['refused']);
  await expect(qualify(Array.from({ length: REVIEW_CONTEXT_MAX_WITNESSES + 1 }, () => primary))).rejects.toThrow(
    RangeError,
  );

  const hidden = await f.call('POST', '/v1/threads', {
    bearer: f.other.bearer,
    body: { ...reviewBody, visibility: 'draft', voteCitation: undefined },
  });
  expect(hidden.response.status, hidden.text).toBe(201);
  expect(await qualify([{ ...primary, threadId: hidden.value.thread.id }])).toEqual(['refused']);

  const reply = await f.call('POST', `/v1/threads/${thread.id}/posts`, {
    bearer: f.author.bearer,
    body: { body: fromPlainText('Review reply'), licence: 'CC-BY-4.0' },
  });
  expect(reply.response.status, reply.text).toBe(201);
  const post: ReviewContextCandidate = { ...primary, kind: 'post', postId: reply.value.post.id };
  expect(await qualify([post, post])).toEqual(['current', 'current']);
  // One post ID cannot borrow another thread's witness, even at the same route.
  expect(await qualify([post, { ...post, threadId: hidden.value.thread.id }])).toEqual(['current', 'refused']);
  const removedReply = await f.call('DELETE', `/v1/posts/${reply.value.post.id}`, { bearer: f.author.bearer });
  expect(removedReply.response.status, removedReply.text).toBe(200);
  expect(await qualify([primary, post])).toEqual(['current', 'refused']);

  const changedVote = await vote(4);
  expect(await qualify()).toEqual(['current']);
  const publicReview = await f.call('GET', `/v1/threads/${thread.id}`);
  expect(publicReview.value.thread.firstPost.voteCitation).toEqual(citation);
  const revised = await f.call('POST', `/v1/posts/${thread.firstPost.id}/revisions`, {
    bearer: f.author.bearer,
    ifMatch: thread.firstPost.revisionId,
    body: { body: fromPlainText('No published citation') },
  });
  expect(revised.response.status, revised.text).toBe(200);
  expect(await qualify()).toEqual(['refused']);
  const recited = await f.call('POST', `/v1/posts/${thread.firstPost.id}/revisions`, {
    bearer: f.author.bearer,
    ifMatch: revised.value.post.revisionId,
    body: { body: fromPlainText('Current citation'), voteCitation: changedVote },
  });
  expect(recited.response.status, recited.text).toBe(200);
  expect(await qualify()).toEqual(['current']);
  const retired = await f.call('DELETE', `/v1/posts/${thread.firstPost.id}`, { bearer: f.author.bearer });
  expect(retired.response.status, retired.text).toBe(200);
  expect(await qualify()).toEqual(['refused']);

  // An unavailable leaf cannot hide under a true kind branch or NOT.
  for (const filter of [
    { or: [{ kind: { in: ['schema:Book'] } }, { ratingQuestion: { id: newId(0x1234) } }] },
    { not: { ratingQuestion: { id: newId(0x1234) } } },
  ])
    await expect(resolveRatingQuestionConditions(deps, filter, context)).rejects.toMatchObject({ code: 'not_found' });
  await expect(
    qualifyRatingQuestionConditionWitnesses(deps, selected, newId(0x1234), [primary], context),
  ).rejects.toThrow(TypeError);
  await expect(assertCurrentRatingQuestionConditions(deps, selected, { ...context })).rejects.toThrow(TypeError);
  await f.admin.query('UPDATE rating.question SET revision = revision + 1 WHERE id = $1', [STANDARD_QUESTION_ID]);
  await expect(assertCurrentRatingQuestionConditions(deps, selected, context)).rejects.toMatchObject({
    code: 'invalid_cursor',
  });
});
