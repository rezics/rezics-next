import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
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
  visibility: 'published',
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
    availability: 'available',
    body: {
      version: 'rezics-document-v1',
      profile: 'blocks',
      doc: { type: 'doc', content: [] },
    },
  }));
  const threads = posts.map((post, index) => ({
    ...metadata,
    id: index === 0 ? threadId : id(1200 + index),
    boardId,
    authorId: post.authorId,
    licence: 'CC-BY-4.0',
    subjectIds: [],
    title: `Thread ${index}`,
    availability: 'available',
    firstPost: posts[index],
  }));
  return { authors, posts, threads, erased: new Set<string>() };
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
        if (url.pathname === `/v1/boards/${boardId}`)
          return Response.json({
            board: { ...metadata, id: boardId, title: 'Cost board', availability: 'available' },
          });
        if (url.pathname === `/v1/boards/${boardId}/threads`)
          return Response.json({ threads: data.threads, next: null });
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

test('a thread or board page reads its authors in one request at every size', async () => {
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
        expect(identity).toHaveLength(1);
        expect(identity[0]?.searchParams.get('ids')?.split(',')).toEqual(recorded.data.authors);
        expect(calls.filter((url) => url.pathname !== '/v1/accounts')).toHaveLength(2);
        expect(metrics).toEqual({ K: 3, D: 0, R: 0, A: 0 });
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
        expect(page.posts.posts).toHaveLength(size);
        expect(Object.keys(page.authors ?? {})).toHaveLength(authorCount);
        expect(identity).toHaveLength(1);
        expect(identity[0]?.searchParams.get('ids')?.split(',')).toEqual(recorded.data.authors);
        // Thread context brief (8dd1eb27ce), Cost: "One added read per page view, independent of the number of posts."
        expect(calls.filter((url) => url.pathname !== '/v1/accounts')).toHaveLength(3);
        expect(calls.filter((url) => url.pathname === `/v1/boards/${boardId}`)).toHaveLength(1);
        expect(metrics).toEqual({ K: 4, D: 1, R: 0, A: 0 });
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
  expect(metrics).toEqual({ K: 2, D: 0, R: 0, A: 0 });
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
  expect(page.posts.posts).toHaveLength(9);
  const expected = recorded.data.authors.filter((_, index) => index !== 1);
  const identity = calls.filter((url) => url.pathname === '/v1/accounts');
  expect(identity).toHaveLength(1);
  expect(identity[0]?.searchParams.get('ids')?.split(',')).toEqual(expected);
  // Thread context brief (8dd1eb27ce), Cost: "One added read per page view, independent of the number of posts."
  expect(metrics).toEqual({ K: 4, D: 1, R: 0, A: 0 });
});

test('failed optional identities leave both page reads intact without retries', async () => {
  for (const failure of ['http', 'network'] as const) {
    for (const kind of ['board', 'thread'] as const) {
      const metrics: Metrics = { K: 0, D: 0, R: 0, A: 0 };
      const calls: URL[] = [];
      const recorded = recordingClient(10, 10, metrics, calls, failure);
      const page =
        kind === 'board'
          ? await loadBoardPageWithAuthors(recorded.client, { id: boardId })
          : await loadThreadPageWithAuthors(
              recorded.client,
              signedRequest(),
              sessionEnv(metrics),
              { id: threadId },
              { sitekey: '', scriptUrl: 'https://site.test/turnstile.js' },
            );
      expect(page.authors).toBeNull();
      expect('posts' in page ? page.posts.posts : page.threads.threads).toHaveLength(10);
      expect(Number.isNaN(Date.parse(page.now))).toBe(false);
      expect(calls.filter((url) => url.pathname === '/v1/accounts')).toHaveLength(1);
      // Thread context brief (8dd1eb27ce), Cost: "One added read per page view, independent of the number of posts."
      expect(metrics).toEqual({ K: kind === 'thread' ? 4 : 3, D: kind === 'thread' ? 1 : 0, R: 0, A: 0 });
    }
  }
});
