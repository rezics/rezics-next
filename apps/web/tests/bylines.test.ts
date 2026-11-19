import { startDevServer } from './support/dev-server.ts';
import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';
import type { BoardPageResponse } from '@rezics/client';
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';

const timeout = 300_000;
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const boardId = id(1);
const threadId = id(2);
const failedThreadId = id(6);
const recent = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
const old = '2025-01-02T03:04:05.000Z';
const metadata = {
  route: 0,
  visibility: 'published',
  securityRevision: '1',
  createdAt: recent,
} as const;
const authors = {
  alice: id(90),
  bob: id(91),
  deleted: id(92),
  unknown: id(93),
  failure: id(94),
} as const;
const accounts = new Map<string, { handle: string; displayName: string | null }>([
  [
    authors.alice,
    {
      handle: 'alice<script>',
      displayName: 'Alice <img src=x onerror=alert(1)>',
    },
  ],
  [authors.bob, { handle: 'bob', displayName: null }],
]);

function body(n: number) {
  return {
    version: 'rezics-document-v1' as const,
    profile: 'blocks' as const,
    doc: {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          attrs: { id: `post-${n}` },
          content: [{ type: 'text', text: `Contribution ${n}` }],
        },
      ],
    },
  };
}

function post(n: number, authorId: string, ownerThreadId = threadId, createdAt = recent) {
  return {
    ...metadata,
    createdAt,
    id: id(10 + n),
    threadId: ownerThreadId,
    boardId,
    authorId,
    parentId: null,
    revisionId: id(110 + n),
    sha256: 'a'.repeat(64),
    licence: 'CC-BY-4.0',
    subjectIds: [],
    mediaIds: [],
    availability: 'available' as const,
    revisedAt: null,
    voteCitation: null,
    body: body(n),
  };
}

const posts = [
  post(1, authors.alice),
  post(2, authors.bob, threadId, old),
  post(3, authors.deleted),
  post(4, authors.unknown),
] as const;
const threads = [
  {
    ...metadata,
    id: threadId,
    boardId,
    kind: 'discussion',
    authorId: authors.alice,
    licence: 'CC-BY-4.0',
    subjectIds: [],
    title: 'A first discussion',
    availability: 'available',
    firstPost: posts[0],
  },
  {
    ...metadata,
    createdAt: old,
    id: id(3),
    boardId,
    kind: 'discussion',
    authorId: authors.bob,
    licence: 'CC-BY-4.0',
    subjectIds: [],
    title: 'A second discussion',
    availability: 'available',
    firstPost: post(8, authors.bob, id(3), old),
  },
  {
    ...metadata,
    id: id(4),
    boardId,
    kind: 'discussion',
    authorId: authors.unknown,
    licence: 'CC-BY-4.0',
    subjectIds: [],
    title: 'An unknown starter',
    availability: 'available',
    firstPost: post(9, authors.unknown, id(4)),
  },
] as const;
const failedThread = {
  ...threads[0],
  id: failedThreadId,
  authorId: authors.failure,
  title: 'Identity failure',
  firstPost: post(5, authors.failure, failedThreadId),
};
const board = {
  ...metadata,
  id: boardId,
  title: 'Reading room',
  purpose: 'discussion',
  availability: 'available',
  realmId: null,
  community: null,
} as const;

function boardAuthor(id: string): BoardPageResponse['threads'][number]['authors']['thread'] {
  const account = accounts.get(id);
  return account ? { state: 'available', id, kind: 'actor', automated: false, ...account } : { state: 'unavailable' };
}

