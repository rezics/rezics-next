import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
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
const realmId = id(10);
const brokenRealmId = id(11);
const missingRealmId = id(12);
const realmBoardId = id(20);
const plainBoardId = id(21);
const brokenBoardId = id(22);
const missingBoardId = id(23);
const shortThreadId = id(30);
const longThreadId = id(31);
const plainThreadId = id(32);
const brokenThreadId = id(33);
const longPostCount = 25;
const author = id(90);
const metadata = {
  route: 0,
  visibility: 'published',
  securityRevision: '1',
  createdAt: '2026-10-26T00:00:00.000Z',
} as const;
const boards = new Map([
  [realmBoardId, { title: 'Reading room', realmId }],
  [plainBoardId, { title: 'Open floor', realmId: null }],
  [brokenBoardId, { title: 'Back room', realmId: brokenRealmId }],
  [missingBoardId, { title: 'Side room', realmId: missingRealmId }],
]);
const threadBoards = new Map([
  [shortThreadId, realmBoardId],
  [longThreadId, realmBoardId],
  [plainThreadId, plainBoardId],
  [brokenThreadId, brokenBoardId],
]);
const calls: { method: string; path: string; language: string | null }[] = [];
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

function post(threadId: string, boardId: string, n: number) {
  return {
    ...metadata,
    id: id(1000 + n),
    threadId,
    boardId,
    authorId: author,
    parentId: null,
    revisionId: id(2000 + n),
    sha256: 'a'.repeat(64),
    licence: 'CC-BY-4.0',
    subjectIds: [],
    mediaIds: [],
    availability: 'available',
    body: {
      version: 'rezics-document-v1',
      profile: 'blocks',
      doc: {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { id: `p-${n}` }, content: [{ type: 'text', text: `Contribution ${n}` }] },
        ],
      },
    },
  };
}

function thread(threadId: string, boardId: string, title: string) {
  return {
    ...metadata,
    id: threadId,
    boardId,
    authorId: author,
    licence: 'CC-BY-4.0',
    subjectIds: [],
    title,
    availability: 'available',
    firstPost: post(threadId, boardId, 1),
  };
}

const titles = new Map([
  [shortThreadId, 'A short thread'],
  [longThreadId, 'A long thread'],
  [plainThreadId, 'A plain thread'],
  [brokenThreadId, 'A thread beside a broken Realm'],
]);

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
    if (url.pathname.startsWith('/v1/'))
      calls.push({ method: request.method, path: url.pathname, language: request.headers.get('accept-language') });
    if (request.method !== 'GET') return json(problem, 404);
    if (url.pathname === '/v1/accounts')
      return json({ accounts: [{ id: author, handle: 'reader', displayName: null, state: 'active' }] });
    const board = /^\/v1\/boards\/([^/]+)$/.exec(url.pathname);
    if (board?.[1] && boards.has(board[1]))
      return json({
        board: { ...metadata, id: board[1], purpose: 'discussion', availability: 'available', ...boards.get(board[1]) },
      });
    const boardThreads = /^\/v1\/boards\/([^/]+)\/threads$/.exec(url.pathname);
    if (boardThreads?.[1] && boards.has(boardThreads[1])) {
      const own = [...threadBoards].filter(([, boardId]) => boardId === boardThreads[1]);
      return json({
        threads: own.map(([threadId, boardId]) => thread(threadId, boardId, titles.get(threadId)!)),
        next: null,
      });
    }
    if (url.pathname === `/v1/realms/${realmId}`) {
      const language = request.headers.get('accept-language') ?? '';
      return json({
        realm: {
          realmId,
          spaceId: id(13),
          state: 'active',
          visibility: 'public',
          title: language.startsWith('zh-Hans') ? '读书俱乐部' : 'Book Club',
          summary: '',
          votes: {},
        },
      });
    }
    if (url.pathname === `/v1/realms/${brokenRealmId}`) return json(problem, 503);
    const owned = /^\/v1\/threads\/([^/]+)$/.exec(url.pathname);
    if (owned?.[1] && threadBoards.has(owned[1]))
      return json({ thread: thread(owned[1], threadBoards.get(owned[1])!, titles.get(owned[1])!) });
    const owned_posts = /^\/v1\/threads\/([^/]+)\/posts$/.exec(url.pathname);
    if (owned_posts?.[1] && threadBoards.has(owned_posts[1])) {
      const boardId = threadBoards.get(owned_posts[1])!;
      const count = owned_posts[1] === longThreadId ? longPostCount : 1;
      return json({
        posts: Array.from({ length: count }, (_, index) => post(owned_posts[1]!, boardId, index + 1)),
        next: null,
      });
    }
    return json({ ...problem, status: 404, code: 'not_found', retryable: false }, 404);
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-8000));
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KERNEL_ORIGIN: fake.url.origin,
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: 'rezics-website',
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: 'https://api.rezics.test',
        WEBSITE_SCOPES: 'media:create media:read',
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
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
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

