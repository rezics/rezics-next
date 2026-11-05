import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';
import type { ReadingPage } from '../src/threads/thread-page';
import { isThreadPageCursorError, loadThreadPage } from '../src/threads/thread-page';

const threadId = '11111111-1111-4111-8111-111111111111';
const boardId = '22222222-2222-4222-8222-222222222222';
const authorId = '33333333-3333-4333-8333-333333333333';
const openingId = '44444444-4444-4444-8444-444444444444';
const replyId = '55555555-5555-4555-8555-555555555555';

test('the Web receiver maps the mounted page while preserving a selected reply and its local text', async () => {
  const createdAt = '2026-11-04T00:00:00.000Z';
  const opening: Extract<ReadingPage['thread']['firstPost'], { availability: 'available' }> = {
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
  const reply: typeof opening = {
    ...opening,
    id: replyId,
    route: 1,
    parentId: openingId,
    revisionId: '77777777-7777-4777-8777-777777777777',
    sha256: 'reply-digest',
    body: fromPlainText('Reply text stays local', 'blocks'),
  };
  const response = authoredReadingPage(
    {
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
    [reply],
    [{ id: authorId, displayName: 'Disclosed author', handle: null, avatar: null }],
  );
  const paths: string[] = [];
  let failed = false;
  let missingLocation = false;
  let abortRead: AbortController | undefined;
  let abortMedia: AbortController | undefined;
  let mediaSignal: AbortSignal | null | undefined;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      paths.push(`${url.pathname}${url.search}`);
      expect(new Request(input, init).headers.has('authorization')).toBe(false);
      if (url.pathname === '/v1/media/presentations') {
        mediaSignal = init?.signal;
        abortMedia?.abort(new Error('Image reading visit ended'));
        return new Response(null, { status: 503 });
      }
      if (url.pathname.endsWith('/location'))
        return missingLocation
          ? new Response(null, { status: 404 })
          : Response.json({ cursor: 'selected-reply-cursor' });
      if (url.pathname.endsWith('/reading-page')) {
        if (abortRead) {
          expect(init?.signal?.aborted).toBe(false);
          abortRead.abort(new Error('Reading visit ended'));
          expect(init?.signal?.aborted).toBe(true);
        }
        return failed ? Response.json({ code: 'invalid_cursor' }, { status: 400 }) : Response.json(response);
      }
      if (url.pathname === `/v1/threads/${threadId}`) return Response.json({ thread: response.thread });
      if (url.pathname === `/v1/boards/${boardId}`) return Response.json({});
      throw new Error(`Unexpected Kernel read: ${url.pathname}`);
    },
  });

  const page = await loadThreadPage(
    client,
    new Request(`https://web.test/threads/${threadId}/a-reading-page`),
    {},
    { id: threadId, post: replyId },
    { sitekey: '', scriptUrl: '' },
  );

  expect(paths.some((path) => path.endsWith(`/posts/${replyId}/location`))).toBe(true);
  expect(paths).toContain(`/v1/threads/${threadId}/reading-page?cursor=selected-reply-cursor`);
  expect(page).toMatchObject({ linkedPostUnavailable: false, thread: { id: threadId } });
  expect(page.posts.posts.map((post) => [post.id, 'revisionId' in post ? post.revisionId : undefined])).toEqual([
    [openingId, opening.revisionId],
    [replyId, reply.revisionId],
  ]);
  expect(page.posts.posts.map(({ body }) => body)).toEqual([opening.body, reply.body]);
  expect(page.authors?.[authorId]).toEqual(response.authors.items[0]);
  expect(page.composed).toMatchObject({
    currentness: response.currentness,
    actions: response.actions,
    reactionsAsOf: null,
  });
  expect(paths.some((path) => path.startsWith('/v1/accounts'))).toBe(false);

  // Safe native tombstones disclose no substitute author or timestamp, and sparse pages retain continuation.
  response.replies = {
    items: [
      {
        id: replyId,
        threadId,
        route: 1,
        parentId: openingId,
        availability: 'withheld',
        removed: true,
        body: null,
        sha256: null,
      },
      {
        id: '88888888-8888-4888-8888-888888888888',
        threadId,
        route: 2,
        parentId: openingId,
        availability: 'erased',
        removed: true,
        body: null,
        sha256: null,
      },
    ],
    next: 'sparse-next',
  };
  response.authors = { state: 'unavailable', retryable: true, items: [] };
  response.currentness.authors = 'unavailable';
  const unavailable = await loadThreadPage(
    client,
    new Request('https://web.test/'),
    {},
    { id: threadId },
    { sitekey: '', scriptUrl: '' },
    'anonymous',
  );
  expect(unavailable.authors).toBeNull();
  expect(unavailable.posts.next).toBe('sparse-next');
  expect(unavailable.posts.posts.slice(1)).toEqual(response.replies.items);
  expect(unavailable.posts.posts[0]?.body).toEqual(opening.body);
  missingLocation = true;
  const missing = await loadThreadPage(
    client,
    new Request('https://web.test/'),
    {},
    { id: threadId, post: replyId },
    { sitekey: '', scriptUrl: '' },
    'anonymous',
  );
  expect(missing.linkedPostUnavailable).toBe(true);
  failed = true;
  for (let retry = 0; retry < 2; retry++) {
    let failure: unknown;
    try {
      await loadThreadPage(
        client,
        new Request('https://web.test/'),
        {},
        { id: threadId, cursor: 'exact-cursor' },
        { sitekey: '', scriptUrl: '' },
        'anonymous',
      );
    } catch (error) {
      failure = error;
    }
    expect(isThreadPageCursorError(failure)).toBe(true);
  }
  expect(paths.slice(-2)).toEqual(Array(2).fill(`/v1/threads/${threadId}/reading-page?cursor=exact-cursor`));
  failed = false;
  response.thread.title = 'A changed title';
  const redirect = await loadThreadPage(
    client,
    new Request('https://web.test/'),
    {},
    { id: threadId, expectedSlug: 'a-reading-page' },
    { sitekey: '', scriptUrl: '' },
    'anonymous',
  );
  expect(redirect).toEqual({ redirect: { id: threadId, title: 'A changed title' } });

  abortRead = new AbortController();
  const request = new Request('https://web.test/', { signal: abortRead.signal });
  const beforeAbort = paths.length;
  const read = () => loadThreadPage(client, request, {}, { id: threadId }, { sitekey: '', scriptUrl: '' }, 'anonymous');
  await expect(read()).rejects.toThrow('Reading visit ended');
  expect(paths.slice(beforeAbort)).toEqual([`/v1/threads/${threadId}/reading-page`]);
  await expect(read()).rejects.toThrow('Reading visit ended');
  expect(paths).toHaveLength(beforeAbort + 1);

  abortRead = undefined;
  missingLocation = false;
  response.replies.items = [reply];
  const mediaId = '99999999-9999-4999-8999-999999999999';
  response.thread.firstPost = {
    ...opening,
    mediaIds: [mediaId],
    body: {
      ...opening.body,
      doc: {
        ...opening.body.doc,
        content: [...opening.body.doc.content!, { type: 'image', attrs: { src: mediaId, alt: 'Optional image' } }],
      },
    },
  };
  const selectedRead = (signal?: AbortSignal) =>
    loadThreadPage(
      client,
      new Request('https://web.test/', { signal }),
      {},
      { id: threadId, post: replyId },
      { sitekey: '', scriptUrl: '' },
      'anonymous',
    );
  const optionalFailure = await selectedRead();
  expect(optionalFailure.posts.posts[0]?.body).toEqual(response.thread.firstPost.body);
  expect(optionalFailure.documentMedia).toEqual({ kind: 'unavailable' });
  expect(optionalFailure.posts.next).toBe('sparse-next');
  expect(optionalFailure.linkedPostUnavailable).toBe(false);
  expect(optionalFailure.posts.posts[1]?.body).toEqual(reply.body);
  abortMedia = new AbortController();
  await expect(selectedRead(abortMedia.signal)).rejects.toThrow('Image reading visit ended');
  expect(mediaSignal?.aborted).toBe(true);
  expect(paths.slice(-4)).toEqual([
    `/v1/threads/${threadId}/posts/${replyId}/location`,
    `/v1/threads/${threadId}/reading-page?cursor=selected-reply-cursor`,
    `/v1/boards/${boardId}`,
    '/v1/media/presentations',
  ]);
});