const boardPage: BoardPageResponse = {
  board,
  pinRevision: '1',
  pinnedThreads: [],
  threads: threads.map((thread) => ({
    thread,
    target: { kind: 'thread', id: thread.id, boardId },
    authors: { thread: boardAuthor(thread.authorId), openingPost: boardAuthor(thread.firstPost.authorId) },
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
const calls: string[] = [];
const problem = {
  type: 'https://rezics.com/problems/dependency_unavailable',
  title: 'Dependency Unavailable',
  status: 503,
  code: 'dependency_unavailable',
  retryable: true,
  effect_status: 'not_applicable',
  request_id: randomUUID(),
};
const json = (value: unknown, status = 200) => Response.json(value, { status });

const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer: `${url.origin}/auth`,
        authorization_endpoint: `${url.origin}/auth/authorize`,
        token_endpoint: `${url.origin}/auth/token`,
        jwks_uri: `${url.origin}/auth/jwks`,
        revocation_endpoint: `${url.origin}/auth/revoke`,
        end_session_endpoint: `${url.origin}/auth/end-session`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    if (url.pathname === '/auth/jwks') return json({ keys: [issuerJwk] });
    if (url.pathname.startsWith('/v1/')) calls.push(url.pathname);
    if (request.method !== 'GET') return json(problem, 404);
    if (url.pathname === `/v1/boards/${boardId}`) return json({ board });
    if (url.pathname === `/v1/boards/${boardId}/page`) return json(boardPage);
    // The canonical thread route checks its slug against this read.
    if (url.pathname === `/v1/threads/${threadId}`) return json({ thread: threads[0] });
    if (url.pathname === `/v1/threads/${failedThreadId}`) return json({ thread: failedThread });
    const failed = url.pathname === `/v1/threads/${failedThreadId}/reading-page`;
    if (failed || url.pathname === `/v1/threads/${threadId}/reading-page`) {
      const page = authoredReadingPage(
        failed ? failedThread : threads[0],
        failed ? [] : posts.slice(1),
        failed ? [] : [...accounts].map(([id, account]) => ({ id, ...account, avatar: null })),
      );
      if (failed) {
        page.authors = { state: 'unavailable', retryable: true, items: [] };
        page.currentness.authors = 'unavailable';
      }
      return json(page);
    }
    return json(problem, 404);
  },
});

let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
let started: Promise<string> | undefined;

function site(): Promise<string> {
  started ??= startDevServer({
    env: {
      KERNEL_ORIGIN: fake.url.origin,
      AUTH_ISSUER: `${fake.url.origin}/auth`,
      WEBSITE_CLIENT_ID: 'rezics-website',
      WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
      API_RESOURCE: 'https://api.rezics.test',
      WEBSITE_SCOPES: 'media:create media:read',
    },
    warmUpPaths: [],
  }).then((running) => {
    server = running;
    return running.origin;
  });
  return started;
}

let browser: Browser | undefined;
async function open(path: string): Promise<Page> {
  browser ??= await chromium.launch();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${await site()}${path}`, { waitUntil: 'load' });
  return page;
}

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  await server?.stop();
});

function expectedRecent(locale: string) {
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-3, 'hour');
}

function postBylines(page: Page) {
  return page.locator('main [data-slot="post-reading-identity"]');
}

test(
  "each post on a thread page shows its author and when it was posted, in the page's language",
  async () => {
    for (const locale of ['en', 'ja']) {
      const page = await open(`/${locale}/threads/${threadId}`);
      try {
        const slots = postBylines(page);
        expect(await slots.count()).toBe(4);
        expect(await slots.nth(0).innerText()).toContain('Alice <img src=x onerror=alert(1)>');
        expect(await slots.nth(0).innerText()).toContain('@alice<script>');
        expect(await slots.nth(1).innerText()).toContain('@bob');
        const times = slots.locator('time');
        expect(await times.count()).toBe(4);
        expect(await times.nth(0).getAttribute('datetime')).toBe(recent);
        expect(await times.nth(0).innerText()).toBe(expectedRecent(locale));
        expect(await times.nth(1).innerText()).toBe(
          new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(old)),
        );
        expect(await times.nth(1).getAttribute('title')).toBe(
          new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(
            new Date(old),
          ),
        );
        expect(await slots.nth(0).locator('img, script').count()).toBe(0);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  "a board's thread list shows who started each thread and when",
  async () => {
    calls.length = 0;
    const page = await open(`/en/boards/${boardId}`);
    try {
      const items = page.locator('main li[data-thread-id] > [data-slot="board-thread-meta"]');
      expect(await items.count()).toBe(3);
      expect(await items.nth(0).innerText()).toContain('Alice <img src=x onerror=alert(1)>');
      expect(await items.nth(0).innerText()).toContain(expectedRecent('en'));
      expect(await items.nth(1).innerText()).toContain('@bob');
      expect(await items.nth(1).innerText()).toContain(
        new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(old)),
      );
      expect(await items.nth(2).innerText()).toContain('Unknown account');
      expect(calls).not.toContain('/v1/accounts');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test('a thread page receives composed authors without an account batch', async () => {
  calls.length = 0;
  const page = await open(`/en/threads/${threadId}`);
  try {
    expect(calls).toContain(`/v1/threads/${threadId}/reading-page`);
    expect(calls).not.toContain('/v1/accounts');
  } finally {
    await page.context().close();
  }
});

test(
  'a deleted or unknown author is shown without a handle',
  async () => {
    for (const [locale, deleted, unknown] of [
      ['en', 'Unknown account', 'Unknown account'],
      ['ja', '不明なアカウント', '不明なアカウント'],
    ] as const) {
      const page = await open(`/${locale}/threads/${threadId}`);
      try {
        const slots = postBylines(page);
        expect(await slots.nth(2).innerText()).toContain(deleted);
        expect(await slots.nth(3).innerText()).toContain(unknown);
        expect(await slots.nth(2).innerText()).not.toContain('@');
        expect(await slots.nth(3).innerText()).not.toContain('@');
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'when the identity read fails, the page still shows its posts',
  async () => {
    calls.length = 0;
    const page = await open(`/en/threads/${failedThreadId}`);
    try {
      expect(await page.locator('main').innerText()).toContain('Contribution 5');
      const byline = postBylines(page);
      expect(await byline.locator('time').count()).toBe(1);
      expect(await byline.innerText()).not.toContain('Unknown account');
      expect(await byline.innerText()).not.toContain('@');
      expect(calls).not.toContain('/v1/accounts');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