/** The links of the line above the title, and whether the line sits above the page's own heading. */
async function context(page: Page) {
  const line = page.locator('main header nav');
  const links = await line
    .locator('a')
    .evaluateAll((anchors) =>
      anchors.map((anchor) => ({ text: anchor.textContent, href: anchor.getAttribute('href') })),
    );
  const heading = await page.locator('main h1').boundingBox();
  const above = (await line.count()) === 0 ? null : (await line.boundingBox())!.y < heading!.y;
  return { links, above, label: above === null ? null : await line.getAttribute('aria-label') };
}

const count = (path: string) => calls.filter((call) => call.path === path).length;

test(
  "a thread in a Realm's board shows Realm › Board above its title, both linked",
  async () => {
    for (const [locale, realm, label] of [
      ['en', 'Book Club', 'Breadcrumb'],
      ['zh-Hans', '读书俱乐部', '面包屑导航'],
    ] as const) {
      // One post and a full page of posts read the Realm and the board once each.
      for (const threadId of [shortThreadId, longThreadId]) {
        calls.length = 0;
        const page = await open(`/${locale}/threads/${threadId}`);
        try {
          expect(await context(page)).toEqual({
            links: [
              { text: realm, href: `/${locale}/realms/${realmId}` },
              { text: 'Reading room', href: `/${locale}/boards/${realmBoardId}` },
            ],
            above: true,
            label,
          });
          expect(count(`/v1/realms/${realmId}`)).toBe(1);
          expect(count(`/v1/boards/${realmBoardId}`)).toBe(1);
          expect(calls.filter((call) => call.path.startsWith('/v1/realms/'))).toHaveLength(1);
          expect(calls.find((call) => call.path === `/v1/realms/${realmId}`)?.language).toStartWith(locale);
          expect(await page.locator('main article > header h1').innerText()).toBe(titles.get(threadId));
        } finally {
          await page.context().close();
        }
      }
    }
  },
  timeout,
);

test(
  'a board page in a Realm shows the Realm, linked, above the board title',
  async () => {
    for (const [locale, realm] of [
      ['en', 'Book Club'],
      ['zh-Hans', '读书俱乐部'],
    ] as const) {
      calls.length = 0;
      const page = await open(`/${locale}/boards/${realmBoardId}`);
      try {
        const line = await context(page);
        expect(line.links).toEqual([{ text: realm, href: `/${locale}/realms/${realmId}` }]);
        expect(line.above).toBe(true);
        expect(await page.locator('main h1').innerText()).toBe('Reading room');
        expect(count(`/v1/realms/${realmId}`)).toBe(1);
        expect(count(`/v1/boards/${realmBoardId}`)).toBe(1);
        expect(calls.filter((call) => call.path.startsWith('/v1/realms/'))).toHaveLength(1);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'a board whose realmId is null shows no Realm, and a failed Realm read leaves the Realm out while the page renders',
  async () => {
    // No Realm: no Realm read at all, and the thread page keeps only its board link.
    calls.length = 0;
    let page = await open(`/en/boards/${plainBoardId}`);
    try {
      expect((await context(page)).links).toEqual([]);
      expect(await page.locator('main h1').innerText()).toBe('Open floor');
    } finally {
      await page.context().close();
    }
    page = await open(`/en/threads/${plainThreadId}`);
    try {
      expect((await context(page)).links).toEqual([{ text: 'Open floor', href: `/en/boards/${plainBoardId}` }]);
      expect(await page.locator('main h1').innerText()).toBe('A plain thread');
    } finally {
      await page.context().close();
    }
    expect(calls.filter((call) => call.path.startsWith('/v1/realms/'))).toHaveLength(0);

    // A Realm that cannot be read, by error or because it is gone, is left out of the line.
    page = await open(`/en/boards/${brokenBoardId}`);
    try {
      expect((await context(page)).links).toEqual([]);
      expect(await page.locator('main h1').innerText()).toBe('Back room');
      expect(await page.locator('main').innerText()).toContain('A thread beside a broken Realm');
    } finally {
      await page.context().close();
    }
    page = await open(`/en/boards/${missingBoardId}`);
    try {
      expect((await context(page)).links).toEqual([]);
      expect(await page.locator('main h1').innerText()).toBe('Side room');
    } finally {
      await page.context().close();
    }
    page = await open(`/en/threads/${brokenThreadId}`);
    try {
      expect((await context(page)).links).toEqual([{ text: 'Back room', href: `/en/boards/${brokenBoardId}` }]);
      expect(await page.locator('main h1').innerText()).toBe('A thread beside a broken Realm');
      expect(await page.locator('main').innerText()).toContain('Contribution 1');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
