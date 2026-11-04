import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';
import type { ReadingPage } from '../src/threads/thread-page';
import { expect, test } from 'bun:test';
import { createKernelClient, type BoardPageResponse } from '@rezics/client';
import type { SessionEnv } from '../src/session/client.ts';
import { loadBoardPageWithAuthors, loadThreadPageWithAuthors } from '../src/identity/page-loaders.ts';

const sizes = [1, 10, 100];
const boardId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const sessionId = 'a'.repeat(43);
const csrf = 'A'.repeat(22);
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const metadata = {
  route: 0,
  visibility: 'published' as const,
  securityRevision: '1',
  createdAt: '2026-10-26T00:00:00.000Z',
};
type Metrics = { K: number; D: number; R: number; A: number };

function sessionEnv(metrics: Metrics): Partial<SessionEnv> {
  const stub = {
    async credential() {
      metrics.D += 1;
      return { status: 'active', subject: id(500), accessToken: 'access', csrfToken: csrf };
    },
  };
  return {
    SITE_ORIGINS: 'https://site.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'post:create',
    WEBSITE_CLIENT_ID: 'rezics-website',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName() {
        return sessionId;
      },
      get() {
        return stub;
      },
    },
  } as unknown as Partial<SessionEnv>;
}

function pageData(size: number, authorCount: number) {
  const authors = Array.from({ length: authorCount }, (_, index) => id(600 + index));
  const posts = Array.from({ length: size }, (_, index) => ({
    ...metadata,
    id: id(800 + index),
    threadId,
    boardId,
    authorId: authors[index % authorCount]!,
    parentId: null,
    revisionId: id(1000 + index),
    sha256: 'a'.repeat(64),
    licence: 'CC-BY-4.0',
    subjectIds: [],
    mediaIds: [],
    availability: 'available' as const,
    revisedAt: null,
    voteCitation: null,
    body: {
      version: 'rezics-document-v1' as const,
      profile: 'blocks' as const,
      doc: { type: 'doc' as const, content: [] },
    },
  }));
  const threads = posts.map((post, index) => ({
    ...metadata,
    id: index === 0 ? threadId : id(1200 + index),
    boardId,
    authorId: post.authorId,
    licence: 'CC-BY-4.0',
    subjectIds: [],
    kind: 'discussion' as const,
    title: `Thread ${index}`,
    availability: 'available' as const,
    firstPost: posts[index]!,
  }));
  return { authors, posts, threads, erased: new Set<string>(), cost: { bytes: 0, rows: 0, authors: 0 } };
}

