import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { DocumentNode } from '@rezics/document';
import { renderToStaticMarkup } from 'react-dom/server';
import { boardOpeningExample, boardOpeningId } from '../src/threads/board-opening-fixtures';
import { receiveBoardOpeningPage } from '../src/threads/board-opening';
import { boardPinAdviceSelection } from '../src/threads/board-feed-data';
import { receiveBoardPinAdvice } from '../src/threads/board-pins/advice';
import { boardRequestHref, boardRowReturn } from '../src/threads/board-navigation';
import { loadThreadPage } from '../src/threads/thread-page';
import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';
import { documentImagesForPost } from '../src/threads/document-media-read';
import { threadLocation } from '../src/threads/thread-href';
import { ThreadReviewContext } from '../src/threads/thread-review-context';
import { setLocale } from '../src/paraglide/runtime.js';

const mediaId = '99999999-9999-4999-8999-999999999999';
const questionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const subjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function readingFor(card: ReturnType<typeof receiveBoardOpeningPage>['openingCards'][string], cursor: string | null) {
  const thread = card.thread;
  const opening = thread.firstPost;
  if (opening.availability !== 'available') throw new Error('Expected an available opening.');
  const mention: DocumentNode = {
    type: 'paragraph',
    content: [{ type: 'mention', attrs: { accountId: opening.authorId } }],
  };
  const body = {
    ...opening.body,
    doc: { ...opening.body.doc, content: [...(opening.body.doc.content ?? []), mention] },
  };
  const firstPost = {
    ...opening,
    mediaIds: [mediaId],
    body: {
      ...body,
      doc: {
        ...body.doc,
        content: [...body.doc.content!, { type: 'image', attrs: { src: mediaId, alt: 'Optional image' } }],
      },
    },
  };
  const image = {
    id: mediaId,
    containerId: thread.id,
    digest: 'a'.repeat(64),
    width: 640,
    height: 480,
    variants: [{ format: 'webp' as const, width: 640, height: 480 }],
    placeholder: null,
    focalPoint: null,
    credit: {
      rightsHolder: 'Ada',
      via: { name: 'Ada', url: 'https://example.test/ada' },
      license: 'CC-BY-4.0',
      obligations: ['cc:Attribution' as const],
    },
  };
  const page = authoredReadingPage({ ...thread, firstPost }, [], [
    { id: opening.authorId, displayName: 'Disclosed author', handle: 'disclosed-author', avatar: null },
  ]);
  page.query.cursor = cursor;
  page.mentions = {
    state: 'current',
    retryable: false,
    overflow: false,
    sources: [
      {
        postId: opening.id,
        threadId: thread.id,
        revisionId: opening.revisionId,
        sha256: opening.sha256,
        pageIndex: 0,
        references: [opening.authorId],
        overflow: false,
      },
    ],
    identities: [
      { id: opening.authorId, state: 'active', handle: 'disclosed-author' },
      { id: opening.authorId, state: 'concealed' },
    ],
  };
  page.documentMedia = {
    state: 'available',
    documents: [
      {
        postId: opening.id,
        threadId: thread.id,
        revisionId: opening.revisionId,
        sha256: opening.sha256,
        state: 'available',
        images: [
          { id: mediaId, state: 'unavailable' },
          { id: mediaId, state: 'available', presentation: image },
        ],
      },
    ],
  };
  page.conversationActivity = {
    state: 'current',
    cohort: 'public',
    count: { kind: 'exact', value: 0 },
    lastActivityAt: null,
  };
  page.reviewContext = {
    source: { threadId: thread.id, postId: opening.id, revisionId: opening.revisionId },
    target: {
      state: 'available',
      subject: { id: subjectId, kind: 'visualNovel', label: { value: 'Reviewed work', language: 'en' } },
    },
    citations: {
      state: 'current',
      items: [
        {
          postId: opening.id,
          sourceRevisionId: opening.revisionId,
          citation: {
            state: 'available',
            questionId,
            units: 0,
            voteRevision: 1,
            metadata: { state: 'unavailable' },
          },
        },
      ],
    },
  };
  return { page, image, firstPost };
}

