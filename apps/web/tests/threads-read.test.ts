import { expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardPageResponse, KernelClient } from '@rezics/client';
import { RemovedPost } from '../src/threads/post-removed';
import { loadBoardPageWithAuthors, loadThreadPageWithAuthors } from '../src/identity/page-loaders';
import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';
import { threadHref } from '../src/threads/thread-href';

type BoardResource = ReturnType<KernelClient['boards']>;
type ThreadResource = ReturnType<KernelClient['threads']>;
type Data<F extends (...args: never[]) => unknown> = NonNullable<
  Awaited<ReturnType<F>> extends { data: infer D } ? D : never
>;
type BoardRead = Data<BoardResource['get']>;
type ThreadRead = Data<ThreadResource['get']>;
type Threads = Data<BoardResource['threads']['get']>;
type Posts = Data<ThreadResource['posts']['get']>;
type Post = Posts['posts'][number];

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const metadata = {
  route: 0,
  visibility: 'published',
  securityRevision: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;
const board: BoardRead = {
  board: { ...metadata, id: id(1), title: 'Reading room', availability: 'available' },
};
const body: NonNullable<Post['body']> = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: 'heading', level: 2 }, content: [{ type: 'text', text: 'A close reading' }] },
      {
        type: 'paragraph',
        attrs: { id: 'paragraph' },
        content: [
          { type: 'text', text: 'Read the original at ' },
          {
            type: 'text',
            text: 'the library',
            marks: [{ type: 'link', attrs: { href: 'https://example.org/library' } }],
          },
        ],
      },
    ],
  },
};
function post(n: number, threadId = id(2)): Post {
  return {
    ...metadata,
    id: id(n),
    threadId,
    boardId: id(1),
    authorId: id(90),
    parentId: null,
    revisionId: id(n + 100),
    sha256: 'a'.repeat(64),
    licence: 'CC-BY-4.0',
    subjectIds: [],
    mediaIds: [],
    availability: 'available',
    body: {
      ...body,
      doc: {
        type: 'doc',
        content: [
          ...body.doc.content!,
          { type: 'paragraph', attrs: { id: `post-${n}` }, content: [{ type: 'text', text: `Contribution ${n}` }] },
        ],
      },
    },
  };
}
function thread(n: number, title: string): ThreadRead {
  return {
    thread: {
      ...metadata,
      id: id(n),
      boardId: id(1),
      authorId: id(90),
      licence: 'CC-BY-4.0',
      subjectIds: [],
      title,
      availability: 'available',
      firstPost: post(n + 10, id(n)),
    },
  };
}

const first = thread(2, 'Zebra reading');
const second = thread(3, 'Apple reading');
const last = thread(4, 'Last reading');
const erasedThread = thread(5, 'A quiet discussion');
const pageCursor = 'signed+page/next==';
const account = { id: id(90), state: 'active', displayName: 'Reader', handle: 'reader' };

function boardPage(
  values: readonly ThreadRead['thread'][],
  next: string | null = null,
  currentBoard = board.board,
): BoardPageResponse {
  return {
    board: currentBoard,
    pinRevision: '1',
    pinnedThreads: [],
    threads: values.map((thread) => ({
      thread,
      target: { kind: 'thread', id: thread.id, boardId: thread.boardId },
      authors: {
        thread: {
          state: 'available',
          id: account.id,
          kind: 'actor',
          handle: account.handle,
          displayName: account.displayName,
          automated: false,
        },
        openingPost: {
          state: 'available',
          id: account.id,
          kind: 'actor',
          handle: account.handle,
          displayName: account.displayName,
          automated: false,
        },
      },
      media: { state: 'none', images: [] },
      interaction: {
        target: { kind: 'thread', id: thread.id },
        counts: { state: 'unavailable' },
        viewer: { state: 'not-applicable' },
      },
      comments: { state: 'unavailable' },
      actions: { reply: 'allowed', react: 'allowed', share: 'available' },
    })),
    next,
    rankRefreshedAt: null,
    reactionsAsOf: null,
    viewer: { participation: 'allowed' },
    actions: { createThread: 'allowed' },
  } as unknown as BoardPageResponse;
}

