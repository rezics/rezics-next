import { startDevServer } from './support/dev-server.ts';
import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';
import type { ReadingPage } from '../src/threads/thread-page';
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
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
const accounts = new Map([
  [
    authors.alice,
    {
      id: authors.alice,
      handle: 'alice<script>',
      displayName: 'Alice <img src=x onerror=alert(1)>',
      state: 'active',
    },
  ],
  [authors.bob, { id: authors.bob, handle: 'bob', displayName: null, state: 'active' }],
  [authors.deleted, { id: authors.deleted, handle: null, displayName: null, state: 'deleted' }],
] as const);

function body(n: number) {
  return {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
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
    availability: 'available',
    body: body(n),
  };
}

const posts = [
  post(1, authors.alice),
  post(2, authors.bob, threadId, old),
  post(3, authors.deleted),
  post(4, authors.unknown),
];
const failedPosts = [post(5, authors.failure, failedThreadId)];
const threads = [
  {
    ...metadata,
    id: threadId,
    boardId,
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
    authorId: authors.unknown,
    licence: 'CC-BY-4.0',
    subjectIds: [],
    title: 'An unknown starter',
    availability: 'available',
    firstPost: post(9, authors.unknown, id(4)),
  },
];
const calls: { method: string; path: string; ids: string[] }[] = [];
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
    const ids = url.searchParams.get('ids')?.split(',').filter(Boolean) ?? [];
    if (url.pathname.startsWith('/v1/')) calls.push({ method: request.method, path: url.pathname, ids });
    if (request.method !== 'GET') return json(problem, 404);
    if (url.pathname === '/v1/accounts') {
      if (ids.includes(authors.failure)) return json(problem, 503);
      return json({ accounts: ids.flatMap((accountId) => (accounts.has(accountId) ? [accounts.get(accountId)] : [])) });
    }
    if (url.pathname === `/v1/boards/${boardId}`)
      return json({ board: { ...metadata, id: boardId, title: 'Reading room', availability: 'available' } });
    if (url.pathname === `/v1/boards/${boardId}/threads`) return json({ threads, next: null });
    if (url.pathname.endsWith('/reading-page')) {
      const failed = url.pathname.includes(failedThreadId);
      const selected = failed ? failedPosts : posts;
      const source = failed
        ? {
            ...threads[0],
            id: failedThreadId,
            authorId: authors.failure,
            title: 'Identity failure',
            firstPost: failedPosts[0],
          }
        : threads[0];
      const page = authoredReadingPage(
        { ...source, kind: 'discussion' } as ReadingPage['thread'],
        selected.slice(1) as ReadingPage['replies']['items'],
        [...accounts.values()].map((account) => ({
          id: account.id,
          displayName: account.displayName,
          handle: account.handle,
          avatar: null,
        })),
      );
      if (failed) {
        page.authors = { state: 'unavailable', retryable: true, items: [] };
        page.currentness.authors = 'unavailable';
      }
      return json(page);
    }
    if (url.pathname === `/v1/threads/${threadId}`) return json({ thread: threads[0] });
    if (url.pathname === `/v1/threads/${threadId}/posts`) return json({ posts, next: null });
    if (url.pathname === `/v1/threads/${failedThreadId}`)
      return json({
        thread: {
          ...threads[0],
          id: failedThreadId,
          authorId: authors.failure,
          title: 'Identity failure',
          firstPost: failedPosts[0],
        },
      });
    if (url.pathname === `/v1/threads/${failedThreadId}/posts`) return json({ posts: failedPosts, next: null });
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

test(
  "each post on a thread page shows its author and when it was posted, in the page's language",
  async () => {
    for (const locale of ['en', 'ja']) {
      const page = await open(`/${locale}/threads/${threadId}`);
      try {
        const slots = page.locator('main ol > li');
        expect(await slots.count()).toBe(4);
        expect(await slots.nth(0).innerText()).toContain('Alice <img src=x onerror=alert(1)>');
        expect(await slots.nth(0).innerText()).toContain('@alice<script>');
        expect(await slots.nth(1).innerText()).toContain('@bob');
        const times = page.locator('main ol > li time');
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
    const page = await open(`/en/boards/${boardId}`);
    try {
      const items = page.locator('main ul > li');
      expect(await items.count()).toBe(3);
      expect(await items.nth(0).innerText()).toContain('Alice <img src=x onerror=alert(1)>');
      expect(await items.nth(0).innerText()).toContain(expectedRecent('en'));
      expect(await items.nth(1).innerText()).toContain('@bob');
      expect(await items.nth(1).innerText()).toContain(
        new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(old)),
      );
      expect(await items.nth(2).innerText()).toContain('Unknown account');
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
    const identity = calls.filter((call) => call.path === '/v1/accounts');
    expect(identity).toHaveLength(0);
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
        const slots = page.locator('main ol > li');
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
    const page = await open(`/en/threads/${failedThreadId}`);
    try {
      expect(await page.locator('main').innerText()).toContain('Contribution 5');
      expect(await page.locator('main time').count()).toBe(1);
      expect(await page.locator('main').innerText()).not.toContain('Unknown account');
      expect(await page.locator('main').innerText()).not.toContain('@');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
