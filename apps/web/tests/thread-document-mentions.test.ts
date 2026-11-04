import { expect, test } from 'bun:test';
import { normalizeDocument } from '@rezics/document';
import type { ReadingPageResponse } from '@rezics/client';
import { QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentBody } from '@rezics/ui/document-body';
import { sessionQueryKey } from '../src/session/browser-state';
import { ThreadDocumentMentionsNotice } from '../src/threads/thread-document-mentions-notice';
import {
  isReadingPageMentionProjection,
  projectThreadDocumentMentions,
  ThreadDocumentMentionLease,
  type ThreadDocumentMentionPage,
  type ThreadDocumentMentionPost,
} from '../src/threads/thread-document-mentions';

type MentionProjection = NonNullable<ReadingPageResponse['mentions']>;
type MentionSource = MentionProjection['sources'][number];

const threadId = '019a1b2c-3d4e-7f00-8a00-000000000001';
const otherThreadId = '019a1b2c-3d4e-7f00-8a00-000000000002';
const boardId = '019a1b2c-3d4e-7f00-8a00-000000000003';
const postId = '019a1b2c-3d4e-7f00-8a00-000000000004';
const revisionId = '019a1b2c-3d4e-7f00-8a00-000000000005';
const otherRevisionId = '019a1b2c-3d4e-7f00-8a00-000000000006';
const activeId = '019a1b2c-3d4e-7f00-8a00-000000000007';
const concealedId = '019a1b2c-3d4e-7f00-8a00-000000000008';
const erasedId = '019a1b2c-3d4e-7f00-8a00-000000000009';
const hash = 'a'.repeat(64);
const pageKey = ['thread-page', threadId, null, null];

function source(references: string[], overflow = false): MentionSource {
  return { postId, threadId, revisionId, sha256: hash, pageIndex: 0, references, overflow };
}

function page(mentions: MentionProjection, targetThreadId = threadId): ThreadDocumentMentionPage {
  return {
    target: { threadId: targetThreadId, boardId, boardSecurityRevision: '1' },
    viewer: { kind: 'anonymous' },
    query: { cursor: null, limit: 20 },
    mentions,
    selectedPostId: null,
  };
}

const post = {
  id: postId,
  threadId,
  revisionId,
  sha256: hash,
  availability: 'available',
} satisfies ThreadDocumentMentionPost;

function document() {
  return normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'text',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'body' },
          content: [
            { type: 'text', text: 'Before ' },
            { type: 'mention', attrs: { accountId: activeId } },
            { type: 'text', text: ' middle ' },
            { type: 'mention', attrs: { accountId: concealedId } },
            { type: 'text', text: ' and ' },
            { type: 'mention', attrs: { accountId: erasedId } },
            { type: 'text', text: ' after' },
          ],
        },
      ],
    },
  });
}

test('only exact current disclosed identities link while overflow and fallback text remain visible', () => {
  const current = page({
    state: 'current',
    retryable: false,
    overflow: true,
    sources: [source([activeId, concealedId, erasedId], true)],
    identities: [
      { id: activeId, state: 'active', handle: 'alice' },
      { id: concealedId, state: 'concealed' },
      { id: erasedId, state: 'erased' },
    ],
  });
  const projected = projectThreadDocumentMentions(current, post, 0, true);

  expect(projected).toMatchObject({ notice: 'overflow', overflow: true, retryable: false });
  expect(projected.mentions).toEqual({ [activeId]: { handle: 'alice' } });
  expect(projectThreadDocumentMentions(current, { ...post, revisionId: otherRevisionId }, 0, true)).toMatchObject({
    mentions: {},
    notice: 'changed',
  });
  expect(projectThreadDocumentMentions(page(current.mentions, otherThreadId), post, 0, true)).toMatchObject({
    mentions: {},
    notice: 'changed',
  });

  const html = renderToStaticMarkup(
    createElement(DocumentBody, { document: document(), mentions: projected.mentions, locale: 'en' }),
  );
  expect(html).toContain('href="/en/@alice"');
  expect(html).toContain('Before ');
  expect(html).toContain(' middle ');
  expect(html).toContain(' after');
  expect(html.replace(/<[^>]*>/gu, '')).toContain('Before @alice middle @ and @ after');
  expect((html.match(/<a\b/gu) ?? [])).toHaveLength(1);
});

test('zero references, unavailable output and missing official output stay distinct', () => {
  const empty = page({
    state: 'current',
    retryable: false,
    overflow: false,
    sources: [source([])],
    identities: [],
  });
  expect(projectThreadDocumentMentions(empty, post, 0, true)).toMatchObject({
    mentions: {},
    notice: null,
    overflow: false,
  });

  const unavailable = page({
    state: 'unavailable',
    retryable: true,
    overflow: false,
    sources: [source([])],
    identities: [],
  });
  expect(projectThreadDocumentMentions(unavailable, post, 0, true)).toMatchObject({
    mentions: {},
    notice: 'unavailable',
    retryable: true,
  });
  expect(isReadingPageMentionProjection(undefined)).toBe(false);
  expect(projectThreadDocumentMentions(null, post, 0, true)).toMatchObject({ notice: 'unavailable', retryable: true });
  const notice = renderToStaticMarkup(
    createElement(ThreadDocumentMentionsNotice, {
      identity: postId,
      notice: 'unavailable',
      overflow: false,
      retryable: true,
      onRetry: async () => true,
    }),
  );
  expect(notice).toContain('Mention links could not be checked for this post.');
  expect(notice).toContain('Refresh this page');
});

test('cache invalidation and viewer replacement retire mounted identity summaries', async () => {
  const client = new QueryClient();
  const current = page({
    state: 'current',
    retryable: false,
    overflow: false,
    sources: [source([activeId])],
    identities: [{ id: activeId, state: 'active', handle: 'alice' }],
  });
  const pageLease = new ThreadDocumentMentionLease(current, pageKey, () => true);
  const stopPage = pageLease.connect(client);
  client.setQueryData(pageKey, { revision: 1 });
  expect(pageLease.project(post, 0, true).mentions).toEqual({ [activeId]: { handle: 'alice' } });
  await client.invalidateQueries({ queryKey: pageKey, exact: true });
  expect(pageLease.project(post, 0, true).mentions).toEqual({});
  stopPage();

  const sessionLease = new ThreadDocumentMentionLease(current, pageKey, () => true);
  const stopSession = sessionLease.connect(client);
  client.setQueryData(sessionQueryKey, { state: 'signed-out' });
  expect(sessionLease.project(post, 0, true).mentions).toEqual({});
  stopSession();
  client.clear();
});
