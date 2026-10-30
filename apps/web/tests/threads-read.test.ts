import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KernelClient } from '@rezics/client';
import { RemovedPost } from '../src/threads/post-removed';
import { loadBoardPageWithAuthors, loadThreadPageWithAuthors } from '../src/identity/page-loaders';
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

test('a protected board page uses the member credential for its bounded board reads', async () => {
  const realmId = id(91);
  const authorization = 'Bearer realm-member';
  const reads: { path: string; authorization: string | undefined }[] = [];
  const memberBoard = { board: { ...board.board, realmId } };
  const memberThread = { id: id(92), authorId: id(90) };
  const fakeClient = {
    boards: () => ({
      get: async (options?: { headers?: { authorization?: string } }) => {
        reads.push({ path: '/v1/boards/member', authorization: options?.headers?.authorization });
        return { data: memberBoard };
      },
      threads: {
        get: async (options?: { headers?: { authorization?: string } }) => {
          reads.push({ path: '/v1/boards/member/threads', authorization: options?.headers?.authorization });
          return { data: { threads: [memberThread], next: null } };
        },
      },
    }),
    realms: () => ({
      get: async (options?: { headers?: { authorization?: string } }) => {
        reads.push({ path: '/v1/realms/member', authorization: options?.headers?.authorization });
        return { data: { realm: { realmId, title: 'Members only' } } };
      },
    }),
    accounts: {
      get: async (options?: { query?: { ids?: string } }) => {
        reads.push({ path: `/v1/accounts?ids=${options?.query?.ids}`, authorization: undefined });
        return { data: { accounts: [account] } };
      },
    },
  } as unknown as KernelClient;

  const page = await loadBoardPageWithAuthors(fakeClient, { id: id(1) }, authorization);

  expect(page.board).toMatchObject({ id: id(1), realmId });
  expect(page.realm).toEqual({ id: realmId, title: 'Members only' });
  expect(page.threads.threads).toEqual([memberThread]);
  expect(page.authors?.[id(90)]).toEqual(account);
  expect(
    reads.filter(({ authorization: value }) => value).sort((left, right) => left.path.localeCompare(right.path)),
  ).toEqual(
    [
      { path: '/v1/boards/member', authorization },
      { path: '/v1/realms/member', authorization },
      { path: '/v1/boards/member/threads', authorization },
    ].sort((left, right) => left.path.localeCompare(right.path)),
  );
  expect(reads.filter(({ path }) => path.startsWith('/v1/accounts'))).toHaveLength(1);
});

test('a board page preserves kernel order and follows the emitted cursor', async () => {
  const requests: { path: string; query?: Record<string, string>; ids?: string }[] = [];
  let pageNumber = 0;
  const fakeClient = {
    boards: () => ({
      get: async () => ({ data: board }),
      threads: {
        get: async (options?: { query?: Record<string, string> }) => {
          requests.push({ path: '/v1/boards/board/threads', ...(options?.query ? { query: options.query } : {}) });
          const pages: Threads[] = [
            { threads: [first.thread, second.thread], next: pageCursor },
            { threads: [last.thread], next: null },
          ];
          return { data: pages[pageNumber++] };
        },
      },
    }),
    accounts: {
      get: async (options?: { query?: { ids?: string } }) => {
        requests.push({ path: '/v1/accounts', ids: options?.query?.ids });
        return { data: { accounts: [account] } };
      },
    },
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
  expect(requests.filter(({ path }) => path.endsWith('/threads'))).toEqual([
    { path: '/v1/boards/board/threads', query: {} },
    { path: '/v1/boards/board/threads', query: { cursor: pageCursor } },
  ]);
  expect(requests.filter(({ path }) => path === '/v1/accounts')).toEqual([
    { path: '/v1/accounts', ids: id(90) },
    { path: '/v1/accounts', ids: id(90) },
  ]);
});

test('a thread page reads native posts in order with one batched byline read and follows its cursor', async () => {
  const requests: { path: string; query?: Record<string, string>; ids?: string }[] = [];
  const pages: Posts[] = [
    { posts: [post(13), post(12)], next: pageCursor },
    { posts: [post(14)], next: null },
  ];
  let pageNumber = 0;
  const fakeClient = {
    threads: () => ({
      get: async () => {
        requests.push({ path: `/v1/threads/${id(2)}` });
        return { data: first };
      },
      posts: {
        get: async (options?: { query?: Record<string, string> }) => {
          requests.push({ path: `/v1/threads/${id(2)}/posts`, ...(options?.query ? { query: options.query } : {}) });
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
  expect(firstPage.posts.posts.map((value) => value.id)).toEqual([id(13), id(12)]);
  expect(firstPage.posts.posts.map((value) => value.body?.doc.content?.at(-1)?.content?.[0]?.text)).toEqual([
    'Contribution 13',
    'Contribution 12',
  ]);
  expect(firstPage.posts.next).toBe(pageCursor);
  expect(secondPage.posts.posts.map((value) => value.id)).toEqual([id(14)]);
  expect(secondPage.posts.next).toBeNull();
  expect(requests.filter(({ path }) => path.endsWith('/posts'))).toEqual([
    { path: `/v1/threads/${id(2)}/posts` },
    { path: `/v1/threads/${id(2)}/posts`, query: { cursor: pageCursor } },
  ]);
  expect(requests.filter(({ path }) => path === '/v1/accounts')).toHaveLength(2);
  expect(firstPage.authors?.[id(90)]).toEqual(account);
});

test('an erased post has no body or restored byline and keeps server-authorized restore access', async () => {
  const { authorId: _hiddenAuthor, ...publicPostFields } = post(16, id(5));
  const erased: Post = {
    ...publicPostFields,
    availability: 'erased',
    removed: true,
    sha256: null,
    body: null,
    restorableUntil: new Date(Date.now() + 60_000).toISOString(),
  } as Post;
  const requests: { path: string; ids?: string }[] = [];
  const fakeClient = {
    threads: () => ({
      get: async () => ({ data: erasedThread }),
      posts: { get: async () => ({ data: { posts: [erased], next: null } }) },
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
  expect(requests).toEqual([{ path: '/v1/accounts', ids: id(90) }]);
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
  expect(markup).toContain('>Restore</button>');
  expect(markup).not.toContain('Removed by its author');
  expect(markup).not.toContain('Contribution 16');
  expect(markup).not.toContain('reader');
});

test('kernel 404s stay on the not-found boundary for board and thread route loaders', async () => {
  const missing = { error: { value: { code: 'not_found' } }, status: 404 };
  const fakeClient = {
    boards: () => ({ get: async () => missing, threads: { get: async () => missing } }),
    threads: () => ({ get: async () => missing, posts: { get: async () => missing } }),
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
