import { afterAll, expect } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Page } from 'playwright';
import { startNativeNotificationFixture, type NativeNotificationFixture } from './native-notifications-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';

const lifecycle = new NativeTestLifecycle('native notifications suite');
let fixture: NativeNotificationFixture;

nativeBeforeAll(lifecycle, 300_000, async () => {
  fixture = await startNativeNotificationFixture();
});
afterAll(async () => {
  await fixture?.close();
}, 180_000);
nativeAfterAll(lifecycle, 180_000);

type NativeNotice = {
  id: string;
  kind: 'reply' | 'mention' | 'moderation_decision';
  actorId: string | null;
  threadId: string | null;
  postId: string | null;
  decisionId: string | null;
  unread: boolean;
};
type NativeNoticePage = { items: NativeNotice[]; next: string | null };

async function inbox(accountId: string, actor: 'alice' | 'bob' = 'alice', limit = 50): Promise<NativeNoticePage> {
  const response = await fixture.stack.kernel(
    `/v1/accounts/${accountId}/notifications?limit=${limit}`,
    undefined,
    actor,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as NativeNoticePage;
}

async function waitForNotice(accountId: string, notice: (item: NativeNotice) => boolean, actor: 'alice' | 'bob') {
  let last: NativeNoticePage | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    last = await inbox(accountId, actor);
    const found = last.items.find(notice);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Native notification worker did not deliver the fixture notice: ${JSON.stringify(last)}`);
}

async function waitForInbox(
  accountId: string,
  predicate: (page: NativeNoticePage) => boolean,
  actor: 'alice' | 'bob',
): Promise<NativeNoticePage> {
  let last: NativeNoticePage | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    last = await inbox(accountId, actor);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Native notification worker did not deliver all fixture notices: ${JSON.stringify(last)}`);
}

