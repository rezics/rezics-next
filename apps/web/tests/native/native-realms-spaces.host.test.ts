import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Locator, Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeKernelRequest, type NativeWebStack } from './stack.ts';
import {
  createNativeRealmsSpacesFixture,
  nativeRouteOf,
  requestNativeCommunity,
  waitForRealmMembership,
  type NativeRealmFixture,
  type NativeRealmsSpacesFixture,
} from './native-realms-spaces-fixture.ts';

setDefaultTimeout(600_000);

let stack: NativeWebStack;
let auth: NativeAuthStack;
let fixture: NativeRealmsSpacesFixture;
const screenshotDirectory = resolve(import.meta.dir, '../../../../.temp/native-realms-spaces');

async function startAuthStackWithoutWorkerInspector(stack: NativeWebStack): Promise<NativeAuthStack> {
  const configuredInspectorPort = process.env.WORKER_INSPECTOR_PORT;
  // The optional Worker inspector is unrelated to Auth and can already belong to another checkout.
  delete process.env.WORKER_INSPECTOR_PORT;
  try {
    return await startAuthStack(stack);
  } finally {
    if (configuredInspectorPort !== undefined) process.env.WORKER_INSPECTOR_PORT = configuredInspectorPort;
  }
}

beforeAll(async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStackWithoutWorkerInspector(stack);
  fixture = await createNativeRealmsSpacesFixture(stack);
}, 600_000);

afterAll(async () => {
  await auth?.stop();
  await stack?.stop();
});

async function hydrated(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  const main = page.locator('#main-content');
  // Auth pages do not use the site's main-content shell region.
  if (await main.count()) await main.waitFor({ state: 'visible' });
}

async function open(page: Page, path: string, evidence?: BrowserEvidence): Promise<number> {
  const response = await page.goto(`${stack.web}/en${path}`, { waitUntil: 'domcontentloaded' });
  try {
    await hydrated(page);
  } catch (error) {
    if (evidence) await Promise.all(evidence.responseBodies);
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => 'unavailable');
    throw new Error(
      `Page hydration failed for ${path}; status=${response?.status() ?? 0}; url=${page.url()}; body=${JSON.stringify(body)}; nativeRequests=${JSON.stringify(stack.kernelRequests())}; browserErrors=${JSON.stringify(evidence?.events ?? [])}`,
      { cause: error },
    );
  }
  return response?.status() ?? 0;
}

async function expectVisible(locator: Locator): Promise<void> {
  await locator.waitFor({ state: 'visible' });
}

async function expectCount(locator: Locator, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  let actual = await locator.count();
  while (actual !== expected && Date.now() < deadline) {
    await Bun.sleep(50);
    actual = await locator.count();
  }
  expect(actual).toBe(expected);
}

async function expectAttribute(locator: Locator, name: string, expected: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let actual = await locator.getAttribute(name);
  while (actual !== expected && Date.now() < deadline) {
    await Bun.sleep(50);
    actual = await locator.getAttribute(name);
  }
  expect(actual).toBe(expected);
}

async function waitForKernelRequest(
  after: number,
  matches: (request: NativeKernelRequest) => boolean,
  timeoutMs = 15_000,
): Promise<NativeKernelRequest> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = stack.kernelRequests().slice(after).find(matches);
    if (request) return request;
    await Bun.sleep(50);
  }
  throw new Error(`Native request did not arrive within ${timeoutMs}ms`);
}