test('a protected board page uses the member credential for its single opening read', async () => {
  const realmId = id(91);
  const authorization = 'Bearer realm-member';
  const reads: { path: string; authorization: string | undefined }[] = [];
  const memberThread = { id: id(92), authorId: id(90), availability: 'available' as const };
  const fakeClient = {
    boards: () => ({
      page: {
        get: async (options?: { query?: Record<string, string>; headers?: { authorization?: string } }) => {
          reads.push({ path: '/v1/boards/member/page', authorization: options?.headers?.authorization });
          expect(options?.query).toEqual({ sort: 'active' });
          return { data: boardPage([memberThread as ThreadRead['thread']], null, { ...board.board, realmId }) };
        },
      },
    }),
  } as unknown as KernelClient;

  const page = await loadBoardPageWithAuthors(fakeClient, { id: id(1) }, authorization);

  expect(page.board).toMatchObject({ id: id(1), realmId });
  expect(page.threads.threads).toEqual([memberThread]);
  expect(page.authors?.[id(90)]).toMatchObject({ state: 'available', id: id(90), displayName: 'Reader' });
  expect(reads).toEqual([{ path: '/v1/boards/member/page', authorization }]);
});

test('the Board reader retains per-card count, freshness, and action witnesses without enriching the page', async () => {
  const base = boardPage([first.thread]);
  const populatedCard = {
    ...base.threads[0]!,
    interaction: {
      target: { kind: 'thread' as const, id: first.thread.id },
      counts: { state: 'as-of' as const, values: { like: 3 }, source: { epoch: 2, position: '12' } },
      viewer: { state: 'current' as const, reaction: null },
    },
    comments: {
      state: 'current' as const,
      cohort: 'public' as const,
      count: { kind: 'lower-bound' as const, value: 4 },
      lastActivityAt: '2026-11-04T00:00:00.000Z',
      source: { epoch: 2, position: '10' },
    },
  };
  const response = { ...base, threads: [populatedCard] } as unknown as BoardPageResponse;
  const requests: string[] = [];
  const fakeClient = {
    boards: () => ({
      page: {
        get: async () => {
          requests.push('page');
          return { data: response };
        },
      },
    }),
  } as unknown as KernelClient;

  const page = await loadBoardPageWithAuthors(fakeClient, { id: id(1) });

  expect(page.openingCards[first.thread.id]).toEqual(populatedCard);
  expect(page.openingCards[first.thread.id]?.comments).toEqual(populatedCard.comments);
  expect(page.openingCards[first.thread.id]?.interaction).toEqual(populatedCard.interaction);
  expect(page.actions).toEqual(response.actions);
  expect(requests).toEqual(['page']);
});

test('a board page preserves kernel order and follows the emitted cursor', async () => {
  const requests: { path: string; query?: Record<string, string>; ids?: string }[] = [];
  let pageNumber = 0;
  const fakeClient = {
    boards: () => ({
      page: {
        get: async (options?: { query?: Record<string, string> }) => {
          requests.push({ path: `/v1/boards/${id(1)}/page`, ...(options?.query ? { query: options.query } : {}) });
          const pages = [boardPage([first.thread, second.thread], pageCursor), boardPage([last.thread])];
          return { data: pages[pageNumber++] };
        },
      },
    }),
  } as unknown as KernelClient;

  const firstPage = await loadBoardPageWithAuthors(fakeClient, { id: id(1), sort: 'new' });
  const secondPage = await loadBoardPageWithAuthors(fakeClient, {
    id: id(1),
    cursor: firstPage.threads.next ?? undefined,
    sort: 'new',
  });

  expect(firstPage.threads.threads.map((value) => value.title)).toEqual(['Zebra reading', 'Apple reading']);
  expect(firstPage.threads.next).toBe(pageCursor);
  expect(secondPage.threads.threads.map((value) => value.title)).toEqual(['Last reading']);
  expect(secondPage.threads.next).toBeNull();
  expect(requests).toEqual([
    { path: `/v1/boards/${id(1)}/page`, query: { sort: 'new' } },
    { path: `/v1/boards/${id(1)}/page`, query: { cursor: pageCursor, sort: 'new' } },
  ]);
});

