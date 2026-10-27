import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';
import type { KernelClient } from '@rezics/client';
import { threadHref } from '../src/threads/thread-href';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const resource = 'https://api.rezics.test';
const scopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

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
type Problem = NonNullable<Awaited<ReturnType<ThreadResource['get']>>['error']>['value'];

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const metadata = {
  route: 0,
  visibility: 'published',
  securityRevision: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;
const board: BoardRead = { board: { ...metadata, id: id(1), title: 'Reading room', availability: 'available' } };
// A blocks snapshot exercises DocumentBody's heading, paragraph and link rendering.
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
const erased: Post = { ...post(16, id(5)), availability: 'erased', body: null };
const cursor = 'signed+page/next==';
const calls: { method: string; path: string; cursor: string | null }[] = [];
const events: string[] = [];
let hold = false;
let release: (() => void) | undefined;
let gate: Promise<void> = Promise.resolve();
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const missing: Problem = {
  type: 'https://rezics.com/problems/not_found',
  title: 'Not Found',
  status: 404,
  code: 'not_found',
  retryable: false,
  effect_status: 'not_applicable',
  request_id: randomUUID(),
};

// Discovery and signing keys copied from session.test.ts; these public reads need no token grant.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const issuer = `${url.origin}/auth`;
    const tokenEndpoint = `${issuer}/token`;
    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: tokenEndpoint,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
        end_session_endpoint: `${issuer}/end-session`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    if (url.pathname === '/auth/jwks') return json({ keys: [issuerJwk] });
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    calls.push({ method: request.method, path: url.pathname, cursor: url.searchParams.get('cursor') });
    events.push(`start ${url.pathname}`);
    if (hold) await gate;
    events.push(`answer ${url.pathname}`);
    if (request.method !== 'GET') return json(missing, 404);
    if (url.pathname === `/v1/boards/${id(1)}`) return json(board);
    if (url.pathname === `/v1/boards/${id(1)}/threads`) {
      const page: Threads =
        url.searchParams.get('cursor') === cursor
          ? { threads: [last.thread], next: null }
          : { threads: [first.thread, second.thread], next: cursor };
      return json(page);
    }
    for (const value of [first, second, last, erasedThread]) {
      if (url.pathname === `/v1/threads/${value.thread.id}`) return json(value);
      if (url.pathname === `/v1/threads/${value.thread.id}/posts`) {
        const page: Posts =
          value === erasedThread
            ? { posts: [erased], next: null }
            : url.searchParams.get('cursor') === cursor
              ? { posts: [post(14)], next: null }
              : { posts: [post(13), post(12)], next: cursor };
        return json(page);
      }
    }
    return Response.json(missing, { status: 404, headers: { 'content-type': 'application/problem+json' } });
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

// The documented command, pointed at the fake through the environment it reads in development.
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KERNEL_ORIGIN: fake.url.origin,
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: clientId,
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: resource,
        WEBSITE_SCOPES: scopes.join(' '),
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
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: false,
  });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  return page;
}
afterAll(async () => {
  release?.();
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});
const read = (path: string, next: string | null = null) => ({ method: 'GET', path, cursor: next });
const moreLink = (page: Page) => page.locator('main a[href*="cursor="]');