function recordingClient(
  size: number,
  authorCount: number,
  metrics: Metrics,
  calls: URL[],
  failure?: 'http' | 'network',
) {
  const data = pageData(size, authorCount);
  return {
    data,
    client: createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.startsWith('/auth/')) {
          metrics.A += 1;
          return new Response(null, { status: 404 });
        }
        metrics.K += 1;
        calls.push(url);
        if (url.pathname === `/v1/boards/${boardId}/page`) {
          const author = (
            authorId: string,
          ): Extract<BoardPageResponse['threads'][number]['authors']['thread'], { state: 'available' }> => ({
            state: 'available',
            id: authorId,
            kind: 'actor',
            handle: `author-${authorId.slice(-3)}`,
            displayName: null,
            automated: false,
          });
          const page: BoardPageResponse = {
            board: {
              ...metadata,
              id: boardId,
              title: 'Cost board',
              purpose: 'discussion',
              availability: 'available',
              realmId: null,
              community: null,
            },
            pinnedThreads: [],
            threads: data.threads.map((thread) => ({
              thread,
              target: { kind: 'thread', id: thread.id, boardId },
              authors: { thread: author(thread.authorId), openingPost: author(thread.firstPost.authorId) },
              media: { state: 'none', images: [] },
              interaction: {
                target: { kind: 'thread', id: thread.id },
                counts: { state: 'unavailable' },
                viewer: { state: 'not-applicable' },
              },
              comments: { state: 'unavailable' },
              actions: { reply: 'allowed', react: 'allowed', share: 'available' },
            })),
            next: null,
            rankRefreshedAt: null,
            reactionsAsOf: null,
            viewer: { participation: 'allowed' },
            actions: { createThread: 'allowed' },
          };
          return Response.json(page);
        }
        if (url.pathname === `/v1/threads/${threadId}/reading-page`) {
          const opening = data.threads[0]!.firstPost!;
          const selected = data.posts.filter((post) => post.id !== opening.id).slice(0, 20);
          const items = selected.map((post) =>
            data.erased.has(post.id)
              ? {
                  id: post.id,
                  threadId,
                  route: post.route,
                  parentId: post.parentId,
                  removed: true as const,
                  availability: 'erased' as const,
                  body: null,
                  sha256: null,
                }
              : post,
          );
          const disclosed = [
            ...new Set([opening, ...selected.filter((post) => !data.erased.has(post.id))].map((post) => post.authorId)),
          ];
          const page = authoredReadingPage(
            { ...data.threads[0], kind: 'discussion', title: 'Cost thread' } as ReadingPage['thread'],
            items as ReadingPage['replies']['items'],
            disclosed.map((accountId) => ({
              id: accountId,
              handle: `author-${accountId.slice(-3)}`,
              displayName: null,
              avatar: null,
            })),
          );
          if (failure) {
            page.authors = { state: 'unavailable', retryable: true, items: [] };
            page.currentness.authors = 'unavailable';
          }
          data.cost = {
            bytes: new TextEncoder().encode(JSON.stringify(page)).byteLength,
            rows: 1 + items.length,
            authors: page.authors.items.length,
          };
          return Response.json(page);
        }
        if (url.pathname === `/v1/threads/${threadId}`)
          return Response.json({
            thread: {
              ...data.threads[0],
              id: threadId,
              title: 'Cost thread',
            },
          });
        if (url.pathname === `/v1/threads/${threadId}/posts`)
          return Response.json({
            posts: data.posts.map((post) =>
              data.erased.has(post.id)
                ? {
                    id: post.id,
                    threadId,
                    route: post.route,
                    parentId: post.parentId,
                    removed: true,
                    availability: 'erased',
                    body: null,
                    sha256: null,
                  }
                : post,
            ),
            next: null,
          });
        if (url.pathname === '/v1/accounts') {
          expect(request.method).toBe('GET');
          expect(request.headers.has('authorization')).toBe(false);
          if (failure === 'network') throw new Error('Identity service unavailable');
          if (failure === 'http') return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
          const requested = url.searchParams.get('ids')?.split(',') ?? [];
          expect(requested.length).toBeGreaterThan(0);
          expect(requested.length).toBeLessThanOrEqual(100);
          return Response.json({
            accounts: requested.map((accountId) => ({
              id: accountId,
              handle: `author-${accountId.slice(-3)}`,
              displayName: null,
              state: 'active',
            })),
          });
        }
        return Response.json({ code: 'not_found' }, { status: 404 });
      },
    }),
  };
}

function signedRequest() {
  return new Request(`https://site.test/en/threads/${threadId}`, {
    headers: { cookie: `__Host-rezics_session=${sessionId}` },
  });
}

test('Board and thread pages consume composed authors with bounded thread rows', async () => {
  for (const size of sizes) {
    for (const authorCount of sizes.filter((count) => count <= size)) {
      {
        const metrics: Metrics = { K: 0, D: 0, R: 0, A: 0 };
        const calls: URL[] = [];
        const recorded = recordingClient(size, authorCount, metrics, calls);
        const page = await loadBoardPageWithAuthors(recorded.client, { id: boardId });
        const identity = calls.filter((url) => url.pathname === '/v1/accounts');
        expect(page.threads.threads).toHaveLength(size);
        expect(Object.keys(page.authors ?? {})).toHaveLength(authorCount);
        expect(identity).toHaveLength(0);
        expect(calls.map((url) => url.pathname)).toEqual([`/v1/boards/${boardId}/page`]);
        expect(metrics).toEqual({ K: 1, D: 0, R: 0, A: 0 });
      }
      {
        const metrics: Metrics = { K: 0, D: 0, R: 0, A: 0 };
        const calls: URL[] = [];
        const recorded = recordingClient(size, authorCount, metrics, calls);
        const page = await loadThreadPageWithAuthors(
          recorded.client,
          signedRequest(),
          sessionEnv(metrics),
          { id: threadId },
          { sitekey: '', scriptUrl: 'https://site.test/turnstile.js' },
        );
        const identity = calls.filter((url) => url.pathname === '/v1/accounts');
        expect(page.posts.posts).toHaveLength(Math.min(size, 21));
        expect(Object.keys(page.authors ?? {})).toHaveLength(Math.min(authorCount, 21));
        expect(identity).toHaveLength(0);
        expect(recorded.data.cost.rows).toBe(Math.min(size, 21));
        expect(recorded.data.cost.bytes).toBeLessThan(40_000);
        expect(recorded.data.cost.authors).toBeLessThanOrEqual(21);
        // Page and separate Board context; composed authors add no consumer read.
        expect(calls.filter((url) => url.pathname !== '/v1/accounts')).toHaveLength(2);
        expect(calls.filter((url) => url.pathname === `/v1/boards/${boardId}`)).toHaveLength(1);
        expect(metrics).toEqual({ K: 2, D: 1, R: 0, A: 0 });
      }
    }
  }
});