test('a thread page reads native posts in order with one batched byline read and follows its cursor', async () => {
  const requests: { path: string; query?: Record<string, string>; ids?: string }[] = [];
  const author = { id: account.id, displayName: account.displayName, handle: account.handle, avatar: null };
  const pages = [
    authoredReadingPage(first.thread, [post(13)], [author]),
    authoredReadingPage(first.thread, [post(14)], [author]),
  ];
  pages[0]!.replies.next = pageCursor;
  let pageNumber = 0;
  const fakeClient = {
    threads: () => ({
      get: async () => {
        requests.push({ path: `/v1/threads/${id(2)}` });
        return { data: first };
      },
      'reading-page': {
        get: async (options?: { query?: Record<string, string> }) => {
          requests.push({
            path: `/v1/threads/${id(2)}/reading-page`,
            ...(options?.query ? { query: options.query } : {}),
          });
          return { data: pages[pageNumber++] };
        },
      },
    }),
    boards: () => ({ get: async () => ({ data: board }) }),
    accounts: {
      get: async (options?: { query?: { ids?: string } }) => {
        requests.push({ path: '/v1/accounts', ids: options?.query?.ids });
        return { data: { accounts: [account] } };
      },
    },
  } as unknown as KernelClient;
  const request = new Request('https://rezics.test/en/threads/thread');
  const verification = {} as never;

  const firstPage = await loadThreadPageWithAuthors(fakeClient, request, {}, { id: id(2) }, verification, 'anonymous');
  const secondPage = await loadThreadPageWithAuthors(
    fakeClient,
    request,
    {},
    { id: id(2), cursor: firstPage.posts.next ?? undefined },
    verification,
    'anonymous',
  );

  expect('redirect' in firstPage).toBe(false);
  if ('redirect' in firstPage) return;
  expect(firstPage.thread.title).toBe('Zebra reading');
  expect(firstPage.posts.posts.map((value) => value.id)).toEqual([first.thread.firstPost.id, id(13)]);
  expect(firstPage.posts.posts.map((value) => value.body?.doc.content?.at(-1)?.content?.[0]?.text)).toEqual([
    'Contribution 12',
    'Contribution 13',
  ]);
  expect(firstPage.posts.next).toBe(pageCursor);
  expect(secondPage.posts.posts.map((value) => value.id)).toEqual([first.thread.firstPost.id, id(14)]);
  expect(secondPage.posts.next).toBeNull();
  expect(requests.filter(({ path }) => path.endsWith('/reading-page'))).toEqual([
    { path: `/v1/threads/${id(2)}/reading-page` },
    { path: `/v1/threads/${id(2)}/reading-page`, query: { cursor: pageCursor } },
  ]);
  expect(requests.filter(({ path }) => path === '/v1/accounts')).toHaveLength(0);
  expect(firstPage.authors?.[id(90)]).toEqual(author);
});

