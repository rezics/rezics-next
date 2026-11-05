import { fromPlainText, normalizeDocument } from '@rezics/document';
import { STANDARD_QUESTION_ID } from '../../../src/rating/votes.ts';
import { routeOf } from '../../../src/route/route.ts';
import type { ReviewLifecycleFixture } from '../review-native-lifecycle-fixture.ts';

export type ContextReview = Readonly<{
  threadId: string;
  openingId: string;
  revisionId: string;
  citation: Readonly<{ questionId: string; units: number; revision: number }>;
}>;

export async function createContextReview(
  fixture: ReviewLifecycleFixture,
  subjectId = fixture.subjectId,
  title = 'Public author review',
): Promise<ContextReview> {
  const vote = await fixture.call('PUT', `/v1/subjects/${subjectId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
    bearer: fixture.author.bearer,
    body: { units: 0 },
  });
  if (vote.response.status !== 200)
    throw new Error(`Could not publish review vote: ${vote.response.status} ${vote.text}`);
  const citation = {
    questionId: STANDARD_QUESTION_ID,
    units: vote.value.units as number,
    revision: vote.value.revision as number,
  };
  const result = await fixture.call('POST', '/v1/threads', {
    bearer: fixture.author.bearer,
    body: {
      kind: 'review',
      title,
      body: fromPlainText(`${title} body`),
      licence: 'CC0-1.0',
      boardId: fixture.boardId,
      subjectIds: [subjectId],
      voteCitation: citation,
      visibility: 'published',
    },
  });
  if (result.response.status !== 201)
    throw new Error(`Could not create review: ${result.response.status} ${result.text}`);
  return {
    threadId: result.value.thread.id as string,
    openingId: result.value.thread.firstPost.id as string,
    revisionId: result.value.thread.firstPost.revisionId as string,
    citation,
  };
}

export async function createContextReply(
  fixture: ReviewLifecycleFixture,
  threadId: string,
  text: string,
  parentId?: string,
  visibility: 'published' | 'protected' = 'published',
): Promise<Readonly<{ id: string; revisionId: string }>> {
  const body = normalizeDocument({
    ...fromPlainText(text),
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'private-attribute', lang: 'ja' },
          content: [
            { type: 'text', text, marks: [{ type: 'spoiler' }] },
            { type: 'ruby', attrs: { rt: 'private annotation' }, content: [{ type: 'text', text: ' visible' }] },
          ],
        },
      ],
    },
  });
  const result = await fixture.call('POST', `/v1/threads/${threadId}/posts`, {
    bearer: fixture.author.bearer,
    body: { body, licence: 'CC0-1.0', subjectIds: [], visibility, ...(parentId ? { parentId } : {}) },
  });
  if (result.response.status !== 201)
    throw new Error(`Could not create reply: ${result.response.status} ${result.text}`);
  return { id: result.value.post.id as string, revisionId: result.value.post.revisionId as string };
}

export async function setAuthorViews(
  fixture: ReviewLifecycleFixture,
  value: Readonly<{ posts: boolean; reviews: boolean }>,
): Promise<void> {
  await fixture.admin.query('UPDATE access.account SET public_views=$3::jsonb WHERE route=$1 AND account_id=$2', [
    routeOf(fixture.author.accountId),
    fixture.author.accountId,
    JSON.stringify(value),
  ]);
}

export async function grantAuthorEditor(fixture: ReviewLifecycleFixture, editorId: string): Promise<void> {
  const result = await fixture.call('POST', '/v1/grants', {
    bearer: fixture.governance.bearer,
    body: {
      resource: { route: routeOf(fixture.author.accountId), id: fixture.author.accountId },
      subject: { kind: 'account', id: editorId },
      actions: ['account:update'],
      valid: '(,)',
    },
  });
  if (result.response.status !== 201)
    throw new Error(`Could not grant author editor: ${result.response.status} ${result.text}`);
}