test('an empty board makes no identity read', async () => {
  const metrics: Metrics = { K: 0, D: 0, R: 0, A: 0 };
  const calls: URL[] = [];
  const recorded = recordingClient(0, 0, metrics, calls);
  const page = await loadBoardPageWithAuthors(recorded.client, { id: boardId });
  expect(page.authors).toEqual({});
  expect(calls.some((url) => url.pathname === '/v1/accounts')).toBe(false);
  expect(calls.map((url) => url.pathname)).toEqual([`/v1/boards/${boardId}/page`]);
  expect(metrics).toEqual({ K: 1, D: 0, R: 0, A: 0 });
});

test('a later thread page includes its starter and skips erased post identities', async () => {
  const metrics: Metrics = { K: 0, D: 0, R: 0, A: 0 };
  const calls: URL[] = [];
  const recorded = recordingClient(10, 10, metrics, calls);
  // The opening post and its author are not in this page of replies.
  recorded.data.posts.shift();
  recorded.data.erased.add(recorded.data.posts[0]!.id);
  const page = await loadThreadPageWithAuthors(
    recorded.client,
    signedRequest(),
    sessionEnv(metrics),
    { id: threadId, cursor: 'next-page' },
    { sitekey: '', scriptUrl: 'https://site.test/turnstile.js' },
  );
  expect(page.posts.posts).toHaveLength(10);
  const expected = recorded.data.authors.filter((_, index) => index !== 1);
  const identity = calls.filter((url) => url.pathname === '/v1/accounts');
  expect(identity).toHaveLength(0);
  expect(Object.keys(page.authors ?? {})).toEqual(expected);
  // The original opening stays present on every bounded reply page.
  expect(metrics).toEqual({ K: 2, D: 1, R: 0, A: 0 });
});

test('failed optional identities leave thread reads intact without retries; Board authors remain in its response', async () => {
  for (const failure of ['http', 'network'] as const) {
    const metrics: Metrics = { K: 0, D: 0, R: 0, A: 0 };
    const calls: URL[] = [];
    const recorded = recordingClient(10, 10, metrics, calls, failure);
    const page = await loadThreadPageWithAuthors(
      recorded.client,
      signedRequest(),
      sessionEnv(metrics),
      { id: threadId },
      { sitekey: '', scriptUrl: 'https://site.test/turnstile.js' },
    );
    expect(page.authors).toBeNull();
    expect(page.posts.posts).toHaveLength(10);
    expect(Number.isNaN(Date.parse(page.now))).toBe(false);
    expect(calls.filter((url) => url.pathname === '/v1/accounts')).toHaveLength(0);
    // The original opening stays present on every bounded reply page.
    expect(metrics).toEqual({ K: 2, D: 1, R: 0, A: 0 });
  }
});

test('unrelated post and author growth does not enlarge the selected consumer cohort', async () => {
  const cohorts = [];
  for (const size of [100, 1000]) {
    const metrics: Metrics = { K: 0, D: 0, R: 0, A: 0 };
    const calls: URL[] = [];
    const recorded = recordingClient(size, size, metrics, calls);
    const page = await loadThreadPageWithAuthors(
      recorded.client,
      signedRequest(),
      sessionEnv(metrics),
      { id: threadId },
      { sitekey: '', scriptUrl: '' },
    );
    cohorts.push({
      ...recorded.data.cost,
      requests: metrics.K,
      retainedRows: page.posts.posts.length,
      retainedAuthors: Object.keys(page.authors ?? {}).length,
    });
  }
  expect(cohorts[0]).toEqual(cohorts[1]);
  expect(cohorts[0]).toMatchObject({ requests: 2, rows: 21, authors: 21, retainedRows: 21, retainedAuthors: 21 });
});