test('an erased post has no body, byline or restore access from an arbitrary callback', async () => {
  const { authorId: _hiddenAuthor, ...publicPostFields } = post(16, id(5));
  const erased: Post = {
    ...publicPostFields,
    availability: 'erased',
    removed: true,
    sha256: null,
    body: null,
  } as Post;
  const requests: { path: string; ids?: string }[] = [];
  const fakeClient = {
    threads: () => ({
      get: async () => ({ data: erasedThread }),
      'reading-page': {
        get: async () => ({
          data: authoredReadingPage(
            { ...erasedThread.thread, firstPost: erased as typeof erasedThread.thread.firstPost },
            [],
            [],
          ),
        }),
      },
    }),
    boards: () => ({ get: async () => ({ data: board }) }),
    accounts: {
      get: async (options?: { query?: { ids?: string } }) => {
        requests.push({ path: '/v1/accounts', ids: options?.query?.ids });
        return { data: { accounts: [account] } };
      },
    },
  } as unknown as KernelClient;
  const page = await loadThreadPageWithAuthors(
    fakeClient,
    new Request('https://rezics.test/en/threads/quiet'),
    {},
    { id: id(5) },
    {} as never,
    'anonymous',
  );

  expect(page.posts.posts[0]).toMatchObject({ availability: 'erased', removed: true, body: null });
  expect(requests).toEqual([]);
  const markup = renderToStaticMarkup(
    createElement(RemovedPost, {
      post: page.posts.posts[0]!,
      authors: page.authors,
      now: '2026-02-01T00:00:00.000Z',
      anchorId: id(16),
      itemRef: null,
      menuButton: null,
      onRestore: () => undefined,
      onCopyLink: () => undefined,
    }),
  );
  expect(markup).toContain('This post was deleted.');
  expect(markup).not.toContain('>Restore</button>');
  expect(markup).not.toContain('Removed by its author');
  expect(markup).not.toContain('Contribution 16');
  expect(markup).not.toContain('reader');
});

test('only a self-deleted owner post with the original unexpired server deadline offers restore', () => {
  const now = '2026-01-15T00:00:00.000Z';
  const deadline = '2026-01-31T00:00:00.000Z';
  const clock = spyOn(Date, 'now').mockReturnValue(new Date(now).getTime());
  const erased: Post = {
    ...post(16, id(5)),
    availability: 'erased',
    removed: true,
    sha256: null,
    body: null,
    restorableUntil: deadline,
  };
  const render = (entry: Post, viewerId?: string, restore = true) =>
    renderToStaticMarkup(
      createElement(RemovedPost, {
        post: entry,
        authors: { [account.id]: account },
        now,
        ...(viewerId === undefined ? {} : { viewerId }),
        anchorId: id(16),
        itemRef: null,
        menuButton: null,
        ...(restore ? { onRestore: () => undefined } : {}),
        onCopyLink: () => undefined,
      }),
    );
  try {
    const owned = render(erased, account.id);
    expect(owned).toContain('>Restore</button>');
    expect(owned).toContain(`dateTime="${deadline}"`);
    // Even an owner tombstone must not recover the hidden body or identity from the author batch.
    for (const html of [
      owned,
      render(erased),
      render(erased, id(91)),
      render(erased, account.id, false),
      render({ ...erased, restorableUntil: now }, account.id),
      render({ ...erased, restorableUntil: '2026-01-14T23:59:59.999Z' }, account.id),
      render({ ...erased, restorableUntil: 'invalid' }, account.id),
    ]) {
      expect(html).not.toContain('Contribution 16');
      expect(html).not.toContain('reader');
      expect(html).not.toContain('Reader');
      if (html !== owned) expect(html).not.toContain('>Restore</button>');
    }
    const { restorableUntil: _deadline, ...permanent } = erased;
    expect(render(permanent, account.id)).not.toContain('>Restore</button>');
    const { authorId: _author, ...unknownOwner } = erased;
    expect(render(unknownOwner as Post, account.id)).toContain('>Restore</button>');
  } finally {
    clock.mockRestore();
  }
});

test('kernel 404s stay on the not-found boundary for board and thread route loaders', async () => {
  const missing = { error: { value: { code: 'not_found' } }, status: 404 };
  const fakeClient = {
    boards: () => ({ page: { get: async () => missing } }),
    threads: () => ({ get: async () => missing, 'reading-page': { get: async () => missing } }),
  } as unknown as KernelClient;

  await expect(loadBoardPageWithAuthors(fakeClient, { id: id(99) })).rejects.toBeTruthy();
  await expect(
    loadThreadPageWithAuthors(
      fakeClient,
      new Request(`https://rezics.test/en${threadHref({ id: id(99), title: 'Missing' })}`),
      {},
      { id: id(99) },
      {} as never,
      'anonymous',
    ),
  ).rejects.toBeTruthy();
});