async function changeMembershipFromPage(page: Page, button: 'Join' | 'Leave'): Promise<void> {
  const requestStart = stack.kernelRequests().length;
  const operation = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/_serverFn/'),
  );
  const result = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname.startsWith('/_serverFn/'),
  );
  await page.getByRole('button', { name: button, exact: true }).click();
  const [request, response] = await Promise.all([operation, result]);
  const body = await response.text();
  expect(response.status(), `${response.url()} returned ${body}`).toBe(200);
  await stack.refreshKernelRequests();
  const nativeRequests = stack.kernelRequests().slice(requestStart);
  const nativeEvidence = nativeRequests.map(({ method, url, failure }) => ({
    method,
    url,
    ...(failure ? { failure } : {}),
  }));
  const requestHeaders = await request.allHeaders();
  const requestEvidence = {
    url: request.url(),
    origin: requestHeaders.origin,
    hasSessionCookie: Boolean(requestHeaders.cookie?.includes('__Host-rezics_session=')),
    hasCsrfToken: Boolean(requestHeaders['x-csrf-token']),
  };
  expect(
    JSON.stringify(JSON.parse(body)),
    `Membership result; server request: ${JSON.stringify(requestEvidence)}; native requests: ${JSON.stringify(nativeEvidence)}`,
  ).toContain('"outcome":"accepted"');
}

type BrowserEvidence = { events: string[]; responseBodies: Promise<void>[] };

function observeBrowserErrors(page: Page): BrowserEvidence {
  const evidence: BrowserEvidence = { events: [], responseBodies: [] };
  page.on('pageerror', (error) => evidence.events.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') evidence.events.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) =>
    evidence.events.push(`requestfailed: ${request.method()} ${request.url()}: ${request.failure()?.errorText}`),
  );
  page.on('response', (response) => {
    if (response.status() < 400) return;
    evidence.events.push(`response: ${response.status()} ${response.url()}`);
    if (new URL(response.url()).pathname.startsWith('/_serverFn/'))
      evidence.responseBodies.push(response.text().then((body) => evidence.events.push(`response body: ${body}`)));
  });
  return evidence;
}

async function requireVisibleHeading(page: Page, title: string, evidence: BrowserEvidence): Promise<void> {
  try {
    await page.getByRole('heading', { level: 1, name: title }).waitFor({ state: 'visible' });
  } catch (error) {
    await Promise.all(evidence.responseBodies);
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => 'unavailable');
    const requests = stack.kernelRequests().map(({ method, url, failure }) => ({ method, url, failure }));
    throw new Error(
      `Expected visible page heading ${JSON.stringify(title)}; body=${JSON.stringify(body)}; nativeRequests=${JSON.stringify(requests)}; browserErrors=${JSON.stringify(evidence.events)}`,
      { cause: error },
    );
  }
}

async function communityRequest(
  actor: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const requestHeaders = new Headers(headers);
  if (method !== 'GET') requestHeaders.set('idempotency-key', JSON.stringify(crypto.randomUUID()));
  if (body !== undefined) requestHeaders.set('content-type', 'application/json');
  const response = await stack.kernel(
    path,
    {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    actor,
  );
  const text = await response.text();
  let data: Record<string, any> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    data = { raw: text };
  }
  return { response, data };
}

async function nativePageResponse(actor: string, path: string, expected: number): Promise<Record<string, any>> {
  const result = await communityRequest(actor, 'GET', path);
  expect(result.response.status, `${path}: ${JSON.stringify(result.data)}`).toBe(expected);
  return result.data;
}

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: resolve(screenshotDirectory, `${name}.png`), fullPage: true });
}

async function readOwnRealms(actor: string): Promise<{ realmId: string; name: string; role: string }[]> {
  const result = await communityRequest(actor, 'GET', '/v1/me/realms');
  expect(result.response.status, JSON.stringify(result.data)).toBe(200);
  return result.data.items as { realmId: string; name: string; role: string }[];
}

