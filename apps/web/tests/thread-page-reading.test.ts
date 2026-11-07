import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { fromPlainText, type DocumentNode } from '@rezics/document';
import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';
import type { ReadingPage } from '../src/threads/thread-page';
import { isThreadPageCursorError, loadThreadPage } from '../src/threads/thread-page';
import { documentImagesForPost, receiveThreadDocumentMedia } from '../src/threads/document-media-read';
import { mentionsForThreadPost } from '../src/threads/thread-page-context';

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
  opening.body = {
    ...opening.body,
    doc: {
      ...opening.body.doc,
      content: [
        ...(opening.body.doc.content ?? []),
        { type: 'paragraph', content: [{ type: 'mention', attrs: { accountId: authorId } }] } satisfies DocumentNode,
      ],
    },
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
    [{ id: authorId, displayName: 'Disclosed author', handle: 'disclosed-author', avatar: null }],
  );
  response.mentions = {
    state: 'current',
    retryable: false,
    overflow: false,
    sources: [
      {
        postId: openingId,
        threadId,
        revisionId: opening.revisionId,
        sha256: opening.sha256,
        pageIndex: 0,
        references: [authorId],
        overflow: false,
      },
    ],
    identities: [
      { id: authorId, state: 'active', handle: 'disclosed-author' },
      { id: boardId, state: 'active', handle: 'unrelated' },
    ],
  };
  response.conversationActivity = {
    state: 'current',
    cohort: 'public',
    count: { kind: 'exact', value: 0 },
    lastActivityAt: null,
  };
  response.reviewContext = {
    source: { threadId, postId: openingId, revisionId: opening.revisionId },
    target: {
      state: 'available',
      subject: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        kind: 'visualNovel',
        label: { value: 'Reviewed work', language: 'en' },
      },
    },
    citations: {
      state: 'current',
      items: [
        {
          postId: openingId,
          sourceRevisionId: opening.revisionId,
          citation: {
            state: 'available',
            questionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            units: 0,
            voteRevision: 2,
            metadata: { state: 'unavailable' },
          },
        },
      ],
    },
  };
  const paths: string[] = [];
  let failed = false;
  let missingLocation = false;
  let abortRead: AbortController | undefined;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      paths.push(`${url.pathname}${url.search}`);
      expect(new Request(input, init).headers.has('authorization')).toBe(false);
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
  expect(page.mentions).toEqual({ [authorId]: { handle: 'disclosed-author' } });
  expect(page.mentionProjection).toEqual(response.mentions);
  expect(mentionsForThreadPost(page.documentMentions!, { ...opening, revisionId: reply.revisionId }, 0)).toEqual({});
  expect(page.reviewContext).toEqual(response.reviewContext);
  expect(page.conversationActivity).toEqual({
    state: 'current',
    count: { kind: 'exact', value: 0 },
    lastActivityAt: null,
  });
  expect(paths.some((path) => path.startsWith('/v1/accounts'))).toBe(false);
  expect(paths.some((path) => path.startsWith('/v1/media/presentations'))).toBe(false);

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
  const image = {
    id: mediaId,
    containerId: threadId,
    digest: 'a'.repeat(64),
    width: 640,
    height: 480,
    variants: [{ format: 'webp' as const, width: 640, height: 480 }],
    placeholder: null,
    focalPoint: null,
    credit: null,
  };
  response.documentMedia = {
    state: 'available',
    documents: [
      {
        postId: openingId,
        threadId,
        revisionId: opening.revisionId,
        sha256: opening.sha256,
        state: 'available',
        images: [{ id: mediaId, state: 'available', presentation: image }],
      },
    ],
  };
  expect(
    receiveThreadDocumentMedia(response.documentMedia, [
      {
        id: openingId,
        threadId,
        route: 0,
        parentId: null,
        removed: true,
        availability: 'erased',
        body: null,
        sha256: null,
      },
      reply,
    ]),
  ).toEqual({ kind: 'ready', images: [], documents: [] });
  expect(
    receiveThreadDocumentMedia(
      {
        state: 'available',
        documents: [{ ...response.documentMedia.documents[0]!, state: 'unavailable', images: [] }],
      },
      [opening, reply],
    ),
  ).toEqual({ kind: 'ready', images: [], documents: [] });
  const mixedUnavailable = {
    id: mediaId,
    state: 'unavailable' as const,
  };
  const mixedAvailable = {
    id: mediaId,
    state: 'available' as const,
    presentation: image,
  };
  expect(
    receiveThreadDocumentMedia(
      {
        state: 'available',
        documents: [
          {
            ...response.documentMedia.documents[0]!,
            images: [mixedUnavailable, mixedAvailable],
          },
        ],
      },
      [
        {
          ...opening,
          mediaIds: [mediaId],
          body: response.thread.firstPost.body,
        },
        reply,
      ],
    ),
  ).toEqual({
    kind: 'ready',
    images: [image],
    documents: [
      {
        pageIndex: 0,
        postId: openingId,
        threadId,
        revisionId: opening.revisionId,
        sha256: opening.sha256,
        mediaIds: [mediaId],
      },
    ],
  });
  const selectedRead = (signal?: AbortSignal) =>
    loadThreadPage(
      client,
      new Request('https://web.test/', { signal: signal ?? null }),
      {},
      { id: threadId, post: replyId },
      { sitekey: '', scriptUrl: '' },
      'anonymous',
    );
  const optionalFailure = await selectedRead();
  expect(optionalFailure.posts.posts[0]?.body).toEqual(response.thread.firstPost.body);
  expect(optionalFailure.documentMedia?.kind).toBe('ready');
  expect(optionalFailure.documentMediaProjection).toEqual(response.documentMedia);
  expect(documentImagesForPost(optionalFailure.documentMedia, optionalFailure.posts.posts[0]!, 0)).toEqual(
    new Map([[mediaId, image]]),
  );
  expect(documentImagesForPost(optionalFailure.documentMedia, optionalFailure.posts.posts[0]!, 1)).toEqual(new Map());
  const exactPost = optionalFailure.posts.posts[0];
  if (exactPost?.availability !== 'available') throw new Error('Expected the admitted opening post.');
  expect(
    documentImagesForPost(
      optionalFailure.documentMedia,
      {
        ...exactPost,
        revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
      0,
    ),
  ).toEqual(new Map());
  expect(optionalFailure.posts.next).toBe('sparse-next');
  expect(optionalFailure.linkedPostUnavailable).toBe(false);
  expect(optionalFailure.posts.posts[1]?.body).toEqual(reply.body);
  expect(paths.some((path) => path.startsWith('/v1/media/'))).toBe(false);
  abortRead = new AbortController();
  await expect(selectedRead(abortRead.signal)).rejects.toThrow('Reading visit ended');
  expect(paths.slice(-2)).toEqual([
    `/v1/threads/${threadId}/posts/${replyId}/location`,
    `/v1/threads/${threadId}/reading-page?cursor=selected-reply-cursor`,
  ]);
});
