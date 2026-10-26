import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';
import type { KernelClient } from '@rezics/client';

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
type Data<F extends (...args: never[]) => unknown> = NonNullable<
  Awaited<ReturnType<F>> extends { data: infer D } ? D : never
>;
type BoardRead = Data<BoardResource['get']>;

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const metadata = {
  route: 0,
  visibility: 'published',
  securityRevision: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;
const board: BoardRead = { board: { ...metadata, id: id(1), title: 'Reading room', availability: 'available' } };
function thread(n: number, title: string) {
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
    },
  };
}

const cursor = 'signed+page/next==';
// Each sort answers a different order, so a page shows which sort the kernel was asked for.
const ranked = {
  active: [thread(2, 'Active one'), thread(3, 'Active two'), thread(4, 'Active three')],
  hot: [thread(5, 'Hot one'), thread(6, 'Hot two'), thread(7, 'Hot three')],
  newest: [thread(8, 'New one'), thread(9, 'New two'), thread(10, 'New three')],
};
const calls: { path: string; cursor: string | null; sort: string | null }[] = [];
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const missing = {
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
    if (url.pathname === `/v1/boards/${id(1)}`) return json(board);
    if (url.pathname === `/v1/boards/${id(1)}/threads`) {
      const sort = url.searchParams.get('sort');
      calls.push({ path: url.pathname, cursor: url.searchParams.get('cursor'), sort });
      const rank = sort === 'active' || sort === 'hot';
      const list = rank ? ranked[sort] : ranked.newest;
      const page =
        url.searchParams.get('cursor') === cursor
          ? {
              threads: [list[2]!.thread],
              next: null,
              anchors: [],
              rankRefreshedAt: rank ? '2026-01-01T00:00:00.000Z' : undefined,
            }
          : {
              threads: [list[0]!.thread, list[1]!.thread],
              next: cursor,
              anchors: [],
              rankRefreshedAt: rank ? '2026-01-01T00:00:00.000Z' : undefined,
            };
      return json(page);
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
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});
const moreLink = (page: Page) => page.locator('main a[href*="cursor="]');
const boardPath = `/boards/${id(1)}`;
const titles = (page: Page) => page.locator('main a[href*="/threads/"]').allTextContents();
const sortNav = (page: Page, name: string) => page.getByRole('navigation', { name, exact: true });
const hrefOf = async (page: Page, name: string, link: string) =>
  new URL((await sortNav(page, name).getByRole('link', { name: link, exact: true }).getAttribute('href'))!, page.url());

const labels = {
  en: { nav: 'Sort threads', active: 'Active', hot: 'Hot', new: 'New' },
  ja: { nav: 'スレッドの並べ替え', active: 'アクティブ', hot: '人気', new: '新着' },
} as const;

