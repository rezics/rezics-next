import { expect, test } from 'bun:test';
import type { DocumentNode } from '@rezics/document';
import { preparedPostReading } from '../src/stories/post-reading-fixtures';
import { receiveThreadDocumentMentions } from '../src/threads/thread-document-mentions';

const mentioned = '11111111-1111-4111-8111-111111111111';
const unreferenced = '22222222-2222-4222-8222-222222222222';

function currentPage() {
  const original = preparedPostReading(1).post;
  const mention: DocumentNode = {
    type: 'paragraph',
    content: [{ type: 'mention', attrs: { accountId: mentioned } }],
  };
  const post = {
    ...original,
    body: {
      ...original.body,
      doc: { ...original.body.doc, content: [...(original.body.doc.content ?? []), mention] },
    },
  };
  return { post, posts: [post] };
}

test('current mention identities require the exact admitted post, revision, digest and page index', () => {
  const { post, posts } = currentPage();
  const projection = {
    state: 'current',
    retryable: false,
    overflow: true,
    sources: [
      {
        postId: post.id,
        threadId: post.threadId,
        revisionId: post.revisionId,
        sha256: post.sha256,
        pageIndex: 0,
        references: [mentioned, unreferenced],
        overflow: true,
      },
    ],
    identities: [
      { id: mentioned, state: 'active', handle: 'current-user' },
      { id: unreferenced, state: 'active', handle: 'not-in-document' },
    ],
  } as const;
  expect(receiveThreadDocumentMentions(projection, posts)).toEqual({ [mentioned]: { handle: 'current-user' } });

  expect(
    receiveThreadDocumentMentions({ ...projection, sources: [{ ...projection.sources[0], pageIndex: 1 }] }, posts),
  ).toEqual({});
  expect(
    receiveThreadDocumentMentions(
      { ...projection, sources: [{ ...projection.sources[0], revisionId: '33333333-3333-4333-8333-333333333333' }] },
      posts,
    ),
  ).toEqual({});
  expect(
    receiveThreadDocumentMentions(
      {
        ...projection,
        identities: [
          { id: mentioned, state: 'concealed' },
          { id: unreferenced, state: 'erased' },
        ],
      },
      posts,
    ),
  ).toEqual({});
  expect(
    receiveThreadDocumentMentions(
      {
        ...projection,
        identities: [
          { id: mentioned, state: 'active', handle: 'first-disclosure' },
          { id: mentioned, state: 'concealed' },
        ],
      },
      posts,
    ),
  ).toEqual({});
  expect(receiveThreadDocumentMentions({ ...projection, state: 'unavailable' }, posts)).toEqual({});
});