async function capturePage(page: Page) {
  const responses: { path: string; status: number }[] = [];
  const failures: string[] = [];
  page.on('response', (response) => {
    responses.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  page.on('requestfailed', (request) =>
    failures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`),
  );
  return { responses, failures };
}

nativeTest(
  'native notifications flow through separate Auth sessions, Inbox and Settings with current access',
  300_000,
  async () => {
    const { stack, auth, aliceId, bobId, aliceJourney, bobJourney } = fixture;
    expect(aliceJourney.context).not.toBe(bobJourney.context);
    expect((await aliceJourney.response()).status()).toBe(200);
    expect((await bobJourney.response()).status()).toBe(200);
    for (const journey of [aliceJourney, bobJourney]) {
      expect((await journey.requestHeaders()).every((headers) => !headers.has('authorization'))).toBe(true);
      expect((await journey.context.cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session')).toBe(
        true,
      );
    }

    const aliceThread = await fixture.createThread('alice', 'Alice replies');
    const editorThread = await fixture.createThread('editor', 'Mention destination');
    const openingPost = await fixture.createPost('alice', aliceThread, {
      parentId: aliceThread.firstPostId,
      text: 'Alice parent post',
    });
    // The initial post above is Alice's reply to herself and cannot create a notice.
    // Twenty distinct Bob replies plus a mention exercise the native page limit and cursor.
    const initialReplies = [];
    for (let index = 0; index < 20; index += 1) {
      initialReplies.push(
        await fixture.createPost('bob', aliceThread, {
          parentId: aliceThread.firstPostId,
          text: `Bob reply ${index + 1}`,
        }),
      );
    }
    const initialMention = await fixture.createPost('bob', editorThread, {
      parentId: editorThread.firstPostId,
      mentionIds: [aliceId],
      text: 'Bob mentioned Alice',
    });
    let initialNotices: NativeNoticePage;
    try {
      initialNotices = await waitForInbox(
        aliceId,
        (page) =>
          page.items.filter(({ kind }) => kind === 'reply').length === 20 &&
          page.items.some((item) => item.postId === initialMention.id && item.kind === 'mention'),
        'alice',
      );
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      const postResponses = [openingPost, ...initialReplies, initialMention].map(
        ({ nativeResponse }) => nativeResponse,
      );
      throw new Error(
        `${details}\nNative post responses: ${JSON.stringify(postResponses)}\nDurable worker logs:\n${await stack.workerLogs()}`,
      );
    }
    const initialMentionNotice = initialNotices.items.find(({ postId }) => postId === initialMention.id)!;
    expect(initialMentionNotice.actorId).toBe(fixture.bobId);
    let nativeAlice = initialNotices;
    expect(nativeAlice.items).toHaveLength(21);
    expect(nativeAlice.items.filter(({ kind }) => kind === 'reply')).toHaveLength(20);
    expect(nativeAlice.items.find(({ postId }) => postId === openingPost.id)).toBeUndefined();
    expect(nativeAlice.next).toBeNull();
    const nativeFirstPage = await inbox(aliceId, 'alice', 20);
    expect(nativeFirstPage.items).toHaveLength(20);
    expect(nativeFirstPage.next).not.toBeNull();
    expect(nativeFirstPage.items.map(({ id }) => id)).toEqual(nativeAlice.items.slice(0, 20).map(({ id }) => id));

    const anonymousAliceInbox = await stack.kernel(`/v1/accounts/${aliceId}/notifications?limit=20`, {}, 'anonymous');
    const bobAliceInbox = await stack.kernel(`/v1/accounts/${aliceId}/notifications?limit=20`, undefined, 'bob');
    expect(anonymousAliceInbox.status).toBe(401);
    expect(bobAliceInbox.status).toBe(404);

    const emptyBobInbox = await inbox(bobId, 'bob');
    expect(emptyBobInbox.items).toEqual([]);
    expect(emptyBobInbox.next).toBeNull();
    const bobPage = await bobJourney.context.newPage();
    await bobPage.goto(`${stack.web}/en/inbox`, { waitUntil: 'domcontentloaded' });
    await bobPage.getByText('You are all caught up.', { exact: true }).waitFor();

    const alicePage = await aliceJourney.context.newPage();
    const aliceNetwork = await capturePage(alicePage);
    await alicePage.goto(`${stack.web}/en/inbox`, { waitUntil: 'domcontentloaded' });
    await alicePage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    const firstRows = alicePage.locator('ol[aria-label="Inbox"] > li');
    await browserExpect(firstRows).toHaveCount(20);
    await browserExpect(alicePage.getByRole('button', { name: 'Load more', exact: true })).toBeVisible();
    const firstPageIds = await firstRows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-notice-id')));
    expect(firstPageIds).toEqual(nativeAlice.items.slice(0, 20).map(({ id }) => id));
    const replyNotice = nativeAlice.items.find(({ kind }) => kind === 'reply')!;
    const replyRow = alicePage.locator(`[data-notice-id="${replyNotice.id}"]`);
    await browserExpect(replyRow).toHaveAttribute('data-kind', 'reply');
    await browserExpect(replyRow).toHaveAttribute('data-actor-id', fixture.bobId);
    await browserExpect(replyRow.locator('[data-notice-byline]')).toContainText('Reply');
    const bobAccountResponse = await stack.kernel(`/v1/accounts?ids=${fixture.bobId}`, undefined, 'anonymous');
    expect(bobAccountResponse.status).toBe(200);
    const bobAccount = (
      (await bobAccountResponse.json()) as { accounts: { displayName?: string | null; handle?: string | null }[] }
    ).accounts[0];
    const bobByline = bobAccount?.displayName || bobAccount?.handle;
    await browserExpect(replyRow.locator('[data-notice-byline]')).toContainText(bobByline ?? 'Community member');
    await browserExpect(replyRow.locator('a')).toHaveAttribute(
      'href',
      `/threads/${replyNotice.threadId}#${replyNotice.postId}`,
    );
    const initialMentionRow = alicePage.locator(`[data-notice-id="${initialMentionNotice.id}"]`);
    await browserExpect(initialMentionRow).toHaveAttribute('data-kind', 'mention');
    await browserExpect(initialMentionRow).toHaveAttribute('data-actor-id', fixture.bobId);
    await browserExpect(initialMentionRow.locator('[data-notice-byline]')).toContainText('Mention');
    await browserExpect(initialMentionRow.locator('a')).toHaveAttribute(
      'href',
      `/threads/${initialMention.threadId}#${initialMention.id}`,
    );
    await alicePage.getByRole('button', { name: 'Load more', exact: true }).click();
    await browserExpect(alicePage.locator('ol[aria-label="Inbox"] > li')).toHaveCount(21);
    const allPageIds = await alicePage
      .locator('ol[aria-label="Inbox"] > li')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-notice-id')));
    expect(allPageIds).toEqual(nativeAlice.items.map(({ id }) => id));
    await replyRow.locator('a').click();
    await alicePage.waitForURL((url) => url.pathname.endsWith(`/threads/${replyNotice.threadId}`));
    expect(new URL(alicePage.url()).hash).toBe(`#${replyNotice.postId}`);

    await alicePage.goto(`${stack.web}/en/settings`, { waitUntil: 'domcontentloaded' });
    const replyPreference = alicePage.getByRole('switch', { name: 'Reply notifications', exact: true });
    await browserExpect(replyPreference).toHaveAttribute('aria-checked', 'true');
    await replyPreference.focus();
    await alicePage.keyboard.press('Space');
    await alicePage.getByText('Saved', { exact: true }).waitFor();
    await alicePage.reload({ waitUntil: 'domcontentloaded' });
    await browserExpect(alicePage.getByRole('switch', { name: 'Reply notifications', exact: true })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await browserExpect(alicePage.getByRole('switch', { name: 'Mention notifications', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    const nativePreference = await stack.kernel(`/v1/accounts/${aliceId}/preferences`, undefined, 'alice');
    expect(nativePreference.status).toBe(200);
    expect(await nativePreference.json()).toMatchObject({ notifications: { reply: false, mention: true } });
    expect(
      stack
        .kernelRequests()
        .some(({ method, url }) => method === 'PATCH' && url === `/v1/accounts/${aliceId}/preferences`),
    ).toBe(true);

    const disabledReply = await fixture.createPost('bob', aliceThread, {
      parentId: aliceThread.firstPostId,
      text: 'Reply preference disabled sentinel',
    });
    const enabledMention = await fixture.createPost('bob', editorThread, {
      parentId: editorThread.firstPostId,
      mentionIds: [aliceId],
      text: 'Mention preference enabled sentinel',
    });
    await waitForNotice(aliceId, (item) => item.postId === enabledMention.id, 'alice');
    nativeAlice = await inbox(aliceId);
    expect(nativeAlice.items.some(({ postId }) => postId === disabledReply.id)).toBe(false);
    const enabledMentionNotice = nativeAlice.items.find(({ postId }) => postId === enabledMention.id)!;
    expect(enabledMentionNotice.kind).toBe('mention');
    expect(enabledMentionNotice.actorId).toBe(fixture.bobId);

    const bobMention = await fixture.createPost('alice', editorThread, {
      parentId: editorThread.firstPostId,
      mentionIds: [bobId],
      text: 'Alice mentioned Bob',
    });
    const bobNotice = await waitForNotice(bobId, (item) => item.postId === bobMention.id, 'bob');
    expect(bobNotice.kind).toBe('mention');
    expect(bobNotice.actorId).toBe(aliceId);

    await alicePage.goto(`${stack.web}/en/inbox`, { waitUntil: 'domcontentloaded' });
    await alicePage.locator(`[data-notice-id="${enabledMentionNotice.id}"]`).waitFor();
    await alicePage.reload({ waitUntil: 'domcontentloaded' });
    nativeAlice = await inbox(aliceId);
    expect(nativeAlice.items.find(({ id }) => id === enabledMentionNotice.id)?.unread).toBe(false);
    const nativeBob = await inbox(bobId, 'bob');
    expect(nativeBob.items.find(({ id }) => id === bobNotice.id)?.unread).toBe(true);

    await fixture.takeDownThread(aliceThread, 'The discussion violates the published conduct rules.');
    const decisionNotice = await waitForNotice(
      aliceId,
      (item) => item.kind === 'moderation_decision' && item.threadId === aliceThread.id && Boolean(item.decisionId),
      'alice',
    );
    expect(decisionNotice.actorId).toBeNull();
    await alicePage.goto(`${stack.web}/en/inbox`, { waitUntil: 'domcontentloaded' });
    const decisionRow = alicePage.locator(`[data-notice-id="${decisionNotice.id}"]`);
    await browserExpect(decisionRow).toHaveAttribute('data-kind', 'moderation_decision');
    await browserExpect(decisionRow.locator('[data-notice-byline]')).toContainText('Moderation outcome');
    await browserExpect(decisionRow.locator('a')).toHaveAttribute(
      'href',
      `/moderation/decisions/${decisionNotice.decisionId}`,
    );
    await decisionRow.locator('a').click();
    await alicePage.waitForURL((url) => url.pathname.endsWith(`/moderation/decisions/${decisionNotice.decisionId}`));
    await browserExpect(
      alicePage.getByText('The discussion violates the published conduct rules.', { exact: true }),
    ).toBeVisible();
    expect(aliceNetwork.failures).toEqual([]);
    expect(aliceNetwork.responses.some(({ path, status }) => path.includes('_serverFn') && status >= 400)).toBe(false);

    // Protected-target delivery is rechecked at send time. A later accessible notice is the
    // fixture-local completion sentinel for the same author's ordered event stream.
    const protectedBoard = await fixture.createBoard('protected', 'Native protected notification board');
    await fixture.grant(protectedBoard, aliceId, 'board:read');
    await fixture.grant(protectedBoard, aliceId, 'thread:create');
    await fixture.grant(protectedBoard, bobId, 'board:read');
    const protectedThread = await fixture.createThread(
      'alice',
      'Access checked notification thread',
      protectedBoard.id,
      protectedBoard.route,
    );
    await fixture.grant(protectedThread, bobId, 'thread:read');
    await fixture.grant({ id: protectedThread.firstPostId, route: protectedThread.route }, bobId, 'post:read');
    const protectedOpeningPost = await stack.kernel(`/v1/posts/${protectedThread.firstPostId}`, undefined, 'bob');
    expect(protectedOpeningPost.status).toBe(200);
    await fixture.revoke(protectedBoard, bobId, 'board:read');
    await fixture.revoke(protectedThread, bobId, 'thread:read');
    await fixture.revoke({ id: protectedThread.firstPostId, route: protectedThread.route }, bobId, 'post:read');
    expect((await stack.kernel(`/v1/posts/${protectedThread.firstPostId}`, undefined, 'bob')).status).toBe(404);
    const hiddenBeforeDelivery = await fixture.createPost('alice', protectedThread, {
      parentId: protectedThread.firstPostId,
      mentionIds: [bobId],
      text: 'Hidden before notification delivery',
    });
    const publicSentinel = await fixture.createPost('alice', editorThread, {
      parentId: editorThread.firstPostId,
      mentionIds: [bobId],
      text: 'Fixture delivery sentinel',
    });
    await waitForNotice(bobId, (item) => item.postId === publicSentinel.id, 'bob');
    expect((await inbox(bobId, 'bob')).items.some(({ postId }) => postId === hiddenBeforeDelivery.id)).toBe(false);

    await fixture.grant(protectedBoard, bobId, 'board:read');
    await fixture.grant(protectedThread, bobId, 'thread:read');
    await fixture.grant({ id: protectedThread.firstPostId, route: protectedThread.route }, bobId, 'post:read');
    const deliveredBeforeRevocation = await fixture.createPost('alice', protectedThread, {
      parentId: protectedThread.firstPostId,
      mentionIds: [bobId],
      text: 'Hidden after notification delivery',
    });
    await fixture.grant({ id: deliveredBeforeRevocation.id, route: protectedThread.route }, bobId, 'post:read');
    const readableBeforeRevocation = await stack.kernel(`/v1/posts/${deliveredBeforeRevocation.id}`, undefined, 'bob');
    expect(readableBeforeRevocation.status).toBe(200);
    expect(await readableBeforeRevocation.text()).toContain('Hidden after notification delivery');
    await waitForNotice(bobId, (item) => item.postId === deliveredBeforeRevocation.id, 'bob');
    await fixture.revoke(protectedBoard, bobId, 'board:read');
    await fixture.revoke(protectedThread, bobId, 'thread:read');
    await fixture.revoke({ id: protectedThread.firstPostId, route: protectedThread.route }, bobId, 'post:read');
    await fixture.revoke({ id: deliveredBeforeRevocation.id, route: protectedThread.route }, bobId, 'post:read');
    const bobAfterRevocation = await inbox(bobId, 'bob');
    expect(bobAfterRevocation.items.some(({ postId }) => postId === deliveredBeforeRevocation.id)).toBe(false);
    const hiddenDestination = await stack.kernel(`/v1/posts/${deliveredBeforeRevocation.id}`, undefined, 'bob');
    expect(hiddenDestination.status).toBe(404);
    expect(await hiddenDestination.text()).not.toContain('Hidden after notification delivery');

    const bobSensitivePage = await bobJourney.context.newPage();
    await bobSensitivePage.goto(`${stack.web}/en/inbox`, { waitUntil: 'domcontentloaded' });
    await bobSensitivePage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    await browserExpect(bobSensitivePage.getByText('Hidden after notification delivery', { exact: true })).toHaveCount(
      0,
    );
    await bobSensitivePage.goto(`${stack.web}/en/threads/${protectedThread.id}`, { waitUntil: 'domcontentloaded' });
    await bobSensitivePage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    await browserExpect(bobSensitivePage.getByText('Hidden after notification delivery', { exact: true })).toHaveCount(
      0,
    );
    await bobSensitivePage.close();
    await bobPage.close();
    await alicePage.close();

    const growth: {
      unrelatedResources: number;
      reads: { page: number; identities: number; targets: number; count: number };
      seenWrites: number;
    }[] = [];
    let unrelatedResources = 0;
    for (const scale of [1, 8, 64]) {
      while (unrelatedResources < scale) {
        unrelatedResources += 1;
        await fixture.createBoard('published', `Unrelated inbox fixture ${unrelatedResources}`);
      }
      const before = stack.kernelRequests().length;
      const sample = await bobJourney.context.newPage();
      const seenResponse = sample
        .waitForResponse(
          (response) =>
            new URL(response.url()).pathname.includes('_serverFn') && response.request().method() === 'POST',
          { timeout: 30_000 },
        )
        .catch(() => null);
      await sample.goto(`${stack.web}/en/inbox`, { waitUntil: 'domcontentloaded' });
      await browserExpect(sample.locator('ol[aria-label="Inbox"] > li')).toHaveCount(2);
      await seenResponse;
      await sample.waitForLoadState('networkidle');
      await sample.close();
      const measured = stack.kernelRequests().slice(before);
      const path = (url: string) => new URL(url, stack.kernelOrigin).pathname;
      const notifications = measured.filter(
        ({ url, method }) => method === 'GET' && path(url) === `/v1/accounts/${bobId}/notifications`,
      ).length;
      const identities = measured.filter(
        ({ url, method }) => method === 'GET' && path(url) === '/v1/accounts' && url.includes('?ids='),
      ).length;
      const targets = measured.filter(
        ({ url, method }) => method === 'GET' && path(url).startsWith('/v1/posts/'),
      ).length;
      const count = measured.filter(
        ({ url, method }) => method === 'GET' && path(url) === `/v1/accounts/${bobId}/notifications/count`,
      ).length;
      const seenWrites = measured.filter(
        ({ url, method }) => method === 'POST' && path(url) === `/v1/accounts/${bobId}/notifications:markSeen`,
      ).length;
      growth.push({
        unrelatedResources: scale,
        reads: { page: notifications, identities, targets, count },
        seenWrites,
      });
    }
    expect(growth.map(({ reads, seenWrites }) => ({ reads, seenWrites }))).toEqual([
      { reads: { page: 1, identities: 1, targets: 2, count: 1 }, seenWrites: 1 },
      { reads: { page: 1, identities: 1, targets: 2, count: 1 }, seenWrites: 1 },
      { reads: { page: 1, identities: 1, targets: 2, count: 1 }, seenWrites: 1 },
    ]);
    console.info('Inbox request counts at 1/8/64 unrelated resources:', JSON.stringify(growth));

    expect(auth.origin).toContain('127.0.0.1');
  },
  lifecycle,
);
