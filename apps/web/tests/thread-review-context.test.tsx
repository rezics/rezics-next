import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ThreadPost } from '../src/threads/thread-page';
import { ThreadReviewContext, type ThreadReviewContextValue } from '../src/threads/thread-review-context';

const threadId = '11111111-1111-4111-8111-111111111111';
const postId = '22222222-2222-4222-8222-222222222222';
const revisionId = '33333333-3333-4333-8333-333333333333';
const subjectId = '44444444-4444-4444-8444-444444444444';
const questionId = '55555555-5555-4555-8555-555555555555';

const post: Extract<ThreadPost, { availability: 'available' }> = {
  id: postId,
  threadId,
  route: 0,
  authorId: '66666666-6666-4666-8666-666666666666',
  parentId: null,
  licence: 'CC0-1.0',
  subjectIds: [],
  boardId: '77777777-7777-4777-8777-777777777777',
  visibility: 'published',
  securityRevision: '1',
  availability: 'available',
  createdAt: '2026-11-04T00:00:00.000Z',
  revisedAt: null,
  sha256: 'a'.repeat(64),
  mediaIds: [],
  voteCitation: null,
  revisionId,
  body: fromPlainText('A review post.', 'blocks'),
};
const erasedPost: Extract<ThreadPost, { availability: 'erased' }> = {
  id: postId,
  threadId,
  route: 0,
  parentId: null,
  removed: true,
  availability: 'erased',
  body: null,
  sha256: null,
};

const context: ThreadReviewContextValue = {
  source: { threadId, postId, revisionId },
  target: {
    state: 'available',
    subject: { id: subjectId, kind: 'visualNovel', label: { value: 'Reviewed work', language: 'en' } },
  },
  citations: {
    state: 'current',
    items: [
      {
        postId,
        sourceRevisionId: revisionId,
        citation: {
          state: 'available',
          questionId,
          units: 0,
          voteRevision: 3,
          metadata: { state: 'unavailable' },
        },
      },
    ],
  },
};

function view(value: ThreadReviewContextValue, posts: readonly ThreadPost[] = [post]) {
  return renderToStaticMarkup(
    <ThreadReviewContext
      context={value}
      thread={{ id: threadId, title: 'A careful review' }}
      posts={posts}
      cursor="opaque:/+?="
      boardReturn="/en/boards/77777777-7777-4777-8777-777777777777?sort=active"
      locale="en"
    />,
  );
}

test('review context follows the current target and exact published citation, preserving a zero value', () => {
  const html = view(context);
  expect(html).toContain(`data-review-subject="${subjectId}"`);
  expect(html).toContain(`href="/en/subjects/${subjectId}/reviewed-work"`);
  expect(html).toContain(`href="/en/posts/${postId}/revisions/${revisionId}"`);
  expect(html).toContain(`data-cited-value="0"`);
  expect(html).toContain(questionId);
  expect(html).toContain('historical question label and scale are unavailable');
  expect(html).not.toContain('current rating: 0');
});

test('withheld targets and absent citations stay explicit, and stale revisions never borrow a citation', () => {
  const hidden: ThreadReviewContextValue = {
    ...context,
    target: { state: 'withheld' },
    citations: {
      state: 'current',
      items: [{ postId, sourceRevisionId: revisionId, citation: { state: 'absent' } }],
    },
  };
  const hiddenHtml = view(hidden);
  expect(hiddenHtml).toContain('Target presentation is withheld.');
  expect(hiddenHtml).toContain('No rating was cited for this post.');
  expect(hiddenHtml).not.toContain(subjectId);

  const newRevisionId = '88888888-8888-4888-8888-888888888888';
  const changedPost: ThreadPost = { ...post, revisionId: newRevisionId };
  const changedContext = { ...context, source: { ...context.source, revisionId: newRevisionId } };
  const staleHtml = view(changedContext, [changedPost]);
  expect(staleHtml).not.toContain(`href="/en/posts/${postId}/revisions/${revisionId}"`);
  expect(staleHtml).not.toContain('data-cited-value="0"');
  expect(staleHtml).toContain('Recorded rating context could not be loaded.');
});

test('a review context from another thread is not displayed on this visit', () => {
  const stale = { ...context, source: { ...context.source, threadId: '99999999-9999-4999-8999-999999999999' } };
  expect(view(stale)).toBe('');
  expect(view({ ...context, source: { ...context.source, revisionId: null } })).toBe('');
  expect(view(context, [erasedPost])).toBe('');
});

test('a withheld citation source stays explicit without a post destination', () => {
  const withheldPost: Extract<ThreadPost, { availability: 'withheld' }> = {
    id: '88888888-8888-4888-8888-888888888888',
    threadId,
    route: 1,
    parentId: postId,
    removed: true,
    availability: 'withheld',
    body: null,
    sha256: null,
  };
  const hidden: ThreadReviewContextValue = {
    ...context,
    citations: {
      state: 'current',
      items: [{ postId: withheldPost.id, sourceRevisionId: revisionId, citation: { state: 'withheld' } }],
    },
  };
  const html = view(hidden, [post, withheldPost]);
  expect(html).toContain('No recorded rating is disclosed for this revision.');
  expect(html).not.toContain(`post=${withheldPost.id}`);
});