async function protectedSpaceRequestCount(page: Page, realm: NativeRealmFixture, scale: number): Promise<number> {
  // The flush brackets only this served page. The boundary reads themselves are excluded below.
  await stack.kernel('/v1/definitions/active');
  const first = stack.kernelRequests().length;
  expect(await open(page, `/spaces/${realm.address}`)).toBe(200);
  await page.getByRole('heading', { level: 1, name: realm.spaceTitle }).waitFor({ state: 'visible' });
  await page.getByRole('heading', { name: realm.realmTitle }).waitFor({ state: 'visible' });
  await expectAttribute(page.getByRole('region', { name: 'Membership' }), 'data-member-state', 'member');
  await stack.kernel('/v1/definitions/active');
  const pageRequests = stack
    .kernelRequests()
    .slice(first)
    .filter(({ url }) => /^\/v1\/(spaceAddresses|spaces|realms|subjects)(?:\/|:|\?|$)/.test(url));
  console.info(`native-realms-spaces-growth: unrelated-subjects=${scale} page-kernel-requests=${pageRequests.length}`);
  return pageRequests.length;
}

test('anonymous community navigation, native membership actions, protected admission, ban authority and honest page states', async () => {
  const anonymousContext = await auth.context('anonymous');
  const anonymous = await anonymousContext.newPage();
  const browserEvidence = observeBrowserErrors(anonymous);
  await anonymous.setViewportSize({ width: 390, height: 844 });

  const anonymousSpace = await open(anonymous, `/spaces/${fixture.publicRealm.address}`, browserEvidence);
  expect(anonymousSpace).toBe(200);
  await requireVisibleHeading(anonymous, fixture.publicRealm.spaceTitle, browserEvidence);
  await anonymous.getByRole('heading', { name: fixture.publicRealm.realmTitle, exact: true }).waitFor();
  expect(await nativePageResponse('anonymous', `/v1/spaces/${fixture.publicRealm.spaceId}`, 200)).toMatchObject({
    space: { realmId: fixture.publicRealm.realmId },
  });
  expect(await nativePageResponse('anonymous', `/v1/realms/${fixture.publicRealm.realmId}`, 200)).toMatchObject({
    realm: { realmId: fixture.publicRealm.realmId, title: fixture.publicRealm.realmTitle },
  });

  const boardLink = anonymous.getByRole('link', { name: fixture.publicRealm.boardTitle!, exact: true });
  expect(await boardLink.getAttribute('href')).toBe(`/en/boards/${fixture.publicRealm.boardId}`);
  await boardLink.click();
  await anonymous.waitForURL((url) => url.pathname === `/en/boards/${fixture.publicRealm.boardId}`);
  await anonymous
    .getByRole('heading', { level: 1, name: fixture.publicRealm.boardTitle, exact: true })
    .waitFor({ state: 'visible' });
  expect(await anonymous.getByRole('heading', { level: 1 }).innerText()).toBe(fixture.publicRealm.boardTitle);
  await nativePageResponse('anonymous', `/v1/boards/${fixture.publicRealm.boardId}`, 200);

  await open(anonymous, `/spaces/${fixture.publicRealm.address}`);
  const subjectLink = anonymous.getByRole('link', { name: fixture.publicRealm.subjectTitle!, exact: true });
  const subjectHref = await subjectLink.getAttribute('href');
  expect(subjectHref).toStartWith('/en/subjects/');
  expect(new URL(subjectHref!, stack.web).pathname.split('/')[3]).toBe(fixture.publicRealm.subjectId);
  await subjectLink.click();
  await anonymous.waitForURL((url) => url.pathname.startsWith(`/en/subjects/${fixture.publicRealm.subjectId}/`));
  expect((await anonymous.getByRole('heading', { level: 1 }).innerText()).length).toBeGreaterThan(0);
  await nativePageResponse('anonymous', `/v1/subjects/${fixture.publicRealm.subjectId}`, 200);

  await open(anonymous, `/spaces/${fixture.publicRealm.address}`);
  const realmLink = anonymous.getByRole('link', { name: fixture.publicRealm.realmTitle, exact: true });
  expect(await realmLink.getAttribute('href')).toBe(`/en/realms/${fixture.publicRealm.realmId}`);
  await realmLink.click();
  await anonymous.waitForURL((url) => url.pathname === `/en/spaces/${fixture.publicRealm.address}`);

  const emptySpaceResponse = await open(anonymous, `/spaces/${fixture.emptyRealm.address}`);
  expect(emptySpaceResponse).toBe(200);
  await anonymous.getByText('No boards yet.').waitFor();
  await anonymous.getByText('Nothing has been published here yet.').waitFor();
  await expectVisible(anonymous.getByRole('heading', { level: 2, name: 'Boards' }));
  await screenshot(anonymous, 'empty-boards-390');
  await anonymous.setViewportSize({ width: 1280, height: 900 });
  await anonymous.reload({ waitUntil: 'domcontentloaded' });
  await hydrated(anonymous);
  await expectVisible(anonymous.getByText('No boards yet.'));
  const emptyDesktop = await anonymous.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(emptyDesktop).toEqual({ width: 1280, documentWidth: 1280 });
  await screenshot(anonymous, 'empty-boards-1280');
  await anonymous.setViewportSize({ width: 390, height: 844 });
  const emptyBoards = await nativePageResponse(
    'anonymous',
    `/v1/realms/${fixture.emptyRealm.realmId}/boards?limit=20`,
    200,
  );
  expect(emptyBoards.items).toEqual([]);
  const emptyPublications = await nativePageResponse(
    'anonymous',
    `/v1/realms/${fixture.emptyRealm.realmId}/publications?limit=12`,
    200,
  );
  expect(emptyPublications.items).toEqual([]);

  const aliceJourney = await auth.signIn('alice');
  const alice = aliceJourney.context.pages().at(-1)!;
  const bobJourney = await auth.signIn('bob');
  const bob = bobJourney.context.pages().at(-1)!;
  await alice.setViewportSize({ width: 390, height: 844 });
  await bob.setViewportSize({ width: 1280, height: 900 });

  await open(bob, '/realms');
  expect(await readOwnRealms('bob')).toEqual([]);
  await expectVisible(bob.getByText('You have not joined any Realms yet.'));
  expect(await bob.locator('meta[name="robots"]').getAttribute('content')).toBe('noindex, nofollow');
  await bob.setViewportSize({ width: 390, height: 844 });
  const emptyRealmsMobile = await bob.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(emptyRealmsMobile).toEqual({ width: 390, documentWidth: 390 });
  await expectVisible(bob.getByText('You have not joined any Realms yet.'));
  await screenshot(bob, 'my-realms-empty-390');
  await bob.setViewportSize({ width: 1280, height: 900 });
  await screenshot(bob, 'my-realms-empty-1280');
  const anonymousRealmsStatus = await open(anonymous, '/realms');
  expect(anonymousRealmsStatus).toBeGreaterThanOrEqual(200);
  expect(anonymousRealmsStatus).toBeLessThan(400);
  expect(new URL(anonymous.url()).pathname).not.toBe('/en/realms');
  expect(await anonymous.locator('body').innerText()).not.toContain(fixture.publicRealm.realmTitle);
  const privateRealmsRead = await communityRequest('anonymous', 'GET', '/v1/me/realms');
  expect(privateRealmsRead.response.status).toBe(401);

  const publicJoinReads = await open(alice, `/spaces/${fixture.publicRealm.address}`);
  expect(publicJoinReads).toBe(200);
  const membership = alice.getByRole('region', { name: 'Membership' });
  await expectAttribute(membership, 'data-member-state', 'none');
  await changeMembershipFromPage(alice, 'Join');
  await waitForRealmMembership(stack, fixture.publicRealm.realmId, 'alice', 'member');
  await alice.reload({ waitUntil: 'domcontentloaded' });
  await hydrated(alice);
  await expectAttribute(alice.getByRole('region', { name: 'Membership' }), 'data-member-state', 'member');
  await screenshot(alice, 'open-realm-member-390');

  await alice.getByRole('button', { name: 'Account' }).focus();
  await alice.keyboard.press('Enter');
  const myRealmsMenuLink = alice.getByRole('link', { name: 'Your Realms', exact: true });
  await expectVisible(myRealmsMenuLink);
  await myRealmsMenuLink.focus();
  await alice.keyboard.press('Enter');
  await alice.waitForURL((url) => url.pathname === '/en/realms');
  await hydrated(alice);
  await expectCount(alice.getByRole('dialog'), 0);
  expect(await alice.locator('meta[name="robots"]').getAttribute('content')).toBe('noindex, nofollow');
  const ownRealmsAfterJoin = await readOwnRealms('alice');
  expect(ownRealmsAfterJoin.map(({ realmId }) => realmId)).toContain(fixture.publicRealm.realmId);
  expect(ownRealmsAfterJoin.map(({ realmId }) => realmId)).not.toContain(fixture.protectedRealm.realmId);
  expect(ownRealmsAfterJoin.map(({ realmId }) => realmId)).not.toContain(fixture.emptyRealm.realmId);
  const publicRealmMemberLink = alice.getByRole('link', { name: fixture.publicRealm.realmTitle, exact: true });
  expect(await publicRealmMemberLink.getAttribute('href')).toBe(`/en/realms/${fixture.publicRealm.realmId}`);
  await publicRealmMemberLink.click();
  await alice.waitForURL((url) => url.pathname === `/en/spaces/${fixture.publicRealm.address}`);
  await expectVisible(alice.getByRole('heading', { level: 1, name: fixture.publicRealm.spaceTitle }));

  const unknownRealm = '00000000-0000-4000-8000-000000000000';
  const hiddenPublicSpace = await nativePageResponse('alice', `/v1/spaces/${fixture.protectedRealm.spaceId}`, 200);
  expect(hiddenPublicSpace.space.realmId).toBeNull();
  const protectedBeforeAdmission = await communityRequest(
    'alice',
    'GET',
    `/v1/realms/${fixture.protectedRealm.realmId}`,
  );
  const missingTarget = await communityRequest('alice', 'GET', `/v1/realms/${unknownRealm}`);
  expect(protectedBeforeAdmission.response.status).toBe(404);
  expect(missingTarget.response.status).toBe(404);
  const withoutRequestId = (value: Record<string, any>) => {
    const { request_id: _requestId, ...rest } = value;
    return rest;
  };
  expect(withoutRequestId(protectedBeforeAdmission.data)).toEqual(withoutRequestId(missingTarget.data));
  const anonymousProtectedBoard = await communityRequest(
    'anonymous',
    'GET',
    `/v1/boards/${fixture.protectedRealm.boardId}`,
  );
  const missingBoardBeforeAdmission = await communityRequest(
    'anonymous',
    'GET',
    '/v1/boards/00000000-0000-4000-8000-000000000000',
  );
  expect(anonymousProtectedBoard.response.status).toBe(404);
  expect(withoutRequestId(anonymousProtectedBoard.data)).toEqual(withoutRequestId(missingBoardBeforeAdmission.data));
  const anonymousJoin = await communityRequest(
    'anonymous',
    'POST',
    `/v1/realms/${fixture.publicRealm.realmId}/membership`,
  );
  expect(anonymousJoin.response.status).toBe(401);
  expect(anonymousJoin.data).toMatchObject({ effect_status: 'not_applied' });
  const hiddenJoin = await communityRequest('alice', 'POST', `/v1/realms/${fixture.protectedRealm.realmId}/membership`);
  const missingJoin = await communityRequest('alice', 'POST', `/v1/realms/${unknownRealm}/membership`);
  expect(hiddenJoin.response.status).toBe(404);
  expect(withoutRequestId(hiddenJoin.data)).toEqual(withoutRequestId(missingJoin.data));

  const protectedPageReadStart = stack.kernelRequests().length;
  await open(alice, `/spaces/${fixture.protectedRealm.address}`);
  await waitForKernelRequest(
    protectedPageReadStart,
    ({ method, url, authorization }) =>
      method === 'GET' && url === `/v1/realms/${fixture.protectedRealm.realmId}` && authorization !== null,
  );
  await expectVisible(alice.getByRole('heading', { level: 1, name: fixture.protectedRealm.spaceTitle }));
  await expectCount(alice.getByRole('heading', { name: fixture.protectedRealm.realmTitle }), 0);
  const protectedPageReads = stack.kernelRequests().slice(protectedPageReadStart);
  expect(
    protectedPageReads.some(
      ({ method, url, authorization }) =>
        method === 'GET' && url === `/v1/realms/${fixture.protectedRealm.realmId}` && authorization !== null,
    ),
  ).toBe(true);
  expect(
    protectedPageReads.some(({ url }) => url.startsWith(`/v1/realms/${fixture.protectedRealm.realmId}/boards`)),
  ).toBe(false);
  expect(await alice.locator('body').innerText()).not.toContain(fixture.protectedRealm.boardTitle);
  const invite = await requestNativeCommunity(
    stack,
    'native-community-owner',
    'POST',
    `/v1/realms/${fixture.protectedRealm.realmId}/members`,
    { accountId: fixture.aliceId },
  );
  expect(invite.status).toBe(202);
  await waitForRealmMembership(stack, fixture.protectedRealm.realmId, 'alice', 'member');

  // The fixed page is measured while unrelated released catalogue subjects grow from 1 to 8 to 64.
  const costs: number[] = [];
  await fixture.addUnrelatedSubjects(1);
  costs.push(await protectedSpaceRequestCount(alice, fixture.protectedRealm, 1));
  await fixture.addUnrelatedSubjects(7);
  costs.push(await protectedSpaceRequestCount(alice, fixture.protectedRealm, 8));
  await fixture.addUnrelatedSubjects(56);
  costs.push(await protectedSpaceRequestCount(alice, fixture.protectedRealm, 64));
  expect(costs[1]).toBe(costs[0]);
  expect(costs[2]).toBe(costs[0]);
  await alice.setViewportSize({ width: 1280, height: 900 });
  await alice.reload({ waitUntil: 'domcontentloaded' });
  await hydrated(alice);
  await expectVisible(alice.getByRole('heading', { level: 1, name: fixture.protectedRealm.spaceTitle }));
  await expectVisible(alice.getByRole('heading', { name: fixture.protectedRealm.realmTitle }));
  await screenshot(alice, 'protected-realm-member-1280');

  const protectedOwn = await readOwnRealms('alice');
  expect(protectedOwn.map(({ realmId }) => realmId)).toContain(fixture.protectedRealm.realmId);
  const boardUnavailableBeforeAdmission = await communityRequest(
    'bob',
    'GET',
    `/v1/boards/${fixture.protectedRealm.boardId}`,
  );
  expect(boardUnavailableBeforeAdmission.response.status).toBe(404);
  await open(bob, `/spaces/${fixture.protectedRealm.address}`);
  await expectCount(bob.getByRole('heading', { name: fixture.protectedRealm.realmTitle }), 0);
  expect(await open(bob, `/boards/${fixture.protectedRealm.boardId}`)).toBe(404);
  await expectVisible(bob.getByRole('heading', { level: 1, name: 'Page not found' }));
  expect(await bob.locator('body').innerText()).not.toContain(fixture.protectedRealm.boardTitle);

  await changeMembershipFromPage(alice, 'Leave');
  await waitForRealmMembership(stack, fixture.protectedRealm.realmId, 'alice', 'none');
  const nextProtectedRead = await communityRequest('alice', 'GET', `/v1/boards/${fixture.protectedRealm.boardId}`);
  const missingBoard = await communityRequest('alice', 'GET', '/v1/boards/00000000-0000-4000-8000-000000000000');
  expect(nextProtectedRead.response.status).toBe(404);
  expect(withoutRequestId(nextProtectedRead.data)).toEqual(withoutRequestId(missingBoard.data));
  const ownAfterLeave = await readOwnRealms('alice');
  expect(ownAfterLeave.map(({ realmId }) => realmId)).toContain(fixture.publicRealm.realmId);
  expect(ownAfterLeave.map(({ realmId }) => realmId)).not.toContain(fixture.protectedRealm.realmId);
  const deniedReloadStart = stack.kernelRequests().length;
  await alice.reload({ waitUntil: 'domcontentloaded' });
  await hydrated(alice);
  await waitForKernelRequest(
    deniedReloadStart,
    ({ method, url, authorization }) =>
      method === 'GET' && url === `/v1/realms/${fixture.protectedRealm.realmId}` && authorization !== null,
  );
  await expectVisible(alice.getByRole('heading', { level: 1, name: fixture.protectedRealm.spaceTitle }));
  await expectCount(alice.getByRole('heading', { name: fixture.protectedRealm.realmTitle }), 0);
  await alice.getByRole('button', { name: 'Account' }).focus();
  await alice.keyboard.press('Enter');
  await alice.getByRole('link', { name: 'Your Realms', exact: true }).focus();
  await alice.keyboard.press('Enter');
  await alice.waitForURL((url) => url.pathname === '/en/realms');
  await hydrated(alice);
  await expectVisible(alice.getByRole('link', { name: fixture.publicRealm.realmTitle, exact: true }));
  await expectCount(alice.getByRole('link', { name: fixture.protectedRealm.realmTitle, exact: true }), 0);

  const directGrant = await requestNativeCommunity(stack, 'native-community-owner', 'POST', '/v1/grants', {
    resource: { route: nativeRouteOf(fixture.protectedRealm.realmId), id: fixture.protectedRealm.realmId },
    subject: { kind: 'account', id: fixture.aliceId },
    actions: ['realm:read'],
    valid: '(,)',
  });
  expect(directGrant.status).toBe(201);
  const ownerAddedAgain = await requestNativeCommunity(
    stack,
    'native-community-owner',
    'POST',
    `/v1/realms/${fixture.protectedRealm.realmId}/members`,
    { accountId: fixture.aliceId },
  );
  expect(ownerAddedAgain.status).toBe(202);
  await waitForRealmMembership(stack, fixture.protectedRealm.realmId, 'alice', 'member');
  expect((await communityRequest('alice', 'GET', `/v1/boards/${fixture.protectedRealm.boardId}`)).response.status).toBe(
    200,
  );

  const banPath = `/v1/realms/${fixture.protectedRealm.realmId}/bans/${fixture.aliceId}`;
  const ban = await requestNativeCommunity(stack, 'native-community-owner', 'PUT', banPath, {
    reason: 'Native web ban boundary',
  });
  expect([200, 202]).toContain(ban.status);
  const bannedRealm = await communityRequest('alice', 'GET', `/v1/realms/${fixture.protectedRealm.realmId}`);
  const hiddenRealm = await communityRequest('alice', 'GET', `/v1/realms/${unknownRealm}`);
  expect(bannedRealm.response.status).toBe(404);
  expect(withoutRequestId(bannedRealm.data)).toEqual(withoutRequestId(hiddenRealm.data));
  expect((await communityRequest('alice', 'GET', `/v1/boards/${fixture.protectedRealm.boardId}`)).response.status).toBe(
    404,
  );
  expect(
    (await communityRequest('alice', 'GET', `/v1/spaces/${fixture.protectedRealm.spaceId}`)).data.space.realmId,
  ).toBe(null);
  expect(
    (await communityRequest('alice', 'POST', `/v1/realms/${fixture.protectedRealm.realmId}/membership`)).response
      .status,
  ).toBe(403);
  expect(await readOwnRealms('alice').then((rows) => rows.map(({ realmId }) => realmId))).not.toContain(
    fixture.protectedRealm.realmId,
  );

  const publicBan = await requestNativeCommunity(
    stack,
    'native-community-owner',
    'PUT',
    `/v1/realms/${fixture.publicRealm.realmId}/bans/${fixture.aliceId}`,
    { reason: 'Native web public ban boundary' },
  );
  expect([200, 202]).toContain(publicBan.status);
  await waitForRealmMembership(stack, fixture.publicRealm.realmId, 'alice', 'banned');
  await open(alice, `/spaces/${fixture.publicRealm.address}`);
  await expectAttribute(alice.getByRole('region', { name: 'Membership' }), 'data-member-state', 'banned');
  await expectCount(alice.getByRole('button', { name: 'Join', exact: true }), 0);
  expect((await communityRequest('alice', 'GET', `/v1/realms/${fixture.publicRealm.realmId}`)).response.status).toBe(
    200,
  );

  const unban = await requestNativeCommunity(stack, 'native-community-owner', 'DELETE', banPath);
  expect(unban.status).toBe(204);
  const publicUnban = await requestNativeCommunity(
    stack,
    'native-community-owner',
    'DELETE',
    `/v1/realms/${fixture.publicRealm.realmId}/bans/${fixture.aliceId}`,
  );
  expect(publicUnban.status).toBe(204);
  expect((await communityRequest('alice', 'GET', `/v1/realms/${fixture.protectedRealm.realmId}`)).response.status).toBe(
    200,
  );
  await open(alice, `/spaces/${fixture.publicRealm.address}`);
  await expectAttribute(alice.getByRole('region', { name: 'Membership' }), 'data-member-state', 'none');
  await changeMembershipFromPage(alice, 'Join');
  await waitForRealmMembership(stack, fixture.publicRealm.realmId, 'alice', 'member');
  await alice.reload({ waitUntil: 'domcontentloaded' });
  await hydrated(alice);
  await expectAttribute(alice.getByRole('region', { name: 'Membership' }), 'data-member-state', 'member');

  await alice.setViewportSize({ width: 390, height: 844 });
  await open(anonymous, `/spaces/${fixture.publicRealm.address}`);
  const viewport = await anonymous.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    heading: document.querySelector('h1')?.getBoundingClientRect().right ?? 0,
  }));
  expect(viewport.width).toBe(390);
  expect(viewport.documentWidth).toBeLessThanOrEqual(viewport.width + 1);
  expect(viewport.heading).toBeLessThanOrEqual(viewport.width + 1);
  await screenshot(anonymous, 'long-space-390');
  await anonymous.setViewportSize({ width: 1280, height: 900 });
  await anonymous.reload({ waitUntil: 'domcontentloaded' });
  await hydrated(anonymous);
  const desktop = await anonymous.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(desktop.width).toBe(1280);
  expect(desktop.documentWidth).toBeLessThanOrEqual(desktop.width + 1);
  await screenshot(anonymous, 'long-space-1280');

  await anonymous.setViewportSize({ width: 390, height: 844 });
  const unknownSubject = await open(anonymous, '/subjects/00000000-0000-4000-8000-000000000000');
  expect([200, 404]).toContain(unknownSubject);
  await expectVisible(anonymous.getByRole('heading', { level: 1, name: 'Page not found' }));
  const missingSubjectViewport = await anonymous.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(missingSubjectViewport).toEqual({ width: 390, documentWidth: 390 });
  await screenshot(anonymous, 'missing-subject-390');
  await anonymous.setViewportSize({ width: 1280, height: 900 });
  await anonymous.reload({ waitUntil: 'domcontentloaded' });
  await hydrated(anonymous);
  await expectVisible(anonymous.getByRole('heading', { level: 1, name: 'Page not found' }));
  await screenshot(anonymous, 'missing-subject-1280');
  await nativePageResponse('anonymous', '/v1/subjects/00000000-0000-4000-8000-000000000000', 404);
});
