import { startDevServer } from './support/dev-server.ts';
import { boardOpeningCard, boardOpeningExample, boardOpeningId } from '../src/threads/board-opening-fixtures.ts';
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';
import type { BoardPageResponse } from '@rezics/client';

const timeout = 300_000;
const clientId = 'rezics-website';
const resource = 'https://api.rezics.test';
const scopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

const boardApiPath = `/v1/boards/${boardOpeningId}`;
const boardPageApiPath = `${boardApiPath}/page`;
const opening = boardOpeningExample('current', 0);
const board = { ...opening.board, realmId: null, community: null };

function thread(n: number, title: string): BoardPageResponse['threads'][number] {
  const card = boardOpeningCard(n);
  return { ...card, thread: { ...card.thread, title } };
}

const cursor = 'signed+page/next==';
const rankRefreshedAt = '2026-01-01T00:00:00.000Z';
// Each sort answers a different order, so a page shows which sort the kernel was asked for.
const ranked = {
  active: [thread(2, 'Active one'), thread(3, 'Active two'), thread(4, 'Active three')],
  hot: [thread(5, 'Hot one'), thread(6, 'Hot two'), thread(7, 'Hot three')],
  new: [thread(8, 'New one'), thread(9, 'New two'), thread(10, 'New three')],
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
    if (url.pathname === boardApiPath) return json({ board });
    if (request.method === 'GET' && url.pathname === boardPageApiPath) {
      const sort = url.searchParams.get('sort');
      const requestedCursor = url.searchParams.get('cursor');
      calls.push({ path: url.pathname, cursor: requestedCursor, sort });
      const rank = sort === 'active' || sort === 'hot';
      if (!rank && sort !== 'new') return json(missing, 404);
      const list = ranked[sort];
      const continuation = requestedCursor === cursor;
      const page: BoardPageResponse = {
        ...opening,
        board,
        threads: continuation ? list.slice(2) : list.slice(0, 2),
        next: continuation ? null : cursor,
        rankRefreshedAt: rank ? rankRefreshedAt : null,
      };
      return json(page);
    }
    return Response.json(missing, { status: 404, headers: { 'content-type': 'application/problem+json' } });
  },
});

// The documented command, pointed at the fake through the environment it reads in development.
let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
let started: Promise<string> | undefined;

function site(): Promise<string> {
  started ??= startDevServer({
    env: {
      KERNEL_ORIGIN: fake.url.origin,
      AUTH_ISSUER: `${fake.url.origin}/auth`,
      WEBSITE_CLIENT_ID: clientId,
      WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
      API_RESOURCE: resource,
      WEBSITE_SCOPES: scopes.join(' '),
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
  await server?.stop();
});
const moreLink = (page: Page) => page.locator('main a[href*="cursor="]');
const boardPath = `/boards/${boardOpeningId}`;
const titles = (page: Page) => page.locator('main h3 a[href*="/threads/"]').allTextContents();
const rankTime = (page: Page) => page.locator(`[data-slot="board-sort-toolbar"] time[datetime="${rankRefreshedAt}"]`);
const sortNav = (page: Page, name: string) => page.getByRole('navigation', { name, exact: true });
const hrefOf = async (page: Page, name: string, link: string) =>
  new URL((await sortNav(page, name).getByRole('link', { name: link, exact: true }).getAttribute('href'))!, page.url());

const labels = {
  en: { nav: 'Sort threads', active: 'Active', hot: 'Hot', new: 'New' },
  ja: { nav: 'スレッドの並べ替え', active: 'アクティブ', hot: '人気', new: '新着' },
} as const;

// The Active link omits the URL parameter. The page request always sends the selected sort.
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
        expect(await rankTime(page).isVisible()).toBe(true);
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
        expect(await rankTime(page).isVisible()).toBe(true);

        calls.length = 0;
        await nav.getByRole('link', { name: text.new, exact: true }).click();
        expect(new URL(page.url()).searchParams.get('sort')).toBe('new');
        expect(await titles(page)).toEqual(['New one', 'New two']);
        expect(calls.filter((call) => call.cursor === null).map((call) => call.sort)).toEqual(['new']);
        expect(await rankTime(page).count()).toBe(0);

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
      ['?sort=new', 'new', 'New one', 'New three'],
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
        expect(calls).toEqual([{ path: boardPageApiPath, cursor, sort }]);
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
        const listBox = (await page.locator('main li[data-thread-id]').first().boundingBox())!;
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
