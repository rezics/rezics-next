import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { Compile } from 'typebox/compile';
import { readingPagePublishedCitations, ReadingPageReviewContextSchema } from '../../src/content/reading-page-context.ts';
import { readThread } from '../../src/content/reads.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { createReviewLifecycleFixture, requestKey } from './review-native-lifecycle-fixture.ts';

test('native reading page keeps current reviewed work independent from exact zero published citations', async () => {
  const f = await createReviewLifecycleFixture();
  try {
    const vote = await f.call('PUT', `/v1/subjects/${f.subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
      bearer: f.author.bearer, key: requestKey('reading-context-vote'), body: { units: 0 },
    });
    expect(vote.response.status, vote.text).toBe(200);
    const citation = { questionId: STANDARD_QUESTION_ID, units: 0, revision: vote.value.revision };
    const created = await f.call('POST', '/v1/threads', {
      bearer: f.author.bearer, key: requestKey('reading-context-thread'),
      body: {
        kind: 'review', title: 'Read the reviewed work', body: fromPlainText('Published context'),
        licence: 'CC0-1.0', boardId: f.boardId, subjectIds: [f.subjectId],
        visibility: 'published', voteCitation: citation,
      },
    });
    expect(created.response.status, created.text).toBe(201);
    const thread = created.value.thread;
    const changed = await f.call('PUT', `/v1/subjects/${f.subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
      bearer: f.author.bearer, key: requestKey('reading-context-new-vote'), body: { units: 10 },
    });
    expect(changed.response.status, changed.text).toBe(200);
    const page = await f.call('GET', `/v1/threads/${thread.id}/reading-page`);
    expect(page.response.status, page.text).toBe(200);
    const context = page.value.reviewContext;
    expect(Compile(ReadingPageReviewContextSchema).Check(context)).toBe(true);
    expect(context).toEqual({
      source: { threadId: thread.id, postId: thread.firstPost.id, revisionId: thread.firstPost.revisionId },
      target: { state: 'available', subject: { id: f.subjectId, kind: 'schema:Book', label: expect.anything() } },
      citations: { state: 'current', items: [{
        postId: thread.firstPost.id, sourceRevisionId: thread.firstPost.revisionId,
        citation: { state: 'available', questionId: citation.questionId, units: 0,
          voteRevision: citation.revision, metadata: { state: 'unavailable' } },
      }] },
    });
    expect(page.value.actions.reply.state).toBe('sign_in_required');
    expect(page.value.thread.firstPost.voteCitation).toEqual(citation);
    // Unknown historical metadata does not accept a current question label or scale.
    const substituted = structuredClone(context);
    substituted.citations.items[0].citation.metadata = { state: 'available', label: f.question.label };
    expect(Compile(ReadingPageReviewContextSchema).Check(substituted)).toBe(false);

    const dependencies = { pool: f.system.database.pool, routeKey: f.system.routeKey,
      access: f.system.access, tokens: f.system.tokenKeys };
    const observed = await readThread(dependencies, thread.id, { actor: { kind: 'anonymous' }, deadline: Date.now() + 60_000 });
    expect(observed.value).not.toBeNull();
    const native = observed.value!;
    const opening = native.firstPost;
    const duplicate = { ...opening, id: crypto.randomUUID() };
    expect(readingPagePublishedCitations(native, [duplicate]).items.map((item) => item.citation))
      .toEqual([context.citations.items[0].citation, context.citations.items[0].citation]);
    expect(() => readingPagePublishedCitations(native, [opening])).toThrow('Duplicate');
    expect(() => readingPagePublishedCitations(native, Array(21).fill(duplicate))).toThrow('bound');
    expect(() => readingPagePublishedCitations(native, [{ ...duplicate, threadId: crypto.randomUUID() }]))
      .toThrow('source mismatch');
    if (opening.availability !== 'available') throw new Error('Expected readable opening');
    expect(readingPagePublishedCitations({ ...native, firstPost: { ...opening, voteCitation: null } }, []).items[0]?.citation)
      .toEqual({ state: 'absent' });
    expect(readingPagePublishedCitations({ ...native, firstPost: { ...opening, availability: 'erased', removed: true, body: null, sha256: null } }, []).items[0]?.citation)
      .toEqual({ state: 'withheld' });
  } finally {
    await f.close();
  }
}, 240_000);
