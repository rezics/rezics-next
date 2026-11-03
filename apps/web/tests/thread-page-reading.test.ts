import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import { loadThreadPage } from '../src/threads/thread-page';

const threadId = '11111111-1111-4111-8111-111111111111';
const boardId = '22222222-2222-4222-8222-222222222222';
const authorId = '33333333-3333-4333-8333-333333333333';
const openingId = '44444444-4444-4444-8444-444444444444';
const replyId = '55555555-5555-4555-8555-555555555555';

test('the Web receiver maps the mounted page while preserving a selected reply and its local text', async () => {
  const createdAt = '2026-11-04T00:00:00.000Z';
  const opening = {
    id: openingId,
    threadId,
    route: 0,
    authorId,
    parentId: null,
    licence: 'CC0-1.0',
    subjectIds: [],
    boardId,
    visibility: 'published',
    securityRevision: '1',
    availability: 'available',
    createdAt,
    revisedAt: null,
    sha256: 'opening-digest',
    mediaIds: [],
    voteCitation: null,
    revisionId: '66666666-6666-4666-8666-666666666666',
    body: fromPlainText('Opening text stays local', 'blocks'),
  };
  const reply = {
    ...opening,
    id: replyId,
    route: 1,
    parentId: openingId,
    revisionId: '77777777-7777-4777-8777-777777777777',
    sha256: 'reply-digest',
    body: fromPlainText('Reply text stays local', 'blocks'),
  };
  const response = {
    thread: {
      id: threadId,
      route: 0,
      authorId,
      kind: 'discussion',
      title: 'A reading page',
      licence: 'CC0-1.0',
      subjectIds: [],
      boardId,
      visibility: 'published',
      securityRevision: '1',
      availability: 'available',
      createdAt,
      firstPost: opening,
    },
    replies: { items: [reply], next: null },
  };
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith('/location')) return Response.json({ cursor: 'selected-reply-cursor' });
      if (url.pathname.endsWith('/reading-page')) return Response.json(response);
      if (url.pathname === `/v1/boards/${boardId}`) return Response.json({});
      throw new Error(`Unexpected Kernel read: ${url.pathname}`);
    },
  });

  const page = await loadThreadPage(
    client,
    new Request(`https://web.test/threads/${threadId}/a-reading-page`),
    {},
    { id: threadId, post: replyId },
    {} as never,
  );

  expect(paths.some((path) => path.endsWith(`/posts/${replyId}/location`))).toBe(true);
  expect(paths).toContain(`/v1/threads/${threadId}/reading-page?cursor=selected-reply-cursor`);
  expect(page).toMatchObject({ linkedPostUnavailable: false, thread: { id: threadId } });
  expect(page.posts.posts.map(({ id, revisionId }) => [id, revisionId])).toEqual([
    [openingId, opening.revisionId],
    [replyId, reply.revisionId],
  ]);
  expect(page.posts.posts.map(({ body }) => body)).toEqual([opening.body, reply.body]);
});
