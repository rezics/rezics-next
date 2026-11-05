#!/usr/bin/env bun
/**
 * Seeded Board thread reading walk. Run under `dev-stack.ts walk` so the stack, persona
 * and seed:dev pipeline are the supported local ones. Evidence stays under `.temp/thread-reading/`.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Response } from 'playwright';

const root = resolve(import.meta.dir, '../../..');
const evidenceDir = join(root, '.temp/thread-reading');
const seedResultPath = join(root, '.temp/cross-media-seed/result.json');
const primaryLocales = ['en', 'zh-Hant', 'ja'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ShowcaseCommunity = {
  state: string;
  source: { subjectId: string; externalId: string };
  board: { id: string; purpose: string };
  thread: { threadId: string; postId: string };
};
type SeedResult = {
  readings?: { source: string; externalId: string; selection?: string; route?: string; subject?: { subject?: { id?: string } } }[];
  developmentShowcase?: { community?: ShowcaseCommunity };
};
type ReadingPage = {
  thread: {
    id: string;
    title: string | null;
    boardId: string;
    subjectIds?: string[];
    firstPost: { id: string; availability: string; body?: unknown; mediaIds?: string[]; authorId?: string };
  };
  replies: { items: { id: string; availability: string; body?: unknown; mediaIds?: string[] }[]; next: string | null };
};
type BoardPage = {
  board: { id: string; title: string | null };
  threads: { thread: { id: string; title: string | null } }[];
  pinnedThreads?: { thread: { id: string } }[];
  next: string | null;
};

function origin(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    throw new Error(`${name} must be an unauthenticated 127.0.0.1 HTTP origin`);
  return url.origin;
}

function documentText(value: unknown): string {
  const pending: unknown[] = [value];
  const text: string[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    if (typeof record.text === 'string') text.push(record.text);
    if (record.doc && typeof record.doc === 'object') pending.push(record.doc);
    if (Array.isArray(record.content)) pending.push(...[...record.content].reverse());
  }
  return text.join('').replace(/\s+/g, ' ').trim();
}

function mediaIds(post: { availability: string; mediaIds?: string[] }): string[] {
  return post.availability === 'available' ? (post.mediaIds ?? []).filter((id) => uuid.test(id)) : [];
}

async function run(command: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code}`);
}

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  return { status: response.status, body: (await response.json()) as T };
}

async function open(page: Page, href: string): Promise<Response | null> {
  const response = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
  return response;
}

function localizedPath(locale: string, route: string): string {
  const stripped = route.replace(/^\/(en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?=\/)/, '');
  return `/${locale}${stripped.startsWith('/') ? stripped : `/${stripped}`}`;
}

async function followAndReturn(page: Page, link: ReturnType<Page['locator']>, stay: string): Promise<string> {
  const href = await link.getAttribute('href');
  if (!href) throw new Error('Disclosed link has no href');
  await link.click();
  await page.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
  const destination = new URL(page.url()).pathname;
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
  if (!new URL(page.url()).pathname.includes(stay))
    throw new Error(`Return missed ${stay}: ${page.url()}`);
  return destination;
}

async function compareReading(page: Page, kernel: string, threadId: string, postId: string): Promise<{
  title: string | null;
  opening: string;
  replies: number;
  next: string | null;
  media: string[];
  nativeStatus: number;
}> {
  const native = await json<ReadingPage>(`${kernel}/v1/threads/${threadId}/reading-page`);
  if (native.status !== 200) throw new Error(`Native reading-page returned ${native.status}`);
  if (native.body.thread.id !== threadId) throw new Error('Native reading-page thread identity drifted');
  const opening = documentText(native.body.thread.firstPost.body);
  const replyTexts = native.body.replies.items
    .filter((item) => item.availability === 'available')
    .map((item) => documentText(item.body));
  const rendered = (await page.locator('[data-slot="document-body"]').allInnerTexts())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (opening && !rendered.includes(opening))
    throw new Error(`Rendered body missing native opening text: ${opening}`);
  for (const reply of replyTexts)
    if (reply && !rendered.includes(reply)) throw new Error(`Rendered body missing native reply text: ${reply}`);
  const frame = page.locator(`#post-${postId}`);
  await frame.waitFor({ state: 'visible' });
  const shownMedia = await page.locator('[data-slot="document-image"]').evaluateAll((nodes) =>
    nodes
      .map((node) => node.getAttribute('data-media-id') ?? node.getAttribute('src') ?? '')
      .filter(Boolean),
  );
  const expectedMedia = [
    ...mediaIds(native.body.thread.firstPost),
    ...native.body.replies.items.flatMap((item) => mediaIds(item)),
  ];
  if (expectedMedia.length === 0 && shownMedia.length !== 0)
    throw new Error('Rendered attachments without native media identities');
  for (const id of expectedMedia)
    if (!shownMedia.some((value) => value.includes(id)))
      throw new Error(`Rendered attachments missing native media ${id}`);
  return {
    title: native.body.thread.title,
    opening,
    replies: native.body.replies.items.length,
    next: native.body.replies.next,
    media: expectedMedia,
    nativeStatus: native.status,
  };
}

async function continueReplies(page: Page, kernel: string, threadId: string, next: string | null): Promise<{
  continued: boolean;
  retried: boolean;
}> {
  if (!next) return { continued: false, retried: false };
  const nextLink = page.locator(`nav a[href*="cursor="]`).first();
  const href = await nextLink.getAttribute('href');
  if (!href || !decodeURIComponent(href).includes(next)) throw new Error('Next-page link dropped the supplied cursor');
  await nextLink.click();
  await page.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
  const alert = page.locator('section[role="alert"]');
  if ((await alert.count()) > 0) {
    await alert.locator('a').first().click();
    await page.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
    return { continued: true, retried: true };
  }
  const continued = await json<ReadingPage>(
    `${kernel}/v1/threads/${threadId}/reading-page?cursor=${encodeURIComponent(next)}`,
  );
  if (continued.status === 400) {
    const restart = page.locator('section[role="alert"] a').first();
    if ((await restart.count()) > 0) await restart.click();
    else await open(page, new URL(`/en/threads/${threadId}`, page.url()).href);
    await page.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
    return { continued: true, retried: true };
  }
  if (continued.status !== 200) throw new Error(`Native continuation returned ${continued.status}`);
  return { continued: true, retried: false };
}

async function retryInvalidCursorOnce(page: Page, web: string, threadId: string): Promise<void> {
  await open(page, `${web}/en/threads/${threadId}?cursor=not-a-native-cursor`);
  const alert = page.locator('section[role="alert"]');
  await alert.waitFor({ state: 'visible', timeout: 30_000 });
  await alert.locator('a').first().click();
  await page.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
  if (new URL(page.url()).searchParams.has('cursor')) throw new Error('First-page restart retained the refused cursor');
}

async function walkPersona(
  page: Page,
  input: {
    web: string;
    kernel: string;
    locale: string;
    workPath: string;
    boardId: string;
    threadId: string;
    postId: string;
    width: number;
    theme: 'light' | 'dark';
  },
): Promise<Record<string, unknown>> {
  await page.setViewportSize({ width: input.width, height: 1000 });
  await page.emulateMedia({ colorScheme: input.theme });
  await page.context().addCookies([{ name: 'rezics_theme', value: input.theme, url: input.web }]);
  const work = await open(page, `${input.web}${localizedPath(input.locale, input.workPath)}`);
  if (work && work.status() >= 400) throw new Error(`Work page returned ${work.status()}`);
  const boardLink = page.locator(`a[href*="/boards/${input.boardId}"]`).first();
  await boardLink.waitFor({ state: 'visible', timeout: 60_000 });
  await boardLink.click();
  await page.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
  const boardNative = await json<BoardPage>(`${input.kernel}/v1/boards/${input.boardId}/page`);
  if (boardNative.status !== 200) throw new Error(`Native board page returned ${boardNative.status}`);
  const threadRow = page.locator(`[data-thread-id="${input.threadId}"]`).first();
  await threadRow.waitFor({ state: 'visible', timeout: 60_000 });
  const threadLink = threadRow.locator('a[href*="/threads/"]').first();
  await threadLink.click();
  await page.locator('main').waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator(`#thread-${input.threadId}`).waitFor({ state: 'visible', timeout: 60_000 });
  const reading = await compareReading(page, input.kernel, input.threadId, input.postId);
  const context = page.locator('nav a[href*="/boards/"], nav a[href*="/realms/"]').first();
  const author = page.locator('a[href*="/@"]').first();
  const subject = page.locator('ul a[href*="/subjects/"]').first();
  const destinations: Record<string, string> = {};
  if ((await context.count()) > 0)
    destinations.context = await followAndReturn(page, context, '/threads/');
  if ((await author.count()) > 0) destinations.author = await followAndReturn(page, author, '/threads/');
  if ((await subject.count()) > 0) destinations.subject = await followAndReturn(page, subject, '/threads/');
  const continuation = await continueReplies(page, input.kernel, input.threadId, reading.next);
  return {
    locale: input.locale,
    width: input.width,
    theme: input.theme,
    workStatus: work?.status() ?? null,
    boardStatus: boardNative.status,
    boardNext: boardNative.next,
    threadTitle: reading.title,
    opening: reading.opening,
    replies: reading.replies,
    media: reading.media,
    destinations,
    continuation,
    url: new URL(page.url()).pathname,
  };
}

async function signUp(page: Page, web: string, issuer: string): Promise<{ handle: string }> {
  const handle = `walk${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const email = `${handle}@rezics.test`;
  const password = 'Board-thread-reading-walk-9f3a';
  await open(page, `${web}/en/`);
  await page.getByRole('link', { name: 'Sign in' }).first().click();
  await page.waitForURL(/\/login|\/signin|\/session/, { timeout: 60_000 });
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.waitForURL(/\/signup/, { timeout: 60_000 });
  await page.locator('#signup-handle').fill(handle);
  await page.locator('#signup-email').fill(email);
  await page.locator('#signup-password').fill(password);
  await page.locator('#signup-confirm-password').fill(password);
  await page.getByText('Local development verification').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.waitForURL((url) => url.origin === web, { timeout: 90_000 });
  if (!page.url().startsWith(web)) throw new Error(`Signup did not return to Web: ${page.url()} (issuer ${issuer})`);
  return { handle };
}

async function main(): Promise<void> {
  const web = origin('REZICS_LOCAL_STACK_WEB_ORIGIN', 'http://127.0.0.1:3000');
  const kernel = origin('REZICS_LOCAL_STACK_KERNEL_ORIGIN', 'http://127.0.0.1:4100');
  const issuer = origin('REZICS_LOCAL_STACK_ISSUER_ORIGIN', 'http://127.0.0.1:4200');
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await run(['go-task', 'seed:dev']);
  const seed = (await Bun.file(seedResultPath).json()) as SeedResult;
  const community = seed.developmentShowcase?.community;
  if (!community || community.state !== 'published' || !uuid.test(community.board.id) || !uuid.test(community.thread.threadId))
    throw new Error('Seed did not publish a discussion Board and thread');
  const reading = seed.readings?.find(
    (item) => item.source === 'vndb' && item.externalId === community.source.externalId && item.selection === 'selected',
  );
  const workPath =
    reading?.route ??
    `/subjects/${community.source.subjectId}`;
  const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim();
  const userDataDir = join('/tmp', `rz-${process.pid}`);
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    viewport: { width: 1440, height: 1000 },
  });
  const journeys: Record<string, unknown>[] = [];
  try {
    const anonymous = await context.newPage();
    anonymous.setDefaultTimeout(60_000);
    for (const locale of primaryLocales)
      for (const width of [390, 1440])
        for (const theme of ['light', 'dark'] as const)
          journeys.push(
            await walkPersona(anonymous, {
              web,
              kernel,
              locale,
              workPath,
              boardId: community.board.id,
              threadId: community.thread.threadId,
              postId: community.thread.postId,
              width,
              theme,
            }),
          );
    await retryInvalidCursorOnce(anonymous, web, community.thread.threadId);
    await anonymous.close();
    const member = await context.newPage();
    member.setDefaultTimeout(60_000);
    const signedUp = await signUp(member, web, issuer);
    journeys.push({
      persona: 'ordinary-member',
      handle: signedUp.handle,
      ...(await walkPersona(member, {
        web,
        kernel,
        locale: 'en',
        workPath,
        boardId: community.board.id,
        threadId: community.thread.threadId,
        postId: community.thread.postId,
        width: 1280,
        theme: 'light',
      })),
    });
    await retryInvalidCursorOnce(member, web, community.thread.threadId);
    await member.close();
  } finally {
    await context.close();
  }
  const evidence = {
    sourceRevision: revision,
    stack: { web, kernel, issuer, slot: process.env.REZICS_WALK_STACK_SLOT ?? null },
    personas: ['anonymous', 'ordinary-member'],
    community: {
      subjectId: community.source.subjectId,
      boardId: community.board.id,
      threadId: community.thread.threadId,
      postId: community.thread.postId,
    },
    journeys,
  };
  const evidencePath = join(evidenceDir, 'acceptance.json');
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await chmod(evidencePath, 0o600);
  console.log(`Board thread reading walk passed for anonymous and ordinary-member (${journeys.length} visits).`);
}

await main();
