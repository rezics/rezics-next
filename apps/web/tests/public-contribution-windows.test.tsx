import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import recordedPage from '../src/kernel/recorded/agent-page-reader.json';
import { startDevServer } from './support/dev-server';
import {
  beginContributionWindowMove,
  contributionCoordinateIsBounded,
  contributionWindowSnapshot,
  retryContributionWindow,
  type ContributionWindowOwner,
  type ContributionWindowView,
} from '../src/accounts/public-profile/contribution-windows/state';

const accountId = recordedPage.account;
const query = 'scope=%2B&tag=one&tag=two';
const fragment = '#part';
const views: readonly ContributionWindowView[] = ['posts', 'reviews', 'discussion'];
const native = createStoryRecordedKernelFetch();
const pageReads: { view: string | undefined }[] = [];
const listReads: { view: ContributionWindowView; cursor: string | null; limit: string | null; kind: string | null }[] = [];
const failOnce = new Set<string>();
const failed = new Set<string>();
const sparse = new Set<string>();
const successfulCursorReads = new Map<string, number>();
const maximumPage: Record<ContributionWindowView, number> = { posts: 2, reviews: 2, discussion: 2 };
let retryCursor: string | null = null;
let sparseCursor: string | null = null;
let site: Awaited<ReturnType<typeof startDevServer>> | undefined;
let browser: Browser | undefined;
let kernel: ReturnType<typeof Bun.serve> | undefined;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected fixture record');
  return value as Record<string, unknown>;
}

function contributionCursor(view: ContributionWindowView, page: number): string {
  return `${view}+signed/=${page}`;
}

function listField(view: ContributionWindowView): 'posts' | 'threads' {
  return view === 'posts' ? 'posts' : 'threads';
}

function listSlot(view: ContributionWindowView): string {
  return view === 'posts' ? 'account-posts' : view === 'reviews' ? 'account-reviews' : 'account-threads';
}

function pagePayload(view?: ContributionWindowView): Record<string, unknown> {
  const payload = structuredClone(recordedPage) as unknown as Record<string, unknown>;
  delete payload.status;
  if (!view) return payload;

  const document = record(payload.document);
  const content = document.content as Record<string, unknown>[];
  const selectedType = view === 'posts' ? 'AccountPosts' : 'AccountThreads';
  document.content = content.flatMap((node) => {
    const type = node.type;
    if (type !== 'AccountPosts' && type !== 'AccountThreads' && type !== 'AccountCollections') return [node];
    if (type !== selectedType) return [];
    const props = record(node.props);
    props.paged = true;
    props.limit = 20;
    if (view === 'reviews' || view === 'discussion') props.threadKind = view === 'reviews' ? 'review' : 'discussion';
    return [node];
  });

  const reads = record(payload.reads);
  const key = view === 'posts' ? 'r11' : 'r12';
  const result = record(reads[key]);
  const body = record(result.body);
  body[listField(view)] = [contributionRow(view, 0)];
  body.next = contributionCursor(view, 1);
  if (view === 'reviews' || view === 'discussion') {
    const profileRead = record(reads.r1);
    const profileBody = record(profileRead.body);
    const accounts = profileBody.accounts as Record<string, unknown>[];
    const profile = record(accounts[0]);
    const publication = record(profile.publicViews);
    publication.posts = true;
    publication.reviews = true;
  }
  return payload;
}

function contributionRow(view: ContributionWindowView, page: number): Record<string, unknown> {
  const source = view === 'posts' ? recordedPage.reads.r11.body.posts[0] : recordedPage.reads.r12.body.threads[0];
  const row = structuredClone(source) as unknown as Record<string, unknown>;
  const suffix = String(page + 1).padStart(12, '0');
  if (view === 'posts') {
    row.id = `0192f3a0-6c1e-7b2a-c001-${suffix}`;
    const thread = record(row.thread);
    thread.id = `0192f3a0-6c1e-7b2a-b001-${suffix}`;
    thread.title = `Posts window ${page}`;
    if (record(thread.firstPost)) record(thread.firstPost).id = `0192f3a0-6c1e-7b2a-b101-${suffix}`;
  } else {
    row.id = `0192f3a0-6c1e-7b2a-b001-${suffix}`;
    row.title = `${view === 'reviews' ? 'Reviews' : 'Discussion'} window ${page}`;
    row.kind = view === 'reviews' ? 'review' : 'discussion';
    if (record(row.firstPost)) record(row.firstPost).id = `0192f3a0-6c1e-7b2a-b101-${suffix}`;
  }
  return row;
}

