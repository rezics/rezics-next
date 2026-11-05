import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import {
  createPublishAttachmentWorkBoard,
  trustAccount,
  type PublishAttachmentWorkBoard,
} from './publish-attachment-reply-fixture.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

setDefaultTimeout(900_000);

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;
const touchedLabels = [
  'board_start_thread',
  'thread_new_heading',
  'thread_title_label',
  'thread_new_body_label',
  'thread_reply_label',
  'thread_write_send',
  'editor_image',
  'editor_upload_file',
  'editor_insert_image',
  'editor_retry_upload',
  'editor_upload_type',
  'thread_attachment_replace',
  'thread_attachment_exact_retry',
  'thread_authoring_stay',
  'thread_authoring_leave',
] as const;

type NativeAttachment = {
  id: string;
  state: string;
  byteCount: number;
  sha256: string | null;
  containerId: string;
};

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let originalImage: Buffer;
let stack: NativeWebStack;
let auth: NativeAuthStack;
let board: PublishAttachmentWorkBoard;

function kernelProblem(status: number, code: string, title: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: `https://rezics.com/problems/${code}`,
    title,
    status,
    code,
    request_id: crypto.randomUUID(),
    ...extra,
  });
}

async function hydrate(page: Page) {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function expectVisible(locator: { waitFor: (options: { state: 'visible'; timeout: number }) => Promise<void> }) {
  await locator.waitFor({ state: 'visible', timeout: 30_000 });
}

async function editor(page: Page) {
  const node = page.locator('.ProseMirror[contenteditable="true"]').last();
  await expectVisible(node);
  return node;
}

async function waitForAvailableMedia(id: string, page: Page): Promise<NativeAttachment> {
  const deadline = Date.now() + 60_000;
  let lastState = 'unknown';
  while (Date.now() < deadline) {
    const response = await page.request.get(`${stack.web}/media/${id}`);
    if (!response.ok)
      throw new Error(`Reservation read failed while waiting for processing (${response.status()} ${id})`);
    const media = ((await response.json()) as { media: NativeAttachment }).media;
    lastState = media.state;
    if (media.state === 'available') return media;
    if (media.state === 'rejected' || media.state === 'erased')
      throw new Error(`Native image processing ended in ${media.state}`);
    await Bun.sleep(250);
  }
  throw new Error(`Native image processing did not become available (last state: ${lastState})`);
}

async function signUpMember(returnTo: string): Promise<{
  context: BrowserContext;
  page: Page;
  accountId: string;
  handle: string;
}> {
  const context = await auth.newContext('newcomer');
  const page = await context.newPage();
  const handle = `member-${crypto.randomUUID().slice(0, 8)}`;
  const email = `member-${crypto.randomUUID()}@example.test`;
  const password = `Member-${crypto.randomUUID()}-Secure-9`;
  await page.goto(`${stack.web}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, {
    waitUntil: 'domcontentloaded',
  });
  await hydrate(page);
  if (new URL(page.url()).origin !== new URL(stack.web).origin) {
    await page
      .getByRole('link', { name: /create an account|sign up/i })
      .first()
      .click();
    await page.waitForURL((url) => new URL(url).pathname === '/signup');
    await hydrate(page);
    await page.getByLabel('Handle', { exact: true }).fill(handle);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    const created = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/signup' && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
    const signup = await created;
    expect(signup.status()).toBe(201);
    const body = (await signup.json()) as { accountId?: unknown };
    expect(typeof body.accountId).toBe('string');
    await page.waitForURL((url) => url.origin === new URL(stack.web).origin && !url.pathname.startsWith('/auth/'), {
      timeout: 30_000,
    });
    await page.locator('#account-menu-button').waitFor({ state: 'visible' });
    await trustAccount(stack, body.accountId as string);
    return { context, page, accountId: body.accountId as string, handle };
  }
  throw new Error(`Sign-up did not reach Auth from ${page.url()}`);
}

async function insertImage(page: Page, name: string, alt: string, buffer: Buffer, mimeType: string) {
  const image = page.getByRole('button', { name: 'Image', exact: true });
  await expectVisible(image);
  await image.click();
  const dialog = page.getByRole('dialog', { name: 'Image' });
  await expectVisible(dialog);
  await dialog.getByLabel('Choose image file', { exact: true }).setInputFiles({ name, mimeType, buffer });
  await dialog.getByLabel('Alt text', { exact: true }).fill(alt);
  await dialog.getByRole('button', { name: 'Insert image', exact: true }).click();
}

async function send(page: Page) {
  const button = page.getByRole('button', { name: 'Send', exact: true });
  await expectVisible(button);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await button.isDisabled())) {
      await button.click();
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error('Send stayed disabled');
}

function documentHas(value: unknown, needle: string): boolean {
  return JSON.stringify(value).includes(needle);
}

beforeAll(async () => {
  originalImage = await readFile(resolve(import.meta.dir, '../../public/cards/default.png'));
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
  board = await createPublishAttachmentWorkBoard(stack);
}, 360_000);

afterAll(async () => {
  try {
    await auth?.stop();
  } finally {
    await stack?.stop();
  }
}, 180_000);

test('ordinary members publish a Work Board post with an attachment, reply, recover, replace, and leave a dirty draft', async () => {
  const sequence: string[] = [];
  const author = await signUpMember(board.boardUrl);
  sequence.push(`signup-author:${author.accountId}`);
  const authorPage = author.page;
  await authorPage.setViewportSize({ width: 390, height: 844 });
  await authorPage.emulateMedia({ colorScheme: 'light' });
  await hydrate(authorPage);
  await expectVisible(authorPage.getByRole('heading', { name: board.boardTitle }));
  await authorPage.getByRole('link', { name: 'Start a new thread', exact: true }).click();
  await authorPage.waitForURL((url) => url.pathname.endsWith('/new'));
  await hydrate(authorPage);
  sequence.push(`new-thread:${new URL(authorPage.url()).pathname}`);
  await expectVisible(authorPage.getByRole('heading', { name: 'Start a new thread' }));
  await authorPage.getByLabel('Title', { exact: true }).fill('Opening chart from the work board');
  await (await editor(authorPage)).fill('See this attached chart.');

  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/media',
    status: 503,
    body: kernelProblem(503, 'dependency_unavailable', 'dependency_unavailable', {
      retryable: true,
      effect_status: 'not_applied',
    }),
  });
  const failedReserve = authorPage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/media' && response.request().method() === 'POST',
  );
  await insertImage(authorPage, 'opening.png', 'Opening chart', originalImage, 'image/png');
  expect((await failedReserve).status()).toBeGreaterThanOrEqual(500);
  sequence.push('author-reserve-503');
  const failedRow = authorPage.getByRole('group').filter({ hasText: 'Opening chart' });
  await expectVisible(failedRow.getByRole('status'));
  await expectVisible(failedRow.getByRole('button', { name: 'Retry upload', exact: true }));
  expect(await failedRow.innerText()).toMatch(/original reservation/i);

  const reserved = authorPage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/media' && response.request().method() === 'POST',
  );
  const uploaded = authorPage.waitForResponse(
    (response) => /^\/media\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === 'PUT',
  );
  await failedRow.getByRole('button', { name: 'Retry upload', exact: true }).click();
  const reservation = await reserved;
  expect(reservation.status()).toBe(201);
  const mediaId = ((await reservation.json()) as { media: NativeAttachment }).media.id;
  expect((await uploaded).status()).toBe(200);
  await waitForAvailableMedia(mediaId, authorPage);
  await expectVisible(authorPage.getByRole('img', { name: 'Opening chart' }));
  sequence.push(`author-media:${mediaId}`);

  await send(authorPage);
  await authorPage.waitForURL((url) => /\/threads\/[0-9a-f-]{36}/i.test(url.pathname), { timeout: 30_000 });
  const threadId = new URL(authorPage.url()).pathname.match(/\/threads\/([0-9a-f-]{36})/i)?.[1];
  expect(threadId).toBeTruthy();
  sequence.push(`published-thread:${threadId}`);
  await expectVisible(authorPage.getByRole('img', { name: 'Opening chart' }));

  const nativeThread = await stack.kernel(`/v1/threads/${threadId}`);
  expect(nativeThread.status).toBe(200);
  const threadRead = (await nativeThread.json()) as {
    thread: { id: string; boardId: string; title: string; firstPost: { mediaIds?: string[]; body: unknown } };
  };
  expect(threadRead.thread.boardId).toBe(board.boardId);
  expect(threadRead.thread.title).toBe('Opening chart from the work board');
  expect(threadRead.thread.firstPost.mediaIds).toEqual([mediaId]);
  expect(documentHas(threadRead.thread.firstPost.body, mediaId)).toBe(true);
  expect(documentHas(threadRead.thread.firstPost.body, 'Opening chart')).toBe(true);

  await authorPage.setViewportSize({ width: 1280, height: 800 });
  await authorPage.emulateMedia({ colorScheme: 'dark' });
  await authorPage.reload({ waitUntil: 'domcontentloaded' });
  await hydrate(authorPage);
  await expectVisible(authorPage.getByRole('img', { name: 'Opening chart' }));

  const anonymous = await auth.newContext('anonymous');
  const anonymousPage = await anonymous.newPage();
  await anonymousPage.setViewportSize({ width: 1440, height: 900 });
  await anonymousPage.goto(authorPage.url(), { waitUntil: 'domcontentloaded' });
  await hydrate(anonymousPage);
  await expectVisible(anonymousPage.getByRole('heading', { name: 'Opening chart from the work board' }));
  await expectVisible(anonymousPage.getByRole('img', { name: 'Opening chart' }));
  expect(await anonymousPage.getByRole('textbox', { name: 'Reply' }).count()).toBe(0);
  sequence.push('anonymous-read');

  const jaPage = await anonymous.newPage();
  const jaUrl = new URL(authorPage.url());
  jaUrl.pathname = jaUrl.pathname.replace(/^\/en\//, '/ja/');
  await jaPage.goto(jaUrl.href, { waitUntil: 'domcontentloaded' });
  await hydrate(jaPage);
  await expectVisible(jaPage.getByRole('img', { name: 'Opening chart' }));
  const zhUrl = new URL(authorPage.url());
  zhUrl.pathname = zhUrl.pathname.replace(/^\/en\//, '/zh-Hant/');
  await jaPage.goto(zhUrl.href, { waitUntil: 'domcontentloaded' });
  await hydrate(jaPage);
  await expectVisible(jaPage.getByRole('img', { name: 'Opening chart' }));
  await jaPage.close();

  const replier = await signUpMember(authorPage.url());
  sequence.push(`signup-replier:${replier.accountId}`);
  const replyPage = replier.page;
  await replyPage.setViewportSize({ width: 1280, height: 800 });
  await hydrate(replyPage);
  await expectVisible(replyPage.getByRole('img', { name: 'Opening chart' }));
  const replyEditor = await editor(replyPage);
  await replyEditor.fill('A second reading of the same chart.');

  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/media',
    status: 415,
    body: kernelProblem(415, 'invalid_request', 'Invalid Request'),
  });
  const refusedReserve = replyPage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/media' && response.request().method() === 'POST',
  );
  await insertImage(replyPage, 'chart.png', 'Reply chart', png, 'image/png');
  expect((await refusedReserve).status()).toBe(415);
  const replaceRow = replyPage.getByRole('group').filter({ hasText: 'Reply chart' });
  await expectVisible(replaceRow.getByText('not accepted', { exact: false }));
  await expectVisible(replaceRow.getByRole('button', { name: 'Replace image', exact: true }));
  sequence.push('replier-type-refusal');
  const replyReserved = replyPage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/media' && response.request().method() === 'POST',
  );
  const replyUploaded = replyPage.waitForResponse(
    (response) => /^\/media\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === 'PUT',
  );
  await replaceRow.getByLabel('Replace image', { exact: true }).setInputFiles({
    name: 'reply.png',
    mimeType: 'image/png',
    buffer: png,
  });
  const replyReservation = await replyReserved;
  expect(replyReservation.status()).toBe(201);
  const replyMediaId = ((await replyReservation.json()) as { media: NativeAttachment }).media.id;
  expect((await replyUploaded).status()).toBe(200);
  await waitForAvailableMedia(replyMediaId, replyPage);
  await expectVisible(replyPage.getByRole('img', { name: 'Reply chart' }));
  sequence.push(`replier-media:${replyMediaId}`);

  await replyPage.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: board.boardTitle }).click();
  const departure = replyPage.getByRole('alertdialog');
  await expectVisible(departure.getByRole('button', { name: 'Stay', exact: true }));
  await departure.getByRole('button', { name: 'Stay', exact: true }).click();
  await departure.waitFor({ state: 'hidden', timeout: 15_000 });
  expect(new URL(replyPage.url()).pathname).toContain(`/threads/${threadId}`);
  await expectVisible(replyPage.getByRole('img', { name: 'Reply chart' }));
  sequence.push('dirty-departure-stay');

  await send(replyPage);
  await expectVisible(replyPage.getByRole('img', { name: 'Reply chart' }).last());

  const postsResponse = await stack.kernel(`/v1/threads/${threadId}/posts`);
  expect(postsResponse.status).toBe(200);
  const posts = (await postsResponse.json()) as { posts: { id: string; mediaIds?: string[]; body: unknown }[] };
  expect(posts.posts.some((post) => post.mediaIds?.includes(mediaId) && documentHas(post.body, 'Opening chart'))).toBe(
    true,
  );
  expect(
    posts.posts.some((post) => post.mediaIds?.includes(replyMediaId) && documentHas(post.body, 'Reply chart')),
  ).toBe(true);

  await anonymousPage.reload({ waitUntil: 'domcontentloaded' });
  await hydrate(anonymousPage);
  await expectVisible(anonymousPage.getByRole('img', { name: 'Opening chart' }));
  await expectVisible(anonymousPage.getByRole('img', { name: 'Reply chart' }));

  const storedOpening = await waitForAvailableMedia(mediaId, authorPage);
  expect(storedOpening).toMatchObject({
    id: mediaId,
    byteCount: originalImage.byteLength,
    sha256: sha256(originalImage),
    state: 'available',
  });
  const storedReply = await waitForAvailableMedia(replyMediaId, replyPage);
  expect(storedReply).toMatchObject({
    id: replyMediaId,
    byteCount: png.byteLength,
    sha256: sha256(png),
    state: 'available',
  });

  const messagesRoot = resolve(import.meta.dir, '../../messages');
  for (const locale of locales) {
    const catalog = JSON.parse(await readFile(resolve(messagesRoot, `${locale}.json`), 'utf8')) as Record<
      string,
      string
    >;
    for (const key of touchedLabels) {
      expect(typeof catalog[key], `${locale} ${key}`).toBe('string');
      expect(catalog[key]!.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
    }
  }

  const evidenceDirectory = resolve(import.meta.dir, '../../../../.temp/publish-attachment-reply');
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    resolve(evidenceDirectory, 'walk.json'),
    `${JSON.stringify(
      {
        stack: { kind: 'native-isolated', web: stack.web, kernel: stack.kernelOrigin },
        personas: {
          author: { role: 'ordinary-member', accountId: author.accountId, handle: author.handle },
          replier: { role: 'ordinary-member', accountId: replier.accountId, handle: replier.handle },
          anonymous: { role: 'anonymous-reader' },
        },
        board: { id: board.boardId, title: board.boardTitle, conceptId: board.conceptId },
        thread: { id: threadId, title: threadRead.thread.title },
        media: {
          opening: { id: mediaId, byteCount: storedOpening.byteCount, state: storedOpening.state },
          reply: { id: replyMediaId, byteCount: storedReply.byteCount, state: storedReply.state },
        },
        sequence,
        nativePosts: posts.posts.map((post) => ({ id: post.id, mediaIds: post.mediaIds ?? [] })),
      },
      null,
      2,
    )}\n`,
  );

  await author.context.close();
  await replier.context.close();
  await anonymous.close();
});

