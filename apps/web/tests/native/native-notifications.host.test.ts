import { afterAll, expect } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Page, Route } from 'playwright';
import {
  INBOX_DESKTOP_VIEWPORT,
  INBOX_NATIVE_LOCALES,
  INBOX_PHONE_VIEWPORT,
  startNativeNotificationFixture,
  type NativeNotificationFixture,
} from './native-notifications-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';
import { threadLocation } from '../../src/threads/thread-href';
import { deriveInboxBrowserWork, INBOX_CONTENT_DISCLOSURE_EVIDENCE } from '../../src/inbox/inbox-work';
import { unreadBadgeLabel } from '../../src/inbox/unread-badge';
import type { ResolvedInboxPage } from '../../src/inbox/inbox-decode';

const lifecycle = new NativeTestLifecycle('native notifications suite');
let fixture: NativeNotificationFixture;

nativeBeforeAll(lifecycle, 300_000, async () => {
  fixture = await startNativeNotificationFixture();
});
afterAll(async () => {
  await fixture?.close();
}, 180_000);
nativeAfterAll(lifecycle, 180_000);

async function waitForInbox(
  accountId: string,
  predicate: (pages: readonly ResolvedInboxPage[]) => boolean,
  actor: 'alice' | 'bob',
): Promise<ResolvedInboxPage[]> {
  let last: ResolvedInboxPage[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const first = await fixture.readInbox(accountId, actor, { selection: 'all' });
    last = [first];
    if (first.next)
      last.push(await fixture.readInbox(accountId, actor, { selection: 'all', cursor: first.next }));
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Native notification worker did not deliver all fixture notices: ${JSON.stringify(last)}`);
}

async function waitForNotice(
  accountId: string,
  notice: (item: ResolvedInboxPage['items'][number]) => boolean,
  actor: 'alice' | 'bob',
) {
  const pages = await waitForInbox(accountId, (listed) => listed.some((page) => page.items.some(notice)), actor);
  return pages.flatMap((page) => page.items).find(notice)!;
}

function allItems(pages: readonly ResolvedInboxPage[]) {
  return pages.flatMap((page) => page.items);
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

async function openInbox(page: Page, locale = 'en') {
  await page.goto(`${fixture.stack.web}/${locale}/inbox`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
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
    let initialPages: ResolvedInboxPage[];
    try {
      initialPages = await waitForInbox(
        aliceId,
        (pages) => {
          const items = allItems(pages);
          return (
            items.filter(({ kind }) => kind === 'reply').length === 20 &&
            items.some((item) => item.postId === initialMention.id && item.kind === 'mention')
          );
        },
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
    const nativeAliceItems = allItems(initialPages);
    const initialMentionNotice = nativeAliceItems.find(({ postId }) => postId === initialMention.id)!;
    expect(initialMentionNotice.actorId).toBe(fixture.bobId);
    expect(initialMentionNotice.actor).toMatchObject({ state: 'available', avatarUrl: null });
    expect(initialPages[0]?.items).toHaveLength(20);
    expect(initialPages[0]?.next).not.toBeNull();
    expect(initialPages[0]?.selection).toBe('all');
    expect(nativeAliceItems).toHaveLength(21);
    expect(nativeAliceItems.filter(({ kind }) => kind === 'reply')).toHaveLength(20);
    expect(nativeAliceItems.find(({ postId }) => postId === openingPost.id)).toBeUndefined();

    const anonymousAliceInbox = await stack.kernel(`/v1/accounts/${aliceId}/notifications?limit=20`, {}, 'anonymous');
    const bobAliceInbox = await stack.kernel(`/v1/accounts/${aliceId}/notifications?limit=20`, undefined, 'bob');
    expect(anonymousAliceInbox.status).toBe(401);
    expect(bobAliceInbox.status).toBe(404);

    const emptyBobInbox = await fixture.readInbox(bobId, 'bob');
    expect(emptyBobInbox.items).toEqual([]);
    expect(emptyBobInbox.next).toBeNull();
    expect(emptyBobInbox.actions.markSeen).toBeNull();
    const emptyBobCount = await fixture.readCount(bobId, 'bob');
    expect(emptyBobCount).toMatchObject({ count: 0, capped: false, basis: 'current-visible-unread' });
    const bobPage = await bobJourney.context.newPage();
    await bobPage.setViewportSize(INBOX_PHONE_VIEWPORT);
    await openInbox(bobPage);
    await bobPage.getByText('You are all caught up.', { exact: true }).waitFor();
    await browserExpect(bobPage.getByRole('status', { name: 'Current unread summary' })).toContainText(
      'No unread notifications.',
    );

    const alicePage = await aliceJourney.context.newPage();
    await alicePage.setViewportSize(INBOX_DESKTOP_VIEWPORT);
    const aliceNetwork = await capturePage(alicePage);
    await openInbox(alicePage);
    const firstRows = alicePage.locator('ol[aria-label="Inbox"] > li');
    await browserExpect(firstRows).toHaveCount(20);
    await browserExpect(alicePage.getByRole('button', { name: 'Load more', exact: true })).toBeVisible();
    const firstPageIds = await firstRows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-notice-id')));
    expect(firstPageIds).toEqual(initialPages[0]!.items.map(({ id }) => id));
    const replyNotice = nativeAliceItems.find(({ kind }) => kind === 'reply')!;
    expect(replyNotice.actor).toMatchObject({
      state: 'available',
      accountId: fixture.bobId,
      avatarUrl: null,
    });
    expect(replyNotice.context).toContain('Alice replies');
    const replyRow = alicePage.locator(`[data-notice-id="${replyNotice.id}"]`);
    await browserExpect(replyRow).toHaveAttribute('data-kind', 'reply');
    await browserExpect(replyRow.locator('[data-notice-byline]')).toContainText('Reply');
    await browserExpect(replyRow.locator('a')).toHaveAttribute(
      'href',
      threadLocation(
        'en',
        { id: replyNotice.threadId!, title: replyNotice.target?.threadTitle ?? null },
        undefined,
        replyNotice.postId!,
      ),
    );
    const initialMentionRow = alicePage.locator(`[data-notice-id="${initialMentionNotice.id}"]`);
    if ((await initialMentionRow.count()) === 0) {
      await alicePage.getByRole('button', { name: 'Load more', exact: true }).click();
      await browserExpect(alicePage.locator('ol[aria-label="Inbox"] > li')).toHaveCount(1);
      expect(
        await alicePage
          .locator('ol[aria-label="Inbox"] > li')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-notice-id'))),
      ).toEqual(initialPages[1]!.items.map(({ id }) => id));
      await alicePage.getByRole('button', { name: 'Previous', exact: true }).click();
      await browserExpect(firstRows).toHaveCount(20);
    }
    await browserExpect(alicePage.locator(`[data-notice-id="${initialMentionNotice.id}"]`)).toHaveAttribute(
      'data-kind',
      'mention',
    );

    const unreadBeforeRead = await fixture.readCount(aliceId, 'alice');
    const badgeLabel = unreadBadgeLabel(unreadBeforeRead);
    if (unreadBeforeRead.basis === 'current-visible-lower-bound' || unreadBeforeRead.capped)
      await browserExpect(alicePage.getByRole('status', { name: 'Current unread summary' })).toContainText(
        'At least',
      );
    else if (badgeLabel)
      await browserExpect(alicePage.getByRole('status', { name: 'Current unread summary' })).toContainText(
        `${unreadBeforeRead.count} unread`,
      );

    await alicePage.getByRole('button', { name: 'Unread notifications', exact: true }).click();
    await browserExpect(alicePage.getByRole('button', { name: 'Unread notifications', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const unreadPage = await fixture.readInbox(aliceId, 'alice', { selection: 'unread' });
    expect(unreadPage.selection).toBe('unread');
    expect(unreadPage.items.every((item) => item.unread)).toBe(true);
    await alicePage.getByRole('button', { name: 'All notifications', exact: true }).click();
    await browserExpect(firstRows).toHaveCount(20);

    const destination = replyRow.locator('a');
    await destination.focus();
    await browserExpect(destination).toBeFocused();
    await alicePage.keyboard.press('Enter');
    await alicePage.waitForURL((url) => url.pathname.endsWith(`/threads/${replyNotice.threadId}`));
    expect(new URL(alicePage.url()).hash).toBe(`#${replyNotice.postId}`);
    const stillUnread = (await fixture.readInbox(aliceId, 'alice')).items.find(({ id }) => id === replyNotice.id);
    expect(stillUnread?.unread).toBe(true);
    await alicePage.goBack({ waitUntil: 'domcontentloaded' });
    await alicePage.locator(`[data-notice-id="${replyNotice.id}"]`).waitFor();
    await browserExpect(alicePage.locator(`[data-notice-id="${replyNotice.id}"]`)).toHaveCount(1);

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
    expect(
      allItems(await waitForInbox(aliceId, () => true, 'alice')).some(({ postId }) => postId === disabledReply.id),
    ).toBe(false);
    const enabledMentionNotice = await waitForNotice(
      aliceId,
      (item) => item.postId === enabledMention.id,
      'alice',
    );
    expect(enabledMentionNotice.kind).toBe('mention');
    expect(enabledMentionNotice.actorId).toBe(fixture.bobId);

    const watched = await fixture.createThread('bob', 'Watched discussion');
    await fixture.watchThread('alice', watched);
    const watchedPost = await fixture.createPost('bob', watched, {
      parentId: watched.firstPostId,
      text: 'Watch update for Alice',
    });
    const watchNotice = await waitForNotice(
      aliceId,
      (item) => item.kind === 'thread_watch' && item.postId === watchedPost.id,
      'alice',
    );
    expect(watchNotice.actorId).toBe(fixture.bobId);
    expect(watchNotice.actor).toMatchObject({ state: 'available', avatarUrl: null });
    expect(watchNotice.context).toContain('Watched discussion');
    expect(watchNotice.target).toMatchObject({
      state: 'available',
      threadId: watched.id,
      postId: watchedPost.id,
      threadTitle: 'Watched discussion',
    });
    expect(watchNotice.target?.boardTitle).toBeTruthy();

    for (const viewport of [INBOX_PHONE_VIEWPORT, INBOX_DESKTOP_VIEWPORT]) {
      const sized = await aliceJourney.context.newPage();
      await sized.setViewportSize(viewport);
      await openInbox(sized);
      const watchRow = sized.locator(`[data-notice-id="${watchNotice.id}"]`);
      await watchRow.waitFor();
      await browserExpect(watchRow).toHaveAttribute('data-kind', 'thread_watch');
      await browserExpect(watchRow.locator('a')).toHaveAttribute(
        'href',
        threadLocation('en', { id: watched.id, title: watchNotice.target?.threadTitle ?? 'Watched discussion' }, undefined, watchedPost.id),
      );
      const open = watchRow.locator('a');
      await open.focus();
      await sized.keyboard.press('Enter');
      await sized.waitForURL((url) => url.pathname.includes(`/threads/${watched.id}`));
      expect((await fixture.readInbox(aliceId, 'alice')).items.find(({ id }) => id === watchNotice.id)?.unread).toBe(
        true,
      );
      await sized.goBack({ waitUntil: 'domcontentloaded' });
      await sized.locator(`[data-notice-id="${watchNotice.id}"]`).waitFor();
      await sized.close();
    }

    await openInbox(alicePage);
    const watchRow = alicePage.locator(`[data-notice-id="${watchNotice.id}"]`);
    await watchRow.waitFor();
    await watchRow.getByRole('button', { name: 'Mark this notification as read' }).click();
    await browserExpect(watchRow).toContainText('This notification was marked as read.');
    expect((await fixture.readInbox(aliceId, 'alice')).items.find(({ id }) => id === watchNotice.id)?.unread).toBe(
      false,
    );

    const admitted = (await fixture.readInbox(aliceId, 'alice')).actions.markSeen;
    if (admitted) {
      await alicePage.getByRole('button', { name: 'Mark notifications through the displayed boundary as read' }).click();
      await alicePage.getByText('The server marked notifications through the displayed boundary as read.').waitFor();
    }

    let droppedMark: { status: number } | undefined;
    const dropFirstMark = async (route: Route) => {
      if (!droppedMark && route.request().method() === 'POST' && route.request().url().includes('_serverFn')) {
        const response = await route.fetch();
        droppedMark = { status: response.status() };
        await route.abort('failed');
        return;
      }
      await route.continue();
    };
    const unreadRow = alicePage.locator('[data-unread="true"] [data-inbox-notice-action]').first();
    if ((await unreadRow.count()) > 0) {
      await alicePage.route('**/_serverFn/**', dropFirstMark);
      await unreadRow.click();
      await alicePage.getByRole('button', { name: 'Retry marking this notification as read' }).waitFor();
      await alicePage.unroute('**/_serverFn/**', dropFirstMark);
      await alicePage.getByRole('button', { name: 'Retry marking this notification as read' }).click();
      await alicePage.getByText('This notification was marked as read.').waitFor();
      expect(droppedMark?.status).toBe(204);
    } else {
      await alicePage.unroute('**/_serverFn/**', dropFirstMark).catch(() => {});
    }

    const bobMention = await fixture.createPost('alice', editorThread, {
      parentId: editorThread.firstPostId,
      mentionIds: [bobId],
      text: 'Alice mentioned Bob',
    });
    const bobNotice = await waitForNotice(bobId, (item) => item.postId === bobMention.id, 'bob');
    expect(bobNotice.kind).toBe('mention');
    expect(bobNotice.actorId).toBe(aliceId);

    await openInbox(alicePage);
    await alicePage.locator(`[data-notice-id="${enabledMentionNotice.id}"]`).waitFor();
    await alicePage.reload({ waitUntil: 'domcontentloaded' });
    expect(
      allItems(await waitForInbox(aliceId, () => true, 'alice')).find(({ id }) => id === enabledMentionNotice.id)
        ?.unread,
    ).toBe(true);
    expect((await fixture.readInbox(bobId, 'bob')).items.find(({ id }) => id === bobNotice.id)?.unread).toBe(true);

    await fixture.takeDownThread(aliceThread, 'The discussion violates the published conduct rules.');
    const decisionNotice = await waitForNotice(
      aliceId,
      (item) => item.kind === 'moderation_decision' && item.threadId === aliceThread.id && Boolean(item.decisionId),
      'alice',
    );
    expect(decisionNotice.actorId).toBeNull();
    expect(decisionNotice.actor).toMatchObject({ state: 'system', displayName: 'Moderation team', avatarUrl: null });
    await openInbox(alicePage);
    const decisionRow = alicePage.locator(`[data-notice-id="${decisionNotice.id}"]`);
    await browserExpect(decisionRow).toHaveAttribute('data-kind', 'moderation_decision');
    await browserExpect(decisionRow.locator('[data-notice-byline]')).toContainText('Moderation outcome');
    await browserExpect(decisionRow.locator('a')).toHaveAttribute(
      'href',
      `/en/moderation/decisions/${decisionNotice.decisionId}`,
    );
    await decisionRow.locator('a').click();
    await alicePage.waitForURL((url) => url.pathname.endsWith(`/moderation/decisions/${decisionNotice.decisionId}`));
    await browserExpect(
      alicePage.getByText('The discussion violates the published conduct rules.', { exact: true }),
    ).toBeVisible();
    expect(aliceNetwork.failures.filter((failure) => !failure.includes('_serverFn'))).toEqual([]);

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
    expect((await fixture.readInbox(bobId, 'bob')).items.some(({ postId }) => postId === hiddenBeforeDelivery.id)).toBe(
      false,
    );

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
    expect(
      (await fixture.readInbox(bobId, 'bob')).items.some(({ postId }) => postId === deliveredBeforeRevocation.id),
    ).toBe(false);
    const hiddenDestination = await stack.kernel(`/v1/posts/${deliveredBeforeRevocation.id}`, undefined, 'bob');
    expect(hiddenDestination.status).toBe(404);
    expect(await hiddenDestination.text()).not.toContain('Hidden after notification delivery');

    const bobSensitivePage = await bobJourney.context.newPage();
    await openInbox(bobSensitivePage);
    await browserExpect(bobSensitivePage.getByText('Hidden after notification delivery', { exact: true })).toHaveCount(
      0,
    );
    await bobSensitivePage.goto(`${stack.web}/en/threads/${protectedThread.id}`, { waitUntil: 'domcontentloaded' });
    await bobSensitivePage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    await browserExpect(bobSensitivePage.getByText('Hidden after notification delivery', { exact: true })).toHaveCount(
      0,
    );

    const replaced = await bobJourney.context.newPage();
    await openInbox(replaced);
    await browserExpect(replaced.locator(`[data-notice-id="${watchNotice.id}"]`)).toHaveCount(0);
    await replaced.close();
    await bobSensitivePage.close();
    await bobPage.close();
    await alicePage.close();

    for (const locale of INBOX_NATIVE_LOCALES) {
      const localized = await bobJourney.context.newPage();
      await localized.setViewportSize(locale === 'en' ? INBOX_DESKTOP_VIEWPORT : INBOX_PHONE_VIEWPORT);
      await openInbox(localized, locale);
      await localized.locator('h1').waitFor();
      await localized.close();
    }

    const growth: {
      unrelatedResources: number;
      reads: { page: number; identities: number; targets: number; count: number };
      seenWrites: number;
      work: ReturnType<typeof deriveInboxBrowserWork>;
    }[] = [];
    let unrelatedResources = 0;
    for (const [scale, visits] of [
      [1, 1],
      [8, 2],
      [64, 3],
    ] as const) {
      while (unrelatedResources < scale) {
        unrelatedResources += 1;
        await fixture.createBoard('published', `Unrelated inbox fixture ${unrelatedResources}`);
      }
      const before = stack.kernelRequests().length;
      for (let visit = 0; visit < visits; visit += 1) {
        const sample = await bobJourney.context.newPage();
        await openInbox(sample);
        await browserExpect(sample.locator('ol[aria-label="Inbox"] > li')).toHaveCount(
          Math.min(20, (await fixture.readInbox(bobId, 'bob')).items.length),
        );
        await sample.close();
      }
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
      const seenWrites = measured.filter(({ url, method }) => {
        if (method !== 'POST') return false;
        const nativePath = path(url);
        return (
          nativePath === `/v1/accounts/${bobId}/notifications:markSeen` ||
          (nativePath.startsWith(`/v1/accounts/${bobId}/notifications/`) &&
            (nativePath.endsWith(':markSeen') || nativePath.endsWith('$markSeen')))
        );
      }).length;
      const bobRows = (await fixture.readInbox(bobId, 'bob')).items.length;
      const work = deriveInboxBrowserWork({
        visits,
        countRequests: visits,
        unrelatedNotices: scale,
        retainedRows: bobRows,
        priorAddresses: 0,
        discardedCandidates: Math.max(0, scale - bobRows),
      });
      expect(work.content).toEqual(INBOX_CONTENT_DISCLOSURE_EVIDENCE);
      expect(work.hydrationRequests).toBe(0);
      expect(work.listRequests).toBe(visits);
      expect(work.countRequests).toBe(visits);
      growth.push({
        unrelatedResources: scale,
        reads: { page: notifications, identities, targets, count },
        seenWrites,
        work,
      });
      console.info('Inbox composed work', JSON.stringify(work));
      console.info('Inbox nested Content evidence', JSON.stringify(INBOX_CONTENT_DISCLOSURE_EVIDENCE));
    }
    expect(growth.map(({ reads, seenWrites }) => ({ reads, seenWrites }))).toEqual([
      { reads: { page: 1, identities: 0, targets: 0, count: 1 }, seenWrites: 0 },
      { reads: { page: 2, identities: 0, targets: 0, count: 2 }, seenWrites: 0 },
      { reads: { page: 3, identities: 0, targets: 0, count: 3 }, seenWrites: 0 },
    ]);
    console.info('Inbox request counts at 1/8/64 unrelated resources with 1/2/3 visits:', JSON.stringify(growth));
    console.info(
      'Inbox Content growth-notice-inbox examined work stays on constant rows/statements and the 80-candidate / 201-key windows; browser 64/512/4096 axes are pinned in inbox-browser-work.test.ts',
    );

    expect(auth.origin).toContain('127.0.0.1');
  },
  lifecycle,
);
