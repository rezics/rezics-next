import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { prepareFeedContentContext } from '../../src/content/feed-context.ts';
import { discloseThreads } from '../../src/content/reads.ts';
import { readSubjectSummaries, readSubjectSummaryObservation } from '../../src/semantic/summaries.ts';
import { readVisibleRatingQuestion, STANDARD_QUESTION_ID } from '../../src/rating/index.ts';
import type { FeedEnrichmentPorts } from '../../src/content/feed-enrichment-ports.ts';
import { routeOf } from '../../src/route/route.ts';
import { createReviewLifecycleFixture } from './review-native-lifecycle-fixture.ts';

const enrichment: FeedEnrichmentPorts = {
  readSubjectSummaries,
  readSubjectSummaryObservation,
  readVisibleRatingQuestion,
  standardQuestionId: STANDARD_QUESTION_ID,
};

test('native context rejects mismatched observations and retires a removed or hidden immediate parent', async () => {
  const f = await createReviewLifecycleFixture();
  try {
    const dependencies = {
      clock: () => new Date(),
      pool: f.system.database.pool,
      routeKey: f.system.routeKey,
      access: f.system.access,
      tokens: f.system.tokenKeys,
    };
    const context = { actor: { kind: 'anonymous' as const }, deadline: Date.now() + 120_000 };
    const created = await f.call('POST', '/v1/threads', {
      bearer: f.author.bearer,
      body: {
        kind: 'review',
        title: 'Current native parent',
        body: fromPlainText('Review opening'),
        licence: 'CC0-1.0',
        boardId: f.boardId,
        subjectIds: [f.subjectId],
        visibility: 'published',
      },
    });
    expect(created.response.status, created.text).toBe(201);
    const threadId = created.value.thread.id as string;
    async function reply(text: string, parentId?: string) {
      const result = await f.call('POST', `/v1/threads/${threadId}/posts`, {
        bearer: f.author.bearer,
        body: { body: fromPlainText(text), licence: 'CC0-1.0', subjectIds: [], ...(parentId ? { parentId } : {}) },
      });
      expect(result.response.status, result.text).toBe(201);
      return result.value.post.id as string;
    }
    const parentId = await reply('Private after removal');
    const postId = await reply('Surviving child', parentId);
    // Distinct activities can share both a selected post and its author/parent keys.
    const references = ['one', 'two'].map((key) => ({ key, threadId, postId }));
    const prepare = () => prepareFeedContentContext(dependencies, enrichment, references, context, ['en']);
    const initial = await (await prepare()).finish();
    expect(initial.contexts.get('one')?.parentContext).toMatchObject({
      kind: 'reply',
      parent: {
        state: 'available',
        id: parentId,
        revisionId: expect.any(String),
        author: { id: f.author.accountId },
        excerpt: 'Private after removal',
        language: null,
        spoiler: false,
      },
    });
    expect(initial.contexts.get('two')).toEqual(initial.contexts.get('one'));
    expect(initial.contexts.get('one')?.reviewContext).toMatchObject({
      target: { state: 'available', subject: { id: f.subjectId } },
      citation: { state: 'absent' },
    });
    const { thread, post } = initial.contexts.get('one')!;
    expect(thread).not.toBeNull();
    expect(post).not.toBeNull();
    await expect(
      prepareFeedContentContext(
        dependencies,
        enrichment,
        [
          { ...references[0]!, initialThread: thread!, initialPost: post! },
          { ...references[1]!, initialPost: { ...post!, parentId: null } },
        ],
        context,
      ),
    ).rejects.toThrow('conflicting post observations');
    const mismatched = await prepareFeedContentContext(dependencies, enrichment, references, context, [], {
      observeThreads: async (ids, current) =>
        (await discloseThreads(dependencies, ids, current)).map((row) => ({
          ...row,
          value: row.value ? { ...row.value, id: f.subjectId } : null,
        })),
    });
    await expect(mismatched.finish()).rejects.toMatchObject({ code: 'dependency_unavailable' });

    const beforeRemoval = await prepare();
    const removed = await f.call('DELETE', `/v1/posts/${parentId}`, { bearer: f.author.bearer });
    expect(removed.response.status, removed.text).toBe(204);
    const afterRemoval = await beforeRemoval.finish();
    for (const value of afterRemoval.contexts.values()) {
      expect(value.post?.id).toBe(postId);
      expect(value.parentContext).toEqual({ kind: 'reply', parent: { state: 'removed', id: parentId } });
      expect(JSON.stringify(value.parentContext)).not.toContain('Private after removal');
    }
    await expect(beforeRemoval.finish()).rejects.toThrow('finish only once');

    const hiddenParent = await reply('Private after takedown');
    const hiddenChild = await reply('Child of hidden parent', hiddenParent);
    const beforeHide = await prepareFeedContentContext(
      dependencies,
      enrichment,
      [{ key: 'hidden', threadId, postId: hiddenChild }],
      context,
    );
    const grant = await f.call('POST', '/v1/grants', {
      bearer: f.governance.bearer,
      body: {
        resource: { route: routeOf(hiddenParent), id: hiddenParent },
        subject: { kind: 'account', id: f.other.accountId },
        actions: ['moderation:takedown'],
        valid: '(,)',
      },
    });
    expect(grant.response.status, grant.text).toBe(201);
    const hidden = await f.call('POST', `/v1/posts/${hiddenParent}:takeDown`, {
      bearer: f.other.bearer,
      body: { reason: 'Hide the selected parent' },
    });
    expect(hidden.response.status, hidden.text).toBe(200);
    const concealed = (await beforeHide.finish()).contexts.get('hidden')!;
    // Ordinary native ancestry can withhold the child itself. It grants no parent bypass.
    expect(concealed.post).toBeNull();
    expect(concealed.postAuthor).toBeUndefined();
    expect(concealed.parentContext).toBeUndefined();
    const empty = await (await prepareFeedContentContext(dependencies, enrichment, [], context)).finish();
    expect(empty.contexts.size).toBe(0);
    expect(empty.anchors).toEqual([]);
  } finally {
    await f.close();
  }
}, 240_000);
