import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { startAuthStack } from './auth-stack.ts';
import { startNativeWebStack } from './stack.ts';

let stack: Awaited<ReturnType<typeof startNativeWebStack>>;
let auth: Awaited<ReturnType<typeof startAuthStack>>;

beforeAll(async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
}, 300_000);

afterAll(async () => {
  await auth?.stop();
  await stack?.stop();
}, 180_000);

async function chooseFood(page: Page) {
  await page.locator('#create-type-search-mode').selectOption('id');
  const query = page.locator('#create-type-query');
  await query.fill('wd:Q2095');
  await query.press('Enter');
  const select = page.getByRole('button', { name: /^Select / });
  await select.waitFor({ state: 'visible' });
  await select.click();
}

async function confirmIdentity(page: Page, label: string) {
  await page.locator('#create-language-0').fill('en');
  await page.locator('#create-label-0').fill(label);
  await page.getByRole('button', { name: /search catalogue identities/i }).click();
  await page.getByRole('button', { name: /continue with this type/i }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /continue with this type/i }).click();
}

async function subjectPosts(label: string) {
  await stack.syncKernelRequests();
  return stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body) return false;
    return (JSON.parse(request.body) as { labels?: { en?: string } }).labels?.en === label;
  });
}

async function json<T>(response: Response, action: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${action} returned ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

test('guest eligibility stays searchable and does not create', async () => {
  const page = await (await auth.context('anonymous')).newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${stack.web}/en/catalogue/new`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/sign in to create a catalogue identity/i).waitFor({ state: 'visible' });
  await chooseFood(page);
  await page.locator('#create-language-0').fill('en');
  await page.locator('#create-label-0').fill(`Guest searchable ${crypto.randomUUID()}`);
  await page.getByRole('button', { name: /search catalogue identities/i }).click();
  await page.getByRole('button', { name: /continue with this type/i }).waitFor({ state: 'visible' });
  expect(await page.locator('#create-subject-submit').isDisabled()).toBe(true);
  expect(await subjectPosts(await page.locator('#create-label-0').inputValue())).toHaveLength(0);
  await page.close();
}, 300_000);

test('eligible create, revoked authority, unknown delivery, and exact-id recovery', async () => {
  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/new' });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(30_000);
  await page.locator('form').waitFor({ state: 'visible' });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  await chooseFood(page);
  const label = `Native identity ${crypto.randomUUID()}`;
  await confirmIdentity(page, label);
  const submit = page.locator('#create-subject-submit');
  await submit.click();
  await page.getByRole('region', { name: /review/i }).waitFor({ state: 'visible' });
  await submit.click();
  await page.waitForURL((url) => url.pathname.includes('/subjects/'));
  const createdId = new URL(page.url()).pathname.match(/^\/en\/subjects\/([^/]+)/)?.[1];
  expect(createdId).toBeTruthy();
  expect(await subjectPosts(label)).toHaveLength(1);

  const alice = await stack.authPersona('alice');
  const revoked = await stack.kernel(
    '/v1/grants:revoke',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: alice.accountId },
        actions: ['subject:create'],
        valid: '(,)',
      }),
    },
    'governor',
  );
  expect([200, 201, 204, 409]).toContain(revoked.status);

  await page.goto(`${stack.web}/en/catalogue/new`, { waitUntil: 'domcontentloaded' });
  await page.locator('form').waitFor({ state: 'visible' });
  await page.getByText(/does not allow creating a catalogue identity/i).waitFor({ state: 'visible' });
  const refusedLabel = `Refused identity ${crypto.randomUUID()}`;
  await chooseFood(page);
  await confirmIdentity(page, refusedLabel);
  expect(await page.locator('#create-subject-submit').isDisabled()).toBe(true);
  expect(await subjectPosts(refusedLabel)).toHaveLength(0);

  await json(
    await stack.kernel(
      '/v1/grants',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          resource: { route: 0, id: GLOBAL_CONTEXT },
          subject: { kind: 'account', id: alice.accountId },
          actions: ['subject:create'],
          valid: '(,)',
        }),
      },
      'governor',
    ),
    'restore subject:create',
  );

  await page.goto(`${stack.web}/en/catalogue/new`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  await chooseFood(page);
  const uncertainLabel = `Uncertain identity ${crypto.randomUUID()}`;
  await confirmIdentity(page, uncertainLabel);
  let droppedResponse: { status: number; body: string } | undefined;
  const dropFirstCreateResponse = async (route: import('playwright').Route) => {
    if (!droppedResponse && route.request().method() === 'POST') {
      const response = await route.fetch();
      droppedResponse = { status: response.status(), body: await response.text() };
      await route.abort('failed');
      return;
    }
    await route.continue();
  };
  await page.route('**/_serverFn/**', dropFirstCreateResponse);
  await page.locator('#create-subject-submit').click();
  await page.getByRole('region', { name: /review/i }).waitFor({ state: 'visible' });
  await page.locator('#create-subject-submit').click();
  await page.getByRole('alert').waitFor({ state: 'visible' });
  await page.locator('#create-subject-submit').click();
  await page.waitForURL((url) => url.pathname.includes('/subjects/'));
  await page.unroute('**/_serverFn/**', dropFirstCreateResponse);
  const uncertainPosts = await subjectPosts(uncertainLabel);
  expect(uncertainPosts.length).toBeGreaterThanOrEqual(2);
  expect(uncertainPosts[1]?.idempotencyKey).toBe(uncertainPosts[0]?.idempotencyKey);
  expect(uncertainPosts[1]?.body).toBe(uncertainPosts[0]?.body);

  await page.goto(`${stack.web}/en/catalogue/new`, { waitUntil: 'domcontentloaded' });
  await chooseFood(page);
  const recoveredLabel = `Recovered identity ${crypto.randomUUID()}`;
  await confirmIdentity(page, recoveredLabel);
  await stack.injectCreatedSubjectReadFailureOnce({ status: 503, body: '{"title":"Reader temporarily unavailable"}' });
  await page.locator('#create-subject-submit').click();
  await page.getByRole('region', { name: /review/i }).waitFor({ state: 'visible' });
  await page.locator('#create-subject-submit').click();
  const outcome = page.locator('section[role="status"]');
  await outcome.waitFor({ state: 'visible' });
  const recoveredId = (await outcome.locator('code').innerText()).trim();
  expect(recoveredId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(await subjectPosts(recoveredLabel)).toHaveLength(1);
  await outcome.getByRole('button', { name: /retry/i }).click();
  await page.waitForURL((url) => url.pathname.includes(`/subjects/${recoveredId}`));
  expect(await subjectPosts(recoveredLabel)).toHaveLength(1);
}, 900_000);

test('temporarily unknown eligibility and a failed suggestion keep creation separate', async () => {
  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/new' });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(30_000);
  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/viewerActions',
    status: 503,
    body: '{"title":"Temporarily unavailable","status":503,"code":"dependency_unavailable"}',
  });
  await page.goto(`${stack.web}/en/catalogue/new`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/required service is unavailable/i).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /retry creation eligibility/i }).click();
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });

  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/subjects:suggest',
    status: 503,
    body: '{"title":"Search unavailable","status":503,"code":"dependency_unavailable"}',
  });
  await chooseFood(page);
  await page.locator('#create-language-0').fill('en');
  await page.locator('#create-label-0').fill(`Allowed despite search ${crypto.randomUUID()}`);
  await page.getByRole('button', { name: /search catalogue identities/i }).click();
  await page.getByRole('alert').filter({ hasText: /search is unavailable/i }).waitFor({ state: 'visible' });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
}, 300_000);