function listView(url: URL): ContributionWindowView {
  if (url.pathname.endsWith('/posts')) return 'posts';
  return url.searchParams.get('kind') === 'review' ? 'reviews' : 'discussion';
}

function pageNumber(view: ContributionWindowView, cursor: string): number {
  for (let page = 1; page <= maximumPage[view]; page++) if (cursor === contributionCursor(view, page)) return page;
  throw new Error(`Unexpected ${view} cursor: ${cursor}`);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

beforeAll(async () => {
  kernel = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/v1/pages:read') {
        const input = record(await request.json());
        const target = record(input.target);
        const view = target.view === 'posts' || target.view === 'reviews' || target.view === 'discussion'
          ? target.view
          : undefined;
        pageReads.push({ view });
        expect(request.headers.has('authorization')).toBe(false);
        return json(pagePayload(view));
      }

      const match = /^\/v1\/accounts\/([^/]+)\/(posts|threads)$/.exec(url.pathname);
      if (request.method === 'GET' && match?.[1] === accountId && match[2]) {
        const view = listView(url);
        const cursor = url.searchParams.get('cursor');
        listReads.push({ view, cursor, limit: url.searchParams.get('limit'), kind: url.searchParams.get('kind') });
        expect(request.headers.has('authorization')).toBe(false);
        const key = `${view}:${cursor ?? ''}`;
        if (cursor && cursor === retryCursor && failOnce.has(key) && !failed.has(key)) {
          failed.add(key);
          return json({ code: 'temporarily_unavailable' }, 503);
        }
        const page = cursor ? pageNumber(view, cursor) : 0;
        const rows = cursor === sparseCursor && sparse.has(key) ? [] : [contributionRow(view, page)];
        const readCount = cursor ? (successfulCursorReads.get(key) ?? 0) + 1 : 1;
        if (cursor) successfulCursorReads.set(key, readCount);
        if (cursor && readCount > 1 && rows[0]) {
          if (view === 'posts') record(rows[0].thread).title = `Posts window ${page} reread ${readCount}`;
          else rows[0].title = `${view === 'reviews' ? 'Reviews' : 'Discussion'} window ${page} reread ${readCount}`;
        }
        return json({
          [listField(view)]: rows,
          next: page < maximumPage[view] ? contributionCursor(view, page + 1) : null,
        });
      }

      return native(request);
    },
  });
  site = await startDevServer({
    env: {
      KERNEL_ORIGIN: kernel.url.origin,
      PUBLIC_ORIGIN: 'https://rezics.test',
      AUTH_ISSUER: `${kernel.url.origin}/auth`,
      WEBSITE_CLIENT_ID: 'rezics-contribution-windows',
      WEBSITE_CLIENT_KEY: JSON.stringify({ kty: 'EC', crv: 'P-256', d: 'fixture', kid: 'contribution-windows' }),
      API_RESOURCE: 'https://api.rezics.test',
      WEBSITE_SCOPES: 'media:create media:read media:complete media:erase',
    },
    firstPath: '/en/@mira/posts',
    warmUpPaths: ['/en/@mira/posts'],
  });
  browser = await chromium.launch();
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await site?.stop();
  kernel?.stop(true);
});

function resetReads(): void {
  pageReads.length = 0;
  listReads.length = 0;
  failed.clear();
  successfulCursorReads.clear();
}