// Active is the default and has no parameter; New asks the kernel for no sort at all.
test(
  'a board offers Active, Hot and New sorts, defaults to Active, and keeps the chosen sort in the URL',
  async () => {
    for (const locale of ['en', 'ja'] as const) {
      const text = labels[locale];
      calls.length = 0;
      const page = await open(`/${locale}${boardPath}`);
      try {
        expect(calls.filter((call) => call.cursor === null).map((call) => call.sort)).toEqual(['active']);
        expect(await titles(page)).toEqual(['Active one', 'Active two']);
        const nav = sortNav(page, text.nav);
        expect(await nav.getByRole('link').allTextContents()).toEqual([text.active, text.hot, text.new]);
        expect((await hrefOf(page, text.nav, text.active)).search).toBe('');
        expect((await hrefOf(page, text.nav, text.hot)).searchParams.get('sort')).toBe('hot');
        expect((await hrefOf(page, text.nav, text.new)).searchParams.get('sort')).toBe('new');

        calls.length = 0;
        await nav.getByRole('link', { name: text.hot, exact: true }).click();
        expect(new URL(page.url()).searchParams.get('sort')).toBe('hot');
        expect(await titles(page)).toEqual(['Hot one', 'Hot two']);
        expect(calls.filter((call) => call.cursor === null).map((call) => call.sort)).toEqual(['hot']);

        calls.length = 0;
        await nav.getByRole('link', { name: text.new, exact: true }).click();
        expect(new URL(page.url()).searchParams.get('sort')).toBe('new');
        expect(await titles(page)).toEqual(['New one', 'New two']);
        expect(calls.filter((call) => call.cursor === null).map((call) => call.sort)).toEqual([null]);

        await page.reload();
        expect(await titles(page)).toEqual(['New one', 'New two']);

        calls.length = 0;
        await nav.getByRole('link', { name: text.active, exact: true }).click();
        expect(new URL(page.url()).searchParams.has('sort')).toBe(false);
        expect(await titles(page)).toEqual(['Active one', 'Active two']);
        expect(calls.filter((call) => call.cursor === null).map((call) => call.sort)).toEqual(['active']);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

// The cursor travels with the sort; the sort links carry no cursor.
test(
  'the next page of threads keeps the chosen sort',
  async () => {
    for (const [query, sort, first, last] of [
      ['', 'active', 'Active one', 'Active three'],
      ['?sort=hot', 'hot', 'Hot one', 'Hot three'],
      ['?sort=new', null, 'New one', 'New three'],
    ] as const) {
      const page = await open(`/en${boardPath}${query}`);
      try {
        expect((await titles(page))[0]).toBe(first);
        const more = moreLink(page);
        expect(await more.count()).toBe(1);
        const target = new URL((await more.getAttribute('href'))!, page.url());
        expect(target.searchParams.get('cursor')).toBe(cursor);
        expect(target.searchParams.get('sort')).toBe(query ? query.slice(6) : null);
        calls.length = 0;
        await more.click();
        expect(await titles(page)).toEqual([last]);
        expect(calls).toEqual([{ path: `/v1/boards/${id(1)}/threads`, cursor, sort }]);
        const nav = sortNav(page, 'Sort threads');
        for (const name of ['Active', 'Hot', 'New'])
          expect((await hrefOf(page, 'Sort threads', name)).searchParams.has('cursor')).toBe(false);
        calls.length = 0;
        await nav.getByRole('link', { name: 'Hot', exact: true }).click();
        expect(await titles(page)).toEqual(['Hot one', 'Hot two']);
        expect(calls.map((call) => call.cursor)).toEqual([null]);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'an unknown sort in the URL falls back to Active',
  async () => {
    for (const query of ['?sort=bogus', '?sort=', '?sort=newest', '?sort=Hot']) {
      calls.length = 0;
      const page = await open(`/en${boardPath}${query}`);
      try {
        expect(calls.map((call) => call.sort)).toEqual(['active']);
        expect(await titles(page)).toEqual(['Active one', 'Active two']);
        const current = sortNav(page, 'Sort threads').locator('[aria-current="page"]');
        expect(await current.allTextContents()).toEqual(['Active']);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

// The page is opened with JavaScript off, so the control must be plain links.
test(
  'the sort choice is a set of links that works without JavaScript and marks the current one',
  async () => {
    for (const [query, current] of [
      ['', 'Active'],
      ['?sort=hot', 'Hot'],
      ['?sort=new', 'New'],
    ] as const) {
      const page = await open(`/en${boardPath}${query}`);
      try {
        const nav = sortNav(page, 'Sort threads');
        expect(await nav.count()).toBe(1);
        expect(await nav.locator('a').count()).toBe(3);
        expect(await nav.locator('button, [role="tab"]').count()).toBe(0);
        expect(await nav.locator('[aria-current="page"]').allTextContents()).toEqual([current]);
        expect(await nav.locator('a[aria-current="page"]').count()).toBe(1);
        // The control sits above the thread list.
        const navBox = (await nav.boundingBox())!;
        const listBox = (await page.locator('main ul').first().boundingBox())!;
        expect(navBox.y + navBox.height).toBeLessThanOrEqual(listBox.y);
        // Following a link is a plain navigation.
        const hot = await hrefOf(page, 'Sort threads', 'Hot');
        await page.goto(hot.href, { waitUntil: 'load' });
        expect(await titles(page)).toEqual(['Hot one', 'Hot two']);
        expect(await sortNav(page, 'Sort threads').locator('[aria-current="page"]').allTextContents()).toEqual(['Hot']);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);