// Keep the board's kernel order and use the list envelope cursor for the next page.
test(
  "a board page lists its threads in the kernel's order and pages with the cursor",
  async () => {
    calls.length = 0;
    const page = await open(`/en/boards/${id(1)}`);
    try {
      expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe('Reading room');
      expect(calls).toContainEqual(read(`/v1/boards/${id(1)}`));
      expect(calls).toContainEqual(read(`/v1/boards/${id(1)}/threads`));
      const links = page.locator('main a[href*="/threads/"]');
      expect(await links.allTextContents()).toEqual(['Zebra reading', 'Apple reading']);
      expect(await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))).toEqual([
        `/en${threadHref({ id: id(2), title: 'Zebra reading' })}`,
        `/en${threadHref({ id: id(3), title: 'Apple reading' })}`,
      ]);
      const more = moreLink(page);
      expect(await more.count()).toBe(1);
      const target = new URL((await more.getAttribute('href'))!, page.url());
      expect(target.pathname).toBe(`/en/boards/${id(1)}`);
      expect(target.searchParams.get('cursor')).toBe(cursor);
      calls.length = 0;
      await more.click();
      expect(await links.allTextContents()).toEqual(['Last reading']);
      expect(calls).toContainEqual(read(`/v1/boards/${id(1)}/threads`, cursor));
      expect(await more.count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Keep post order, render each body, and page with the list envelope cursor.
test(
  'a thread page shows its posts in order with their rendered bodies',
  async () => {
    calls.length = 0;
    const page = await open(`/en${threadHref({ id: id(2), title: 'Zebra reading' })}`);
    try {
      expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe('Zebra reading');
      expect(calls).toContainEqual(read(`/v1/threads/${id(2)}`));
      expect(calls).toContainEqual(read(`/v1/threads/${id(2)}/posts`));
      // Distinct body text checks post order without prescribing the page's wrapper markup.
      expect(
        (await page.locator('main p').allTextContents()).filter((text) => text.startsWith('Contribution ')),
      ).toEqual(['Contribution 13', 'Contribution 12']);
      const headings = page.getByRole('heading', { name: 'A close reading', exact: true });
      expect(await headings.count()).toBe(2);
      expect(await page.locator('main p').allTextContents()).toContain('Read the original at the library');
      const links = page.getByRole('link', { name: 'the library', exact: true });
      expect(await links.count()).toBe(2);
      for (const link of await links.all()) expect(await link.getAttribute('href')).toBe('https://example.org/library');
      const html = await page.locator('main').innerHTML();
      expect(html).toContain('<h2');
      expect(html).toContain('<p');
      const more = moreLink(page);
      expect(await more.count()).toBe(1);
      const target = new URL((await more.getAttribute('href'))!, page.url());
      expect(target.pathname).toBe(`/en${threadHref({ id: id(2), title: 'Zebra reading' })}`);
      expect(target.searchParams.get('cursor')).toBe(cursor);
      calls.length = 0;
      await more.click();
      expect(await headings.count()).toBe(1);
      expect(await page.locator('main').innerText()).toContain('Contribution 14');
      expect(await page.locator('main').innerText()).not.toContain('Contribution 13');
      expect(calls).toContainEqual(read(`/v1/threads/${id(2)}/posts`, cursor));
      expect(await more.count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Erased posts show a localized note in place of the document body.
test(
  'an erased post says it was erased and shows no body',
  async () => {
    for (const [locale, note] of [
      ['en', /removed by its author/i],
      ['ja', /消去|削除/],
    ] as const) {
      const page = await open(`/${locale}${threadHref({ id: id(5), title: 'A quiet discussion' })}`);
      try {
        expect(await page.locator('main').innerText()).toMatch(note);
        expect(await page.getByRole('heading', { name: 'A close reading' }).count()).toBe(0);
        expect(await page.getByRole('link', { name: 'the library' }).count()).toBe(0);
        expect(await page.locator('main').innerText()).not.toContain('Read the original');
        expect(await moreLink(page).count()).toBe(0);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

// Kernel 404s use the site's not-found page and status.
test(
  "a missing board or thread answers the site's not-found page with 404",
  async () => {
    const origin = await site();
    for (const plural of ['boards', 'threads']) {
      calls.length = 0;
      const response = await fetch(`${origin}/en/${plural}/${id(99)}`);
      expect(response.status).toBe(404);
      // A router miss alone cannot establish that the page handles the kernel's not-found response.
      expect(calls).toContainEqual(read(`/v1/${plural}/${id(99)}`));
      const page = await open(`/en/${plural}/${id(99)}`);
      try {
        expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe('Page not found');
        expect(await page.locator('main').innerText()).toContain('The page you requested could not be found.');
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

// Start thread and post-page reads together, then fill the page's bylines in one batch.
test(
  'a thread page reads the thread and its posts together, then fills bylines with one batched identity read',
  async () => {
    const origin = await site();
    calls.length = 0;
    events.length = 0;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hold = true;
    // A sequential implementation must finish too, so release after a bounded observation window.
    const fallback = setTimeout(() => release?.(), 1500);
    try {
      const response = await fetch(`${origin}/en${threadHref({ id: id(2), title: 'Zebra reading' })}`);
      await response.text();
      expect(calls.slice(0, 2)).toEqual([read(`/v1/threads/${id(2)}`), read(`/v1/threads/${id(2)}/posts`)]);
      expect(calls.slice(2)).toContainEqual(read(`/v1/boards/${id(1)}`));
      expect(calls).toHaveLength(4);
      expect(calls.filter((call) => call.path === '/v1/accounts')).toHaveLength(1);
      expect(events.slice(0, 2).sort()).toEqual(
        [`start /v1/threads/${id(2)}`, `start /v1/threads/${id(2)}/posts`].sort(),
      );
      expect(events.slice(2, 4).sort()).toEqual(
        [`answer /v1/threads/${id(2)}`, `answer /v1/threads/${id(2)}/posts`].sort(),
      );
      expect(events).toContain(`start /v1/boards/${id(1)}`);
      expect(events).toContain(`answer /v1/boards/${id(1)}`);
      expect(events).toContain('start /v1/accounts');
      expect(events).toContain('answer /v1/accounts');
      expect(response.status).toBe(200);
    } finally {
      clearTimeout(fallback);
      release?.();
      hold = false;
    }
  },
  timeout,
);
