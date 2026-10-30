import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fromPlainText } from '@rezics/document';
import type { Locator, Page } from 'playwright';
import { newId, routeOf } from '../../../../services/kernel/src/route/route.ts';
import { startAuthStack } from './auth-stack.ts';
import { createNativeDiscussionFixture } from './native-discussion-fixture.ts';
import { startNativeWebStack, type NativeKernelRequest, type NativeWebStack } from './stack.ts';

const timeout = 900_000;
let stack: NativeWebStack | undefined;
let auth: Awaited<ReturnType<typeof startAuthStack>> | undefined;

afterAll(async () => {
  try {
    await auth?.stop();
  } finally {
    await stack?.stop();
  }
}, 240_000);

async function responseJson<T>(response: Response, status = 200): Promise<T> {
  const body = await response
    .clone()
    .json()
    .catch(async () => await response.text());
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

function accountReadCount(requests: readonly NativeKernelRequest[]): number {
  return requests.filter((request) => new URL(request.url, 'http://kernel.test').pathname === '/v1/accounts').length;
}

async function requestsNow(): Promise<readonly NativeKernelRequest[]> {
  await stack!.syncKernelRequests();
  return stack!.kernelRequests();
}

function threadIdsOnPage(page: Page): Promise<string[]> {
  return page
    .locator('a[href*="/threads/"]')
    .evaluateAll((links) =>
      links
        .map((link) => new URL((link as HTMLAnchorElement).href).pathname.match(/\/threads\/([0-9a-f-]{36})/i)?.[1])
        .filter((id): id is string => Boolean(id)),
    );
}

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function fillEditor(scope: Page | Locator, value: string): Promise<void> {
  const editor = scope.locator('[contenteditable="true"]').last();
  await editor.waitFor({ state: 'visible' });
  await editor.fill(value);
}

async function submitWithKeyboard(page: Page, name = 'Send'): Promise<void> {
  const button = page.getByRole('button', { name, exact: true }).last();
  await button.waitFor({ state: 'visible' });
  await expect(button).toBeEnabled();
  await button.focus();
  await page.keyboard.press('Enter');
}

async function waitFor<T>(
  read: () => Promise<T>,
  isReady: (value: T) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T | undefined;
  do {
    latest = await read();
    if (isReady(latest)) return latest;
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(latest)}`);
}

function withoutRequestId(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const normalized = { ...(body as Record<string, unknown>) };
  delete normalized.request_id;
  delete normalized.requestId;
  return normalized;
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
    const children = record.content;
    if (Array.isArray(children)) pending.push(...children.reverse());
  }
  return text.join('');
}

test(
  'native public and protected discussion journeys use real sessions, bounded native pages, and current access',
  async () => {
    const priorPrivacyContact = process.env.PRIVACY_CONTACT_URL;
    process.env.PRIVACY_CONTACT_URL = 'mailto:privacy@example.test';
    try {
      stack = await startNativeWebStack();
      auth = await startAuthStack(stack);
    } finally {
      if (priorPrivacyContact === undefined) delete process.env.PRIVACY_CONTACT_URL;
      else process.env.PRIVACY_CONTACT_URL = priorPrivacyContact;
    }
    const fixture = await createNativeDiscussionFixture(stack);
    const alice = await auth.signIn('alice');
    const bob = await auth.signIn('bob');
    expect((await alice.response()).status()).toBe(200);
    expect((await bob.response()).status()).toBe(200);
    expect((await alice.requestHeaders()).every((headers) => !headers.has('authorization'))).toBe(true);
    expect((await bob.requestHeaders()).every((headers) => !headers.has('authorization'))).toBe(true);
    const aliceCookies = await alice.context.cookies(stack.web);
    const bobCookies = await bob.context.cookies(stack.web);
    expect(aliceCookies.some(({ name }) => name === '__Host-rezics_session')).toBe(true);
    expect(bobCookies.some(({ name }) => name === '__Host-rezics_session')).toBe(true);
    const alicePage = alice.context.pages().at(-1)!;
    const bobPage = bob.context.pages().at(-1)!;
    const anonymousContext = await auth.context('suspended');
    const anonymousPage = await anonymousContext.newPage();

    // The served New sort follows each native cursor in its emitted order.
    const nativeBoardIds: string[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: '20' });
      if (cursor) query.set('cursor', cursor);
      const page = await responseJson<{ threads: { id: string }[]; next: string | null }>(
        await stack.kernel(`/v1/boards/${fixture.publicBoard.id}/threads?${query}`),
      );
      nativeBoardIds.push(...page.threads.map(({ id }) => id));
      cursor = page.next ?? undefined;
    } while (cursor);
    expect(nativeBoardIds).toEqual(fixture.publicThreads.map(({ id }) => id).reverse());

    let boardRequests = (await requestsNow()).length;
    await anonymousPage.goto(`${stack.web}/en/boards/${fixture.publicBoard.id}?sort=new`, {
      waitUntil: 'domcontentloaded',
    });
    await hydrate(anonymousPage);
    await anonymousPage.getByRole('heading', { name: fixture.publicBoard.title, exact: true }).waitFor();
    const firstRenderedIds = await threadIdsOnPage(anonymousPage);
    expect(firstRenderedIds).toEqual(nativeBoardIds.slice(0, 20));
    expect(accountReadCount((await requestsNow()).slice(boardRequests))).toBe(1);
    await mkdir(join(import.meta.dir, '../../../../.temp'), { recursive: true });
    await anonymousPage.screenshot({
      path: join(import.meta.dir, '../../../../.temp/native-discussion-public-board.png'),
    });
    const startBoundary = anonymousPage.getByRole('link', { name: 'Sign in to start a thread', exact: true });
    await startBoundary.focus();
    expect(new URL(await startBoundary.getAttribute('href')!, stack.web).pathname).toBe('/auth/sign-in');

    boardRequests = (await requestsNow()).length;
    await anonymousPage.getByRole('link', { name: 'Next page', exact: true }).click();
    await anonymousPage.waitForURL((url) => url.searchParams.has('cursor'));
    await anonymousPage.getByRole('link', { name: 'Native board thread 01', exact: true }).waitFor();
    expect(await threadIdsOnPage(anonymousPage)).toEqual(nativeBoardIds.slice(20));
    expect(accountReadCount((await requestsNow()).slice(boardRequests))).toBe(1);
    expect(await anonymousPage.getByRole('link', { name: 'Next page', exact: true }).count()).toBe(0);

    // Public posts retain their authors, with one accounts batch for the page.
    const publicThread = fixture.publicThreads[0]!;
    const publicThreadStart = (await requestsNow()).length;
    await anonymousPage.goto(`${stack.web}/en/threads/${publicThread.id}`, { waitUntil: 'domcontentloaded' });
    await hydrate(anonymousPage);
    await anonymousPage.getByText('Opening post 01', { exact: true }).waitFor();
    await anonymousPage.getByText('Attributed reply by Bob', { exact: true }).waitFor();
    expect(accountReadCount((await requestsNow()).slice(publicThreadStart))).toBe(1);
    expect(await anonymousPage.getByRole('link', { name: 'Sign in to reply', exact: true }).count()).toBe(1);
    const publicPosts = await waitFor(
      async () =>
        responseJson<{ posts: { id: string; authorId: string; body: unknown }[] }>(
          await stack!.kernel(`/v1/threads/${publicThread.id}/posts?limit=20`),
        ),
      ({ posts }) => posts.some((post) => documentText(post.body) === 'Attributed reply by Bob'),
      'Bob reply in the native thread post page',
    );
    const attributedReply = publicPosts.posts.find((post) => documentText(post.body) === 'Attributed reply by Bob');
    expect(attributedReply).toMatchObject({ authorId: fixture.bobId });
    const publicIdentities = await responseJson<{
      accounts: { id: string; displayName: string | null; handle: string; state: string }[];
    }>(await stack.kernel(`/v1/accounts?ids=${fixture.aliceId},${fixture.bobId}`));
    const bylineIdentities = new Map(publicIdentities.accounts.map((account) => [account.id, account]));
    expect(bylineIdentities.get(fixture.aliceId)?.state).toBe('active');
    expect(bylineIdentities.get(fixture.bobId)?.state).toBe('active');
    for (const [postId, accountId] of [
      [publicThread.firstPost.id, fixture.aliceId],
      [attributedReply!.id, fixture.bobId],
    ]) {
      const slotText = await anonymousPage.locator(`#post-${postId}`).innerText();
      const account = bylineIdentities.get(accountId)!;
      expect(slotText).toContain(account.displayName || `@${account.handle}`);
    }

    // A protected board is indistinguishable from an unknown board until an owner adds Bob.
    const unknownBoard = newId(routeOf(fixture.banBoard.id)!);
    const protectedApi = await stack.kernel(`/v1/boards/${fixture.banBoard.id}/threads?sort=newest&limit=20`);
    const unknownApi = await stack.kernel(`/v1/boards/${unknownBoard}/threads?sort=newest&limit=20`);
    expect(protectedApi.status).toBe(404);
    expect(unknownApi.status).toBe(404);
    expect(withoutRequestId(await protectedApi.json())).toEqual(withoutRequestId(await unknownApi.json()));
    const protectedPageResponse = await anonymousPage.goto(`${stack.web}/en/boards/${fixture.banBoard.id}`);
    const protectedBody = await anonymousPage.locator('body').innerText();
    const unknownPageResponse = await anonymousPage.goto(`${stack.web}/en/boards/${unknownBoard}`);
    expect(protectedPageResponse?.status()).toBe(404);
    expect(unknownPageResponse?.status()).toBe(404);
    expect(await anonymousPage.locator('body').innerText()).toBe(protectedBody);
    const protectedBobApi = await stack.kernel(
      `/v1/boards/${fixture.banBoard.id}/threads?sort=newest&limit=20`,
      undefined,
      'bob',
    );
    const unknownBobApi = await stack.kernel(
      `/v1/boards/${unknownBoard}/threads?sort=newest&limit=20`,
      undefined,
      'bob',
    );
    expect(protectedBobApi.status).toBe(404);
    expect(unknownBobApi.status).toBe(404);
    expect(withoutRequestId(await protectedBobApi.json())).toEqual(withoutRequestId(await unknownBobApi.json()));
    const protectedBobPageResponse = await bobPage.goto(`${stack.web}/en/boards/${fixture.banBoard.id}`);
    const protectedBobBody = await bobPage.locator('body').innerText();
    const unknownBobPageResponse = await bobPage.goto(`${stack.web}/en/boards/${unknownBoard}`);
    expect(protectedBobPageResponse?.status()).toBe(404);
    expect(unknownBobPageResponse?.status()).toBe(404);
    expect(await bobPage.locator('body').innerText()).toBe(protectedBobBody);
    await fixture.addMember(fixture.banRealmId, fixture.bobId);
    await waitFor(
      async () => {
        const response = await stack.kernel(`/v1/realms/${fixture.banRealmId}/members/me`, undefined, 'bob');
        if (!response.ok)
          return `HTTP ${response.status}: ${JSON.stringify(
            await response
              .clone()
              .json()
              .catch(() => null),
          )}`;
        return ((await response.json()) as { state: string }).state;
      },
      (state) => state === 'member',
      'Bob protected Realm membership grant',
      90_000,
    );
    const memberPageRequestStart = (await requestsNow()).length;
    await bobPage.goto(`${stack.web}/en/boards/${fixture.banBoard.id}`, { waitUntil: 'domcontentloaded' });
    await hydrate(bobPage);
    await bobPage.getByRole('heading', { name: fixture.banBoard.title, exact: true }).waitFor();
    const memberPageRequests = (await requestsNow()).slice(memberPageRequestStart);
    for (const path of [`/v1/boards/${fixture.banBoard.id}`, `/v1/boards/${fixture.banBoard.id}/threads`]) {
      expect(
        memberPageRequests.find((request) => new URL(request.url, 'http://kernel.test').pathname === path),
      ).toMatchObject({ authorization: expect.any(String) });
    }

    // Alice creates, replies, and revises through the served controls; native reads prove the stored revision.
    await alicePage.goto(`${stack.web}/en/boards/${fixture.publicBoard.id}/new`, { waitUntil: 'domcontentloaded' });
    await hydrate(alicePage);
    await alicePage.getByLabel('Title', { exact: true }).fill('Alice native thread');
    await fillEditor(alicePage, 'Alice opening body');
    await submitWithKeyboard(alicePage);
    await alicePage.waitForURL((url) => /\/en\/threads\/[0-9a-f-]{36}/i.test(url.pathname));
    const createdThreadId = new URL(alicePage.url()).pathname.match(/\/threads\/([0-9a-f-]{36})/i)?.[1];
    expect(createdThreadId).toBeTruthy();
    const createdThread = await responseJson<{
      thread: {
        id: string;
        authorId: string;
        firstPost: { id: string; authorId: string; revisionId: string; body: unknown };
      };
    }>(await stack.kernel(`/v1/threads/${createdThreadId}`));
    expect(createdThread.thread).toMatchObject({ id: createdThreadId, authorId: fixture.aliceId });
    expect(createdThread.thread.firstPost.authorId).toBe(fixture.aliceId);
    expect(documentText(createdThread.thread.firstPost.body)).toBe('Alice opening body');
    await fillEditor(alicePage, 'Alice native reply');
    await submitWithKeyboard(alicePage);
    await alicePage.getByText('Alice native reply', { exact: true }).waitFor();
    const postPage = await responseJson<{
      posts: { id: string; authorId: string; revisionId: string; body: unknown }[];
    }>(await stack.kernel(`/v1/threads/${createdThreadId}/posts?limit=100`));
    const aliceReply = postPage.posts.find((post) => documentText(post.body) === 'Alice native reply');
    expect(aliceReply).toMatchObject({ authorId: fixture.aliceId });
    const originalRevision = aliceReply!.revisionId;
    const aliceReplySlot = alicePage.locator(`#post-${aliceReply!.id}`);
    await aliceReplySlot.getByRole('button', { name: 'More actions' }).click();
    await alicePage.getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await fillEditor(aliceReplySlot, 'Alice revised native reply');
    await aliceReplySlot.getByRole('button', { name: 'Save changes', exact: true }).click();
    await aliceReplySlot.getByText('Alice revised native reply', { exact: true }).waitFor();
    const revisedPage = await responseJson<{
      posts: { id: string; authorId: string; revisionId: string; body: unknown }[];
    }>(await stack.kernel(`/v1/threads/${createdThreadId}/posts?limit=100`));
    const revisedReply = revisedPage.posts.find((post) => post.id === aliceReply!.id)!;
    expect(revisedReply.authorId).toBe(fixture.aliceId);
    expect(revisedReply.revisionId).not.toBe(originalRevision);
    expect(documentText(revisedReply.body)).toBe('Alice revised native reply');
    const aliceReloadStart = (await requestsNow()).length;
    await alicePage.reload({ waitUntil: 'domcontentloaded' });
    await hydrate(alicePage);
    await alicePage.getByText('Alice revised native reply', { exact: true }).waitFor();
    const reloadedPostSlot = alicePage.locator(`#post-${aliceReply!.id}`);
    expect(await reloadedPostSlot.getByRole('button', { name: 'More actions' }).count()).toBe(1);
    const aliceAccount = bylineIdentities.get(fixture.aliceId)!;
    expect(await reloadedPostSlot.innerText()).toContain(aliceAccount.displayName || `@${aliceAccount.handle}`);
    const aliceReloadRequests = (await requestsNow()).slice(aliceReloadStart);
    expect(accountReadCount(aliceReloadRequests)).toBe(1);
    const revisedAfterReload = await responseJson<{
      post: { id: string; authorId: string; revisionId: string; body: unknown };
    }>(await stack.kernel(`/v1/posts/${aliceReply!.id}`));
    expect(revisedAfterReload.post).toMatchObject({
      id: aliceReply!.id,
      authorId: fixture.aliceId,
      revisionId: revisedReply.revisionId,
    });
    expect(documentText(revisedAfterReload.post.body)).toBe('Alice revised native reply');

    await bobPage.goto(`${stack.web}/en/threads/${createdThreadId}`, { waitUntil: 'domcontentloaded' });
    await hydrate(bobPage);
    const bobReplySlot = bobPage.locator(`#post-${aliceReply!.id}`);
    await bobReplySlot.getByRole('button', { name: 'More actions' }).click();
    expect(await bobPage.getByRole('menuitem', { name: 'Edit', exact: true }).count()).toBe(0);
    const bobRevision = await stack.kernel(
      `/v1/posts/${aliceReply!.id}/revisions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
          'if-match': JSON.stringify(revisedReply.revisionId),
        },
        body: JSON.stringify({ body: fromPlainText('Bob cannot revise Alice') }),
      },
      'bob',
    );
    expect(bobRevision.status).toBe(403);

    // Review conflict uses only the producer's optional exact author-owned id, at fixed page size.
    await alicePage.goto(
      `${stack.web}/en/boards/${fixture.reviewBoard.id}/new?subject=${fixture.reviewSubjectId}&subjectTitle=Native%20review%20subject`,
      { waitUntil: 'domcontentloaded' },
    );
    await hydrate(alicePage);
    await alicePage.getByLabel('Title', { exact: true }).fill('Alice native review');
    await fillEditor(alicePage, 'Alice review body');
    await submitWithKeyboard(alicePage);
    await alicePage.waitForURL((url) => /\/en\/threads\/[0-9a-f-]{36}/i.test(url.pathname));
    const reviewId = new URL(alicePage.url()).pathname.match(/\/threads\/([0-9a-f-]{36})/i)?.[1];
    expect(reviewId).toBeTruthy();
    const priorReviewId = reviewId;
    let unrelated = 0;
    let reviewOperationRequestCount: number | undefined;
    for (const target of [1, 8, 64]) {
      await fixture.createUnrelatedSubjects(target - unrelated);
      unrelated = target;
      const requestsBefore = (await requestsNow()).length;
      await alicePage.goto(
        `${stack.web}/en/boards/${fixture.reviewBoard.id}/new?subject=${fixture.reviewSubjectId}&subjectTitle=Native%20review%20subject`,
        { waitUntil: 'domcontentloaded' },
      );
      await hydrate(alicePage);
      await alicePage.getByLabel('Title', { exact: true }).fill(`Duplicate native review ${target}`);
      await fillEditor(alicePage, `Duplicate body with ${target} unrelated subjects`);
      await submitWithKeyboard(alicePage);
      const conflictAlert = alicePage.getByRole('alert');
      await conflictAlert.waitFor({ state: 'visible' });
      const existingReview = conflictAlert.getByRole('link', { name: 'Open your existing review', exact: true });
      await existingReview.waitFor({ state: 'visible' });
      expect(await existingReview.getAttribute('href')).toBe(`/en/threads/${priorReviewId}`);
      const operationRequests = (await requestsNow()).slice(requestsBefore);
      const createRequests = operationRequests.filter(
        (request) => request.method === 'POST' && new URL(request.url, 'http://kernel.test').pathname === '/v1/threads',
      );
      expect(createRequests).toHaveLength(1);
      expect(
        operationRequests.filter((request) =>
          new URL(request.url, 'http://kernel.test').pathname.startsWith(
            `/v1/subjects/${fixture.reviewSubjectId}/threads`,
          ),
        ),
      ).toHaveLength(0);
      expect(createRequests[0]!.failure?.status).toBe(409);
      const conflict = JSON.parse(createRequests[0]!.failure!.body) as { existingThreadId?: string };
      expect(conflict.existingThreadId).toBe(priorReviewId);
      reviewOperationRequestCount ??= operationRequests.length;
      expect(operationRequests).toHaveLength(reviewOperationRequestCount);
      console.info(
        `native-discussion-review-growth: unrelated-subjects=${target} kernel-requests=${operationRequests.length} POST-/v1/threads=1 index-scans=0`,
      );
    }

    // A producer conflict without the optional extension remains a generic conflict and cannot invent a link.
    await stack.injectKernelFailureOnce({
      method: 'POST',
      path: '/v1/threads',
      status: 409,
      body: JSON.stringify({
        type: 'https://rezics.com/problems/conflict',
        title: 'Conflict',
        status: 409,
        code: 'conflict',
        request_id: crypto.randomUUID(),
        retryable: false,
        effect_status: 'not_applied',
        detail: 'Injected conflict without the optional existingThreadId extension.',
      }),
    });
    await alicePage.goto(
      `${stack.web}/en/boards/${fixture.reviewBoard.id}/new?subject=${fixture.reviewSubjectId}&subjectTitle=Native%20review%20subject`,
      { waitUntil: 'domcontentloaded' },
    );
    await hydrate(alicePage);
    await alicePage.getByLabel('Title', { exact: true }).fill('Review conflict without extension');
    await fillEditor(alicePage, 'No extension must not invent an id');
    const missingExtensionStart = (await requestsNow()).length;
    await submitWithKeyboard(alicePage);
    const noExtensionAlert = alicePage.getByRole('alert');
    await noExtensionAlert.waitFor({ state: 'visible' });
    expect(await noExtensionAlert.getByRole('link').count()).toBe(0);
    const missingExtensionRequest = (await requestsNow())
      .slice(missingExtensionStart)
      .find(
        (request) => request.method === 'POST' && new URL(request.url, 'http://kernel.test').pathname === '/v1/threads',
      );
    expect(missingExtensionRequest?.failure?.status).toBe(409);
    expect(JSON.parse(missingExtensionRequest!.failure!.body)).not.toHaveProperty('existingThreadId');

    // Protected ban trumps independent Realm and thread grants for the same Bob cookies.
    await fixture.grant(fixture.banRealmId, fixture.bobId, ['realm:read']);
    await fixture.grant(fixture.banThread.id, fixture.bobId, ['post:create'], 'governor');
    await bobPage.goto(`${stack.web}/en/threads/${fixture.banThread.id}`, { waitUntil: 'domcontentloaded' });
    await hydrate(bobPage);
    await bobPage.getByText('Protected opening post', { exact: true }).waitFor();
    await fillEditor(bobPage, 'Bob reply before ban');
    await submitWithKeyboard(bobPage);
    await bobPage.getByText('Bob reply before ban', { exact: true }).waitFor();
    const banPostsBefore = await responseJson<{ posts: { id: string; authorId: string }[] }>(
      await stack.kernel(`/v1/threads/${fixture.banThread.id}/posts?limit=100`, undefined, 'alice'),
    );
    expect(banPostsBefore.posts.some((post) => post.authorId === fixture.bobId)).toBe(true);
    const bobCookiesBeforeBan = await bob.context.cookies(stack.web);
    const banResponse = await stack.kernel(
      `/v1/realms/${fixture.banRealmId}/bans/${fixture.bobId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
        body: JSON.stringify({ reason: 'Native access revocation receipt' }),
      },
      'alice',
    );
    expect(banResponse.status).toBeLessThan(300);
    await waitFor(
      async () => (await stack.kernel(`/v1/threads/${fixture.banThread.id}`, undefined, 'bob')).status,
      (status) => status === 404,
      'banned Bob to lose protected thread read access',
    );
    await waitFor(
      async () => {
        const response = await stack.kernel(`/v1/realms/${fixture.banRealmId}/members/me`, undefined, 'bob');
        if (!response.ok) return 'unavailable';
        return ((await response.json()) as { state: string }).state;
      },
      (state) => state === 'none',
      'protected Realm ban to remove Bob membership',
    );
    const afterBanRequestStart = (await requestsNow()).length;
    await fillEditor(bobPage, 'Rejected Bob reply after ban');
    await submitWithKeyboard(bobPage);
    await bobPage.getByRole('alert').waitFor({ state: 'visible' });
    const rejectedBanWrite = (await requestsNow())
      .slice(afterBanRequestStart)
      .find(
        (request) =>
          request.method === 'POST' &&
          new URL(request.url, 'http://kernel.test').pathname === `/v1/threads/${fixture.banThread.id}/posts`,
      );
    expect(rejectedBanWrite?.failure?.status).toBe(404);
    const banPostsAfter = await responseJson<{ posts: { id: string }[] }>(
      await stack.kernel(`/v1/threads/${fixture.banThread.id}/posts?limit=100`, undefined, 'alice'),
    );
    expect(banPostsAfter.posts.map(({ id }) => id)).toEqual(banPostsBefore.posts.map(({ id }) => id));
    expect(await bob.context.cookies(stack.web)).toEqual(bobCookiesBeforeBan);
    expect((await stack.kernel(`/v1/threads/${fixture.banThread.id}`, undefined, 'bob')).status).toBe(404);
    expect((await bobPage.reload({ waitUntil: 'domcontentloaded' }))?.status()).toBe(404);

    // Membership departure has the same immediate effect while a direct post grant remains.
    await fixture.addMember(fixture.removalRealmId, fixture.bobId);
    await waitFor(
      async () => {
        const response = await stack.kernel(`/v1/realms/${fixture.removalRealmId}/members/me`, undefined, 'bob');
        if (!response.ok) return 'unavailable';
        return ((await response.json()) as { state: string }).state;
      },
      (state) => state === 'member',
      'Bob membership grant before leaving',
    );
    await fixture.grant(fixture.removalThread.id, fixture.bobId, ['post:create'], 'governor');
    await bobPage.goto(`${stack.web}/en/threads/${fixture.removalThread.id}`, { waitUntil: 'domcontentloaded' });
    await hydrate(bobPage);
    await bobPage.getByText('Membership opening post', { exact: true }).waitFor();
    await fillEditor(bobPage, 'Bob reply before leaving');
    await submitWithKeyboard(bobPage);
    await bobPage.getByText('Bob reply before leaving', { exact: true }).waitFor();
    const removalPostsBefore = await responseJson<{ posts: { id: string }[] }>(
      await stack.kernel(`/v1/threads/${fixture.removalThread.id}/posts?limit=100`, undefined, 'alice'),
    );
    const leave = await stack.kernel(
      `/v1/realms/${fixture.removalRealmId}/membership`,
      { method: 'DELETE', headers: { 'idempotency-key': JSON.stringify(crypto.randomUUID()) } },
      'bob',
    );
    expect(leave.status).toBe(202);
    await waitFor(
      async () => {
        const response = await stack.kernel(`/v1/realms/${fixture.removalRealmId}/members/me`, undefined, 'bob');
        if (!response.ok) return 'unavailable';
        return ((await response.json()) as { state: string }).state;
      },
      (state) => state === 'none',
      'Bob membership removal',
    );
    await waitFor(
      async () => (await stack.kernel(`/v1/threads/${fixture.removalThread.id}`, undefined, 'bob')).status,
      (status) => status === 404,
      'departed Bob to lose protected thread read access',
    );
    const afterRemovalRequestStart = (await requestsNow()).length;
    await fillEditor(bobPage, 'Rejected Bob reply after leaving');
    await submitWithKeyboard(bobPage);
    await bobPage.getByRole('alert').waitFor({ state: 'visible' });
    const rejectedRemovalWrite = (await requestsNow())
      .slice(afterRemovalRequestStart)
      .find(
        (request) =>
          request.method === 'POST' &&
          new URL(request.url, 'http://kernel.test').pathname === `/v1/threads/${fixture.removalThread.id}/posts`,
      );
    expect(rejectedRemovalWrite?.failure?.status).toBe(404);
    const removalPostsAfter = await responseJson<{ posts: { id: string }[] }>(
      await stack.kernel(`/v1/threads/${fixture.removalThread.id}/posts?limit=100`, undefined, 'alice'),
    );
    expect(removalPostsAfter.posts.map(({ id }) => id)).toEqual(removalPostsBefore.posts.map(({ id }) => id));
    expect((await stack.kernel(`/v1/threads/${fixture.removalThread.id}`, undefined, 'bob')).status).toBe(404);
    expect((await bobPage.reload({ waitUntil: 'domcontentloaded' }))?.status()).toBe(404);

    // A real Auth registration creates a public contribution; terminal deletion leaves only Deleted account attribution.
    const newcomer = await auth.signUp('newcomer');
    expect((await newcomer.response()).status()).toBe(200);
    const newcomerSession = await newcomer.context.request.get(`${auth.origin}/session`);
    const { account_id: newcomerId } = (await newcomerSession.json()) as { account_id: string };
    const newcomerPage = newcomer.context.pages().at(-1)!;
    await newcomerPage.goto(`${stack.web}/en/boards/${fixture.publicBoard.id}/new`, { waitUntil: 'domcontentloaded' });
    await hydrate(newcomerPage);
    await newcomerPage.getByLabel('Title', { exact: true }).fill('Retained contribution after deletion');
    await fillEditor(newcomerPage, 'The account should disappear from this byline');
    await submitWithKeyboard(newcomerPage);
    await newcomerPage.waitForURL((url) => /\/en\/threads\/[0-9a-f-]{36}/i.test(url.pathname));
    const retainedThreadId = new URL(newcomerPage.url()).pathname.match(/\/threads\/([0-9a-f-]{36})/i)?.[1];
    expect(retainedThreadId).toBeTruthy();
    const deletionPage = await newcomer.context.newPage();
    await deletionPage.goto(`${auth.origin}/account/delete`, { waitUntil: 'domcontentloaded' });
    await deletionPage.getByRole('heading', { name: 'Delete your account', exact: true }).waitFor();
    await deletionPage
      .getByRole('textbox', { name: 'Type “delete my account” to confirm.', exact: true })
      .fill('delete my account');
    const accountDeleteResponse = deletionPage.waitForResponse(
      (response) => new URL(response.url()).pathname === '/account-operations/execute' && response.status() === 200,
    );
    await deletionPage.getByRole('button', { name: 'Delete account', exact: true }).click();
    await accountDeleteResponse;
    await deletionPage.getByRole('status').filter({ hasText: 'Your account has been deleted' }).waitFor();
    await waitFor(
      async () =>
        responseJson<{ accounts: { id: string; state: string; handle?: string }[] }>(
          await stack.kernel(`/v1/accounts?ids=${encodeURIComponent(newcomerId)}`),
        ),
      (result) => result.accounts[0]?.state === 'deleted',
      'native deleted account projection',
    );
    const deletedRead = await responseJson<{ accounts: { id: string; state: string; handle?: string }[] }>(
      await stack.kernel(`/v1/accounts?ids=${encodeURIComponent(newcomerId)}`),
    );
    expect(deletedRead.accounts[0]).toMatchObject({ id: newcomerId, state: 'deleted' });
    expect(deletedRead.accounts[0]).not.toHaveProperty('handle');
    const deletedPageStart = (await requestsNow()).length;
    await anonymousPage.goto(`${stack.web}/en/threads/${retainedThreadId}`, { waitUntil: 'domcontentloaded' });
    await hydrate(anonymousPage);
    await anonymousPage.getByText('The account should disappear from this byline', { exact: true }).waitFor();
    await anonymousPage.getByText('Deleted account', { exact: true }).waitFor();
    expect(await anonymousPage.locator('a[href*="/@"]').count()).toBe(0);
    expect(accountReadCount((await requestsNow()).slice(deletedPageStart))).toBe(1);

    const finalRequests = await requestsNow();
    const personResponses = finalRequests.filter((request) => request.failure);
    const developmentRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: join(import.meta.dir, '../../../../'),
    })
      .toString()
      .trim();
    console.info(
      `native-discussion-receipt: dev-revision=${developmentRevision} requests=${finalRequests.length} observed-failures=${personResponses.map(({ method, url, failure }) => `${method} ${url} -> ${failure!.status}`).join('; ')}`,
    );
  },
  timeout,
);