async function open(page: Page, view: ContributionWindowView): Promise<void> {
  await page.goto(`${site!.origin}/en/@mira/${view}?${query}${fragment}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await page.getByRole('heading', { level: 1, name: 'Mira Okabe' }).waitFor();
  await page.locator(`[data-slot="${listSlot(view)}-items"]`).waitFor();
}

async function move(page: Page, action: 'next' | 'previous' | 'first', cursor: string | null): Promise<void> {
  await page.locator(`[data-slot="${action === 'next' ? 'continuation' : action === 'previous' ? 'previous-page' : 'first-page'}"]`).click();
  await page.waitForURL((address) => address.searchParams.get('cursor') === cursor, { timeout: 60_000 });
  const pathView = page.url().includes('/reviews') ? 'reviews' : page.url().includes('/discussion') ? 'discussion' : 'posts';
  await page.locator(`[data-slot="${listSlot(pathView)}-items"]`).waitFor();
}

test('served Posts, Reviews and Discussion replace and reread native windows through Next, Previous and First', async () => {
  const page = await browser!.newPage();
  try {
    for (const view of views) {
      resetReads();
      await open(page, view);
      const routePath = `/en/@mira/${view}`;
      const initialUrl = `${site!.origin}${routePath}?${query}${fragment}`;
      await page.evaluate(() => Object.assign(window, { __contributionWindowVisit: 'same-route-runtime' }));
      const cursor1 = contributionCursor(view, 1);
      const cursor2 = contributionCursor(view, 2);
      if (view === 'discussion') {
        sparseCursor = cursor1;
        sparse.add(`discussion:${cursor1}`);
      }
      if (view === 'posts') {
        retryCursor = cursor2;
        failOnce.add(`posts:${cursor2}`);
      }

      await move(page, 'next', cursor1);
      if (view === 'discussion') {
        expect(await page.locator('[data-slot="account-threads-items"] li').count()).toBe(0);
        expect(await page.locator('[data-slot="continuation"]').count()).toBe(1);
      } else {
        await page.getByText(`${view === 'posts' ? 'Posts' : 'Reviews'} window 1`).waitFor();
      }
      await move(page, 'next', cursor2);
      if (view === 'posts') {
        await page.getByText('This page could not be loaded. Please try again.').waitFor();
        expect(await page.getByText('Posts window 1').count()).toBe(0);
        await page.getByRole('button', { name: 'Try again' }).click();
      }
      await page.getByText(`${view === 'posts' ? 'Posts' : view === 'reviews' ? 'Reviews' : 'Discussion'} window 2`).waitFor();
      await move(page, 'previous', cursor1);
      if (view === 'discussion') expect(await page.locator('[data-slot="account-threads-items"] li').count()).toBe(0);
      else await page.getByText(`${view === 'posts' ? 'Posts' : 'Reviews'} window 1 reread 2`).waitFor();

      const firstHref = await page.locator('[data-slot="first-page"]').getAttribute('href');
      expect(firstHref).toBe(`${routePath}?${query}${fragment}`);
      await move(page, 'first', null);
      await page.getByText(`${view === 'posts' ? 'Posts' : view === 'reviews' ? 'Reviews' : 'Discussion'} window 0`).waitFor();
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__contributionWindowVisit)).toBe(
        'same-route-runtime',
      );

      const expected = view === 'posts' ? [cursor1, cursor2, cursor2, cursor1] : [cursor1, cursor2, cursor1];
      expect(listReads.map((read) => read.cursor)).toEqual(expected);
      expect(listReads.every((read) => read.limit === '20')).toBe(true);
      expect(listReads.every((read) => read.view === view)).toBe(true);
      expect(listReads.every((read) => read.kind === (view === 'posts' ? null : view === 'reviews' ? 'review' : 'discussion'))).toBe(true);
      expect(pageReads.filter((read) => read.view === view)).toHaveLength(view === 'posts' ? 6 : 5);
      expect(pageReads.filter((read) => read.view === undefined)).toHaveLength(view === 'posts' ? 6 : 5);
      expect(page.url()).toBe(initialUrl);
      sparseCursor = null;
      sparse.clear();
      retryCursor = null;
      failOnce.clear();
    }
  } finally {
    await page.close();
  }
}, 300_000);

test('served cursor history keeps only eight predecessors and a failed movement retries its exact target', async () => {
  const page = await browser!.newPage();
  try {
    maximumPage.posts = 10;
    resetReads();
    await open(page, 'posts');
    for (let index = 1; index <= 10; index++) {
      await move(page, 'next', contributionCursor('posts', index));
      await page.getByText(`Posts window ${index}`).waitFor();
      expect(await page.locator('[data-slot="account-posts-items"] li').count()).toBeLessThanOrEqual(20);
    }
    const previousCursors: string[] = [];
    for (let index = 9; index >= 2; index--) {
      previousCursors.push(contributionCursor('posts', index));
      await move(page, 'previous', contributionCursor('posts', index));
      await page.getByText(`Posts window ${index}`).waitFor();
    }
    expect(await page.locator('[data-slot="previous-page"]').count()).toBe(0);
    expect(await page.locator('[data-slot="first-page"]').count()).toBe(1);
    expect(listReads.map((read) => read.cursor)).toEqual([
      ...Array.from({ length: 10 }, (_, index) => contributionCursor('posts', index + 1)),
      ...previousCursors,
    ]);
  } finally {
    maximumPage.posts = 2;
    await page.close();
  }
}, 300_000);

function acceptedVisit(host: Window, owner: ContributionWindowOwner): string {
  let cursor: string | null = null;
  let href = `/en/@mira/${owner.view}`;
  contributionWindowSnapshot({ owner, cursor, href, outcome: 'admitted', host });
  for (let page = 1; page <= 2; page++) {
    const target = contributionCursor(owner.view, page);
    const targetHref = `${href}?cursor=${encodeURIComponent(target)}`;
    beginContributionWindowMove({
      owner,
      cursor,
      currentHref: href,
      target,
      targetHref,
      action: 'next',
      event: { detail: 1 },
      source: {} as HTMLElement,
      host,
    });
    cursor = target;
    href = targetHref;
    contributionWindowSnapshot({ owner, cursor, href, outcome: 'admitted', host });
  }
  return href;
}

test('direct cursors invent no predecessor and account, view, locale or publication replacement retires the visit', () => {
  const base: ContributionWindowOwner = { accountId, view: 'posts', locale: 'en', published: true };
  const cursor = contributionCursor('posts', 2);
  const href = `/en/@mira/posts?cursor=${encodeURIComponent(cursor)}`;
  const directHost = {} as Window;
  expect(contributionWindowSnapshot({ owner: base, cursor, href, host: directHost }).predecessors).toEqual([]);

  for (const owner of [
    { ...base, accountId: 'another-account' },
    { ...base, view: 'reviews' as const },
    { ...base, locale: 'ja' },
  ]) {
    const host = {} as Window;
    const last = acceptedVisit(host, base);
    const replacement = contributionWindowSnapshot({ owner, cursor, href: last, host });
    expect(replacement.predecessors).toEqual([]);
    expect(replacement.current).toBe(cursor);
  }

  const host = {} as Window;
  acceptedVisit(host, base);
  contributionWindowSnapshot({ owner: { ...base, published: false }, cursor, href, host });
  expect(contributionWindowSnapshot({ owner: base, cursor, href, host }).predecessors).toEqual([]);
});

test('cursor coordinates stay within the installed route bound', () => {
  expect(contributionCoordinateIsBounded('x'.repeat(4096))).toBe(true);
  expect(contributionCoordinateIsBounded('x'.repeat(4097))).toBe(false);
  expect(contributionCoordinateIsBounded('')).toBe(false);
  expect(contributionCoordinateIsBounded(null)).toBe(false);
});

test('failed native replacement keeps its exact cursor and accepted history until Retry is admitted', () => {
  const owner: ContributionWindowOwner = { accountId, view: 'posts', locale: 'en', published: true };
  const host = {} as Window;
  const start = '/en/@mira/posts';
  const cursor = contributionCursor('posts', 1);
  const target = `${start}?cursor=${encodeURIComponent(cursor)}`;
  contributionWindowSnapshot({ owner, cursor: null, href: start, outcome: 'admitted', host });
  beginContributionWindowMove({
    owner,
    cursor: null,
    currentHref: start,
    target,
    targetHref: target,
    action: 'next',
    event: { detail: 1 },
    source: {} as HTMLElement,
    host,
  });
  const failedRead = contributionWindowSnapshot({ owner, cursor, href: target, outcome: 'failed', host });
  expect(failedRead.current).toBeNull();
  expect(failedRead.predecessors).toEqual([]);
  expect(failedRead.pending).toMatchObject({ target: cursor, href: target, failed: true });
  retryContributionWindow({ owner, cursor, href: target, host });
  const accepted = contributionWindowSnapshot({ owner, cursor, href: target, outcome: 'admitted', host });
  expect(accepted.current).toBe(cursor);
  expect(accepted.predecessors).toEqual([null]);
  expect(accepted.pending).toBeNull();
});
