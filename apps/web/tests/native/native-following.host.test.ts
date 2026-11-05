import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { BrowserContext, Page, Response as PlaywrightResponse } from 'playwright';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import {
  createNativeFollowingFixture,
  fixtureKey,
  nativeFollowingJson,
  readAllNativeFollows,
  type NativeFollowingFixture,
  type NativeFollowingPage,
} from './native-following-fixture.ts';
import { startNativeWebStack, type NativeKernelRequest, type NativeWebStack } from './stack.ts';

setDefaultTimeout(600_000);

let stack: NativeWebStack;
let auth: NativeAuthStack;
let fixture: NativeFollowingFixture;
let alice: BrowserContext;
let bob: BrowserContext;
let followingPage: Page;
let aliceInitialPages: NativeFollowingPage[];
let aliceCookiePresent = false;
let bobCookiePresent = false;

beforeAll(async () => {
  stack = await startNativeWebStack();
  fixture = await createNativeFollowingFixture(stack);
  auth = await startAuthStack(stack);
  const [aliceJourney, bobJourney] = await Promise.all([auth.signIn('alice'), auth.signIn('bob')]);
  alice = aliceJourney.context;
  bob = bobJourney.context;
  aliceCookiePresent = (await alice.cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session');
  bobCookiePresent = (await bob.cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session');
  if ((await aliceJourney.response()).status() !== 200 || (await bobJourney.response()).status() !== 200)
    throw new Error('Native Alice and Bob must sign in through the served Auth forms');
}, 600_000);

afterAll(async () => {
  try {
    await auth?.stop();
  } finally {
    await stack?.stop();
  }
}, 180_000);

async function visit(
  context: BrowserContext,
  path: string,
): Promise<{ page: Page; response: PlaywrightResponse | null; browserAuthorizationHeaders: string[] }> {
  const page = await context.newPage();
  const browserAuthorizationHeaders: string[] = [];
  page.on('request', (request) => {
    const authorization = request.headers().authorization;
    if (authorization) browserAuthorizationHeaders.push(authorization);
  });
  page.setDefaultTimeout(30_000);
  const response = await page.goto(new URL(path, stack.web).href, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  return { page, response, browserAuthorizationHeaders };
}

function selectedRequests(since: number): NativeKernelRequest[] {
  return stack.kernelRequests().slice(since);
}

function targetRead(request: NativeKernelRequest, ids: readonly string[]): boolean {
  const url = new URL(request.url, stack.kernelOrigin);
  if (request.method !== 'GET') return false;
  return ids.some((id) =>
    [
      `/v1/subjects/${id}`,
      `/v1/collections/${id}`,
      `/v1/spaces/${id}`,
      `/v1/spaceAddresses/${id}`,
      `/v1/follows/${id}`,
    ].includes(url.pathname),
  );
}

function noFollowerTotal(text: string): boolean {
  return !/followers?|followercount/i.test(text);
}

function targetLabel(record: NativeFollowingPage['follows'][number]): string | null {
  const label = record.target?.label;
  if (typeof label === 'string') return label;
  if (label && typeof label === 'object' && 'value' in label && typeof label.value === 'string') return label.value;
  return null;
}

async function waitForNativeFollow(targetId: string, state: 'following' | 'unfollowed'): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const response = await stack.kernel(`/v1/follows/${encodeURIComponent(targetId)}?view=FULL`, {}, 'alice');
    const body = (await response.json()) as { follow?: { state?: string } };
    last = { status: response.status, body };
    if (response.ok && body.follow?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Native follow ${targetId} did not reach ${state} within 30s: ${JSON.stringify(last)}`);
}

async function fullAliceList(): Promise<NativeFollowingPage[]> {
  return readAllNativeFollows(stack, 'alice');
}

async function followTarget(persona: 'alice' | 'bob', targetId: string, idempotencyKey = fixtureKey()) {
  return nativeFollowingJson<{ follow: { targetId: string; state: string; reason: string } }>(
    stack,
    persona,
    `/v1/follows/${encodeURIComponent(targetId)}`,
    { method: 'PUT', key: idempotencyKey },
  );
}

async function setCollectionPrivate(): Promise<void> {
  await nativeFollowingJson(stack, 'bob', `/v1/collections/${encodeURIComponent(fixture.collection.id)}`, {
    method: 'PATCH',
    key: fixtureKey(),
    body: {
      revision: fixture.collection.revision,
      title: fixture.collection.title,
      description: 'This is now private and must not leak through Alice’s old Following page.',
      visibility: 'private',
    },
  });
}

describe('native private Following destination', () => {
  test('Alice follows a subject, Collection and Space through served controls and sees the native cursors', async () => {
    expect(aliceCookiePresent).toBe(true);
    expect(bobCookiePresent).toBe(true);
    console.info(`native-following-active-definition-release: ${fixture.releaseDigest}`);

    const subject = await visit(alice, fixture.subject.href);
    expect(subject.response?.status()).toBe(200);
    expect((await subject.page.context().cookies(stack.web)).some(({ name }) => name === '__Host-rezics_session')).toBe(
      true,
    );
    const state = subject.page.getByRole('combobox', { name: 'Library state' });
    await state.click();
    const libraryKernelRequestStart = stack.kernelRequests().length;
    const libraryMutationResponse = subject.page.waitForResponse((response) => response.request().method() === 'POST');
    await subject.page.getByRole('option', { name: 'In progress', exact: true }).click();
    const mutationResponse = await libraryMutationResponse;
    const mutationHeaders = await mutationResponse.request().allHeaders();
    const suppliedCsrfToken = mutationHeaders['x-csrf-token'] ?? '';
    const servedSubjectPage = await subject.page.content();
    const browserSessionCookie = (await subject.page.context().cookies(stack.web)).find(
      ({ name }) => name === '__Host-rezics_session',
    )?.value;
    const requestSessionCookie = mutationHeaders.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith('__Host-rezics_session='))
      ?.slice('__Host-rezics_session='.length);
    console.info(
      `native-following-library-mutation-response: ${JSON.stringify({
        status: mutationResponse.status(),
        url: mutationResponse.url(),
        origin: mutationHeaders.origin,
        host: mutationHeaders.host,
        cookiePresent: Object.keys(mutationHeaders).some((name) => name.toLowerCase() === 'cookie'),
        csrfHeaderLength: mutationHeaders['x-csrf-token']?.length ?? 0,
        csrfHeaderWellFormed: /^[A-Za-z0-9_-]{22}$/.test(mutationHeaders['x-csrf-token'] ?? ''),
        csrfHeaderAppearsInServedPage: suppliedCsrfToken.length > 0 && servedSubjectPage.includes(suppliedCsrfToken),
        sessionCookieWellFormed: /^[A-Za-z0-9_-]{43}$/.test(requestSessionCookie ?? ''),
        sessionCookieMatchesBrowser: Boolean(browserSessionCookie && browserSessionCookie === requestSessionCookie),
        requestOriginMatches: mutationHeaders.origin === new URL(mutationResponse.url()).origin,
        body: (await mutationResponse.text()).slice(0, 2000),
      })}`,
    );
    console.info(
      `native-following-library-kernel-requests: ${JSON.stringify(
        selectedRequests(libraryKernelRequestStart).map(({ method, url, failure }) => ({ method, url, failure })),
      )}`,
    );
    await subject.page.getByRole('alert').filter({ hasText: 'Library state saved.' }).waitFor({ state: 'visible' });
    expect(subject.browserAuthorizationHeaders).toEqual([]);
    await waitForNativeFollow(fixture.subject.id, 'following');
    const libraryFollow = await nativeFollowingJson<{ follow: { state: string; reason: string } }>(
      stack,
      'alice',
      `/v1/follows/${encodeURIComponent(fixture.subject.id)}?view=FULL`,
    );
    expect(libraryFollow.follow).toMatchObject({ state: 'following', reason: 'library' });

    const collection = await visit(alice, `/en/collections/${encodeURIComponent(fixture.collection.id)}`);
    expect(collection.response?.status()).toBe(200);
    await collection.page.getByRole('button', { name: 'Follow', exact: true }).click();
    await collection.page.getByText('Following', { exact: true }).waitFor({ state: 'visible' });
    await waitForNativeFollow(fixture.collection.id, 'following');

    const space = await visit(alice, `/en/spaces/${encodeURIComponent(fixture.space.address)}`);
    expect(space.response?.status()).toBe(200);
    await space.page.getByRole('button', { name: 'Join', exact: true }).click();
    await space.page.locator('[data-member-state="pending"], [data-member-state="member"]').waitFor({
      state: 'attached',
    });
    await waitForNativeFollow(fixture.space.id, 'following');

    const bobEdge = await followTarget('bob', fixture.subject.id, fixtureKey());
    expect(bobEdge.follow).toMatchObject({ targetId: fixture.subject.id, state: 'following' });
    const explicitFollow = await followTarget('alice', fixture.subject.id, fixtureKey());
    const duplicateKey = fixtureKey();
    const duplicateA = await followTarget('alice', fixture.subject.id, duplicateKey);
    const duplicateB = await followTarget('alice', fixture.subject.id, duplicateKey);
    expect(duplicateA).toEqual(explicitFollow);
    expect(duplicateB).toEqual(duplicateA);

    for (const target of fixture.fillerSubjects) await followTarget('alice', target.id);

    aliceInitialPages = await fullAliceList();
    const expectedIds = [
      fixture.subject.id,
      fixture.collection.id,
      fixture.space.id,
      ...fixture.fillerSubjects.map(({ id }) => id),
    ].sort();
    const observedIds = aliceInitialPages.flatMap(({ follows }) => follows.map(({ targetId }) => targetId)).sort();
    expect(observedIds).toEqual(expectedIds);
    expect(new Set(observedIds).size).toBe(101);
    expect(aliceInitialPages.map(({ follows }) => follows.length)).toEqual([100, 1]);
    expect(aliceInitialPages[0]?.next).not.toBeNull();
    expect(aliceInitialPages[1]?.next).toBeNull();

    followingPage = (await visit(alice, '/en/library/following')).page;
    await followingPage.reload({ waitUntil: 'domcontentloaded' });
    await followingPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    expect(await followingPage.getByRole('heading', { level: 1, name: 'Following' }).count()).toBe(1);
    const firstPageRows = followingPage.locator('li[data-slot="list-row"]');
    await firstPageRows.first().waitFor({ state: 'visible' });
    expect(await firstPageRows.count()).toBe(100);
    for (const record of aliceInitialPages[0]!.follows) {
      const label = targetLabel(record);
      expect(label).not.toBeNull();
      expect(await followingPage.locator('body').innerText()).toContain(label!);
    }

    const more = followingPage.getByRole('link', { name: 'More', exact: true });
    await more.waitFor({ state: 'visible' });
    await more.click();
    await followingPage.waitForURL((url) => url.searchParams.has('cursor'));
    const secondPageRows = followingPage.locator('li[data-slot="list-row"]');
    await secondPageRows.first().waitFor({ state: 'visible' });
    expect(await secondPageRows.count()).toBe(1);
    expect(await secondPageRows.first().innerText()).toContain(targetLabel(aliceInitialPages[1]!.follows[0]!)!);
  }, 600_000);

  test('Following uses embedded target summaries and has no public or fabricated follower total', async () => {
    const pageRequestStart = stack.kernelRequests().length;
    const firstPage = await visit(alice, '/en/library/following');
    expect(firstPage.response?.status()).toBe(200);
    followingPage = firstPage.page;
    const body = await followingPage.locator('body').innerText();
    expect(noFollowerTotal(body)).toBe(true);
    expect(body).not.toContain('followerCount');
    const reads = selectedRequests(pageRequestStart);

    const bobTargets = (await readAllNativeFollows(stack, 'bob')).flatMap(({ follows }) =>
      follows.map(({ targetId }) => targetId),
    );
    expect(bobTargets).toEqual([fixture.subject.id]);
    const bobList = await visit(bob, '/en/library/following');
    expect(bobList.response?.status()).toBe(200);
    const bobBody = await bobList.page.locator('body').innerText();
    expect(bobBody).toContain(fixture.subject.title);
    expect(bobBody).not.toContain(fixture.collection.title);
    expect(bobBody).not.toContain(fixture.fillerSubjects[0]!.title);
    expect(noFollowerTotal(bobBody)).toBe(true);
    await bobList.page.close();

    const targets = [
      fixture.subject.id,
      fixture.collection.id,
      fixture.space.id,
      fixture.space.address,
      ...fixture.fillerSubjects.map(({ id }) => id),
    ];
    expect(reads.some((request) => targetRead(request, targets))).toBe(false);
    expect(
      reads.some((request) => new URL(request.url, stack.kernelOrigin).pathname.startsWith('/v1/followCounts/')),
    ).toBe(false);

    const ownerPage = await visit(bob, `/en/collections/${encodeURIComponent(fixture.collection.id)}`);
    expect(ownerPage.response?.status()).toBe(200);
    expect(noFollowerTotal(await ownerPage.page.locator('body').innerText())).toBe(true);
    const anonymous = await auth.context('anonymous');
    const anonymousList = await visit(anonymous, '/en/library/following');
    expect(anonymousList.response?.status()).toBe(200);
    const anonymousFollowingBody = await anonymousList.page.locator('body').innerText();
    expect(noFollowerTotal(anonymousFollowingBody)).toBe(true);
    expect(anonymousFollowingBody).not.toContain(fixture.subject.title);
    expect(anonymousFollowingBody).not.toContain(fixture.collection.title);
    await anonymousList.page.close();
    for (const path of [
      fixture.subject.href,
      `/en/collections/${fixture.collection.id}`,
      `/en/spaces/${fixture.space.address}`,
    ]) {
      const page = await visit(anonymous, path);
      expect(page.response?.status()).toBe(200);
      expect(noFollowerTotal(await page.page.locator('body').innerText())).toBe(true);
      await page.page.close();
    }
    const pageFollows = reads.filter(
      (request) => request.method === 'GET' && new URL(request.url, stack.kernelOrigin).pathname === '/v1/follows',
    );
    expect(pageFollows).toHaveLength(1);
    expect(pageFollows.every((request) => request.failure === undefined)).toBe(true);
    console.info(
      `native-following-page-requests: ${JSON.stringify(pageFollows.map(({ method, url, failure }) => ({ method, request: `${new URL(url, stack.kernelOrigin).pathname}${new URL(url, stack.kernelOrigin).search}`, failure: failure?.status })))}`,
    );
  }, 240_000);

  test('the shared responsive menu unfollows only Alice and leaves her Library state and Bob edge intact', async () => {
    await followingPage.setViewportSize({ width: 1280, height: 860 });
    await followingPage.goto(new URL('/en/library/following', stack.web).href, { waitUntil: 'domcontentloaded' });
    await followingPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    const actionRequestStart = stack.kernelRequests().length;
    const subjectRow = followingPage.locator('li[data-slot="list-row"]').filter({ hasText: fixture.subject.title });
    const desktopTrigger = subjectRow.getByRole('button', {
      name: `More actions for ${fixture.subject.title}`,
      exact: true,
    });
    await desktopTrigger.focus();
    await followingPage.keyboard.press('Enter');
    await followingPage.getByRole('menuitem', { name: 'Unfollow', exact: true }).waitFor({ state: 'visible' });
    await followingPage.keyboard.press('Enter');
    await subjectRow.waitFor({ state: 'detached' });
    await waitForNativeFollow(fixture.subject.id, 'unfollowed');
    const actionRequests = selectedRequests(actionRequestStart);
    expect(
      actionRequests.some(
        (request) =>
          request.method === 'DELETE' &&
          new URL(request.url, stack.kernelOrigin).pathname === `/v1/follows/${fixture.subject.id}`,
      ),
    ).toBe(true);
    expect(
      actionRequests.some((request) => new URL(request.url, stack.kernelOrigin).pathname.startsWith('/v1/libraryPins')),
    ).toBe(false);

    const bobFollow = await nativeFollowingJson<{ follow: { state: string } }>(
      stack,
      'bob',
      `/v1/follows/${encodeURIComponent(fixture.subject.id)}?view=FULL`,
    );
    expect(bobFollow.follow.state).toBe('following');
    const entry = await nativeFollowingJson<{ libraryEntry: { state: string } }>(
      stack,
      'alice',
      `/v1/libraryEntries/${encodeURIComponent(fixture.subject.id)}?view=FULL`,
    );
    expect(entry.libraryEntry.state).toBe('in_progress');

    await followingPage.reload({ waitUntil: 'domcontentloaded' });
    await followingPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    expect(
      await followingPage.locator('li[data-slot="list-row"]').filter({ hasText: fixture.subject.title }).count(),
    ).toBe(0);

    await followingPage.setViewportSize({ width: 390, height: 844 });
    await followingPage.goto(new URL('/en/library/following', stack.web).href, { waitUntil: 'domcontentloaded' });
    await followingPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    const spaceRow = followingPage.locator('li[data-slot="list-row"]').filter({ hasText: fixture.space.title });
    const phoneTrigger = spaceRow.getByRole('button', {
      name: `More actions for ${fixture.space.title}`,
      exact: true,
    });
    await phoneTrigger.focus();
    await followingPage.keyboard.press('Enter');
    await followingPage.getByRole('dialog').waitFor({ state: 'visible' });
    const phoneUnfollow = followingPage.getByRole('button', { name: 'Unfollow', exact: true });
    await phoneUnfollow.focus();
    await followingPage.keyboard.press('Enter');
    await spaceRow.waitFor({ state: 'detached' });
    await waitForNativeFollow(fixture.space.id, 'unfollowed');
    const member = await nativeFollowingJson<{ state: string }>(
      stack,
      'alice',
      `/v1/realms/${encodeURIComponent(fixture.space.realmId)}/members/me`,
    );
    expect(member.state).toBe('member');
  }, 240_000);

  test('an inaccessible followed Collection becomes a no-link tombstone without leaking its previous title', async () => {
    for (const { id } of fixture.fillerSubjects) {
      const removed = await nativeFollowingJson<{ follow: { targetId: string; state: string } }>(
        stack,
        'alice',
        `/v1/follows/${encodeURIComponent(id)}`,
        { method: 'DELETE', key: fixtureKey() },
      );
      expect(removed.follow).toMatchObject({ targetId: id, state: 'unfollowed' });
    }
    await setCollectionPrivate();
    const pages = await fullAliceList();
    const hidden = pages.flatMap(({ follows }) => follows).find(({ targetId }) => targetId === fixture.collection.id);
    expect(hidden).toMatchObject({ targetId: fixture.collection.id, targetType: 'collection', target: null });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual({ follows: [hidden], next: null });
    console.info(`native-following-hidden-target-response: ${JSON.stringify(pages[0])}`);

    await followingPage.setViewportSize({ width: 390, height: 844 });
    await followingPage.goto(new URL('/en/library/following', stack.web).href, { waitUntil: 'domcontentloaded' });
    await followingPage.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    const body = await followingPage.locator('body').innerText();
    expect(body).not.toContain(fixture.collection.title);
    expect(await followingPage.locator(`a[href*="/collections/${fixture.collection.id}"]`).count()).toBe(0);
    expect(noFollowerTotal(body)).toBe(true);
  }, 240_000);
});