test('selected Board pin advice and an admitted generation open ReadingPage projections and return to the original row', async () => {
  setLocale('en', { reload: false });
  const response = boardOpeningExample('current', 6);
  const opening = receiveBoardOpeningPage(response);
  expect(opening.threads.pinRevision).toBe('1');
  const selection = boardPinAdviceSelection(opening.board.id, opening.threads);
  expect(selection?.pinRevision).toBe('1');
  expect(selection?.selected.map((item) => item.threadId)).toEqual([
    ...opening.threads.pinnedThreads.map((thread) => thread.id),
    ...opening.threads.threads.map((thread) => thread.id),
  ]);
  const pinned = opening.threads.pinnedThreads[0]!;
  expect(selection?.selected[0]).toEqual({
    threadId: pinned.id,
    placeId: boardOpeningId,
    sourceRevisionId: pinned.firstPost.availability === 'available' ? pinned.firstPost.revisionId : '',
  });
  const advice = receiveBoardPinAdvice(
    {
      boardId: boardOpeningId,
      viewerId: '01a17a3b-09b4-77bf-a24b-1234ebeab5b6',
      selected: selection!.selected,
      pinRevision: selection!.pinRevision,
      signal: new AbortController().signal,
    },
    200,
    {
      state: 'ready',
      viewer: { kind: 'account', id: '01a17a3b-09b4-77bf-a24b-1234ebeab5b6' },
      boardId: boardOpeningId,
      pinRevision: '1',
      management: 'allowed',
      threads: selection!.selected.map((item, index) => ({
        threadId: item.threadId,
        pinned: index === 0,
        actions: index === 0 ? ['unpin'] : ['pin'],
      })),
    },
  );
  expect(advice).toMatchObject({ state: 'ready', pinRevision: '1', management: 'allowed' });
  if (advice.state !== 'ready') throw new Error('Expected admitted pin advice.');

  const card = opening.openingCards[pinned.id]!;
  const { page, image, firstPost } = readingFor(card, opening.threads.next);
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input) => {
      const url = new URL(new Request(input).url);
      paths.push(url.pathname);
      if (url.pathname.endsWith('/reading-page')) return Response.json(page);
      if (url.pathname === `/v1/boards/${boardOpeningId}`) return Response.json({});
      throw new Error(`Unexpected Kernel read: ${url.pathname}`);
    },
  });
  const loaded = await loadThreadPage(
    client,
    new Request(`https://web.test/threads/${pinned.id}/discussion-0`),
    {},
    { id: pinned.id },
    { sitekey: '', scriptUrl: '' },
    'anonymous',
  );
  expect(paths).toEqual([`/v1/threads/${pinned.id}/reading-page`, `/v1/boards/${boardOpeningId}`]);
  expect(loaded.mentions).toEqual({ [firstPost.authorId]: { handle: 'disclosed-author' } });
  expect(loaded.documentMedia?.kind).toBe('ready');
  expect(documentImagesForPost(loaded.documentMedia, loaded.posts.posts[0]!, 0)).toEqual(new Map([[mediaId, image]]));
  expect(loaded.reviewContext).toEqual(page.reviewContext);
  expect(loaded.conversationActivity).toEqual({
    state: 'current',
    count: { kind: 'exact', value: 0 },
    lastActivityAt: null,
  });
  expect(loaded.posts.posts[0]?.body).toEqual(firstPost.body);

  const origin = boardRowReturn(
    {
      version: 1,
      locale: 'en',
      boardId: boardOpeningId,
      sort: 'new',
      cursor: opening.threads.next ?? undefined,
    },
    pinned.id,
    { section: 'pinned', index: 0 },
    { href: boardRequestHref('en', boardOpeningId, { sort: 'new', cursor: opening.threads.next ?? undefined }) },
  );
  expect(origin).toContain(`/en/boards/${boardOpeningId}`);
  expect(origin).toContain('sort=new');
  expect(origin).toContain(`#board-thread-${pinned.id}--pinned-0`);
  const href = threadLocation('en', { id: pinned.id, title: pinned.title }, undefined, firstPost.id, undefined, origin);
  expect(href).toContain('boardReturn=');
  expect(href).toContain(`post=${firstPost.id}`);
  expect(href.endsWith(`#post-${firstPost.id}`)).toBe(true);

  const html = renderToStaticMarkup(
    <ThreadReviewContext
      context={loaded.reviewContext}
      thread={loaded.thread}
      posts={loaded.posts.posts}
      cursor={loaded.composed?.query.cursor}
      boardReturn={origin}
      locale="en"
    />,
  );
  expect(html).toContain(`data-review-subject="${subjectId}"`);
  expect(html).toContain(`href="/en/posts/${firstPost.id}/revisions/${firstPost.revisionId}"`);
  expect(html).toContain('data-cited-value="0"');
});
