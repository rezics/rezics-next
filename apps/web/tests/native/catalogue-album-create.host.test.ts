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

async function confirmAlbum(page: Page) {
  await page.getByRole('button', { name: 'Review album', exact: true }).click();
  await page.locator('[data-album-create-review]').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Create album', exact: true }).click();
}

async function subjectPosts(label: string) {
  await stack.syncKernelRequests();
  return stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body) return false;
    const body = JSON.parse(request.body) as { type?: string; labels?: { en?: string } };
    return body.type === 'schema:MusicAlbum' && body.labels?.en === label;
  });
}

async function json<T>(response: Response, action: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${action} returned ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function readCreated(id: string) {
  const response = await stack.kernel(`/v1/subjects/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    subject: {
      id: string;
      type: string;
      labels: Record<string, string>;
      statements: Record<string, { value: { type: string; content: unknown } }[]>;
    };
  };
}

test('guest eligibility keeps album reading useful and does not create', async () => {
  const page = await (await auth.context('anonymous')).newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${stack.web}/en/catalogue/album`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/sign in to create a catalogue identity/i).waitFor({ state: 'visible' });
  await page.getByText(/describe the album as a creative work/i).waitFor({ state: 'visible' });
  expect(await page.getByRole('button', { name: 'Review album', exact: true }).isDisabled()).toBe(true);
  expect(await subjectPosts('guest')).toHaveLength(0);
  await page.close();
}, 300_000);

test('eligible album create, revoked authority, unknown delivery, and exact-id recovery', async () => {
  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/album' });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(30_000);
  await page.locator('form').waitFor({ state: 'visible' });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  const label = `Native album ${crypto.randomUUID()}`;
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(label);
  await page.getByLabel('Add fact').selectOption('schema:inLanguage');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('textbox', { name: 'Value', exact: true }).fill('en');
  await confirmAlbum(page);
  const createdCode = page.locator('code').first();
  await createdCode.waitFor({ state: 'visible' });
  const createdId = (await createdCode.innerText()).trim();
  expect(createdId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(await subjectPosts(label)).toHaveLength(1);
  const created = await readCreated(createdId);
  expect(created.subject.id).toBe(createdId);
  expect(created.subject.type).toBe('schema:MusicAlbum');
  expect(created.subject.labels.en).toBe(label);
  expect(created.subject.statements['schema:inLanguage']?.[0]?.value).toEqual({ type: 'value', content: 'en' });

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

  await page.goto(`${stack.web}/en/catalogue/album`, { waitUntil: 'domcontentloaded' });
  await page.locator('form').waitFor({ state: 'visible' });
  await page.getByText(/does not allow creating a catalogue identity/i).waitFor({ state: 'visible' });
  const refusedLabel = `Refused album ${crypto.randomUUID()}`;
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(refusedLabel);
  expect(await page.getByRole('button', { name: 'Review album', exact: true }).isDisabled()).toBe(true);
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

  await page.goto(`${stack.web}/en/catalogue/album`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  const uncertainLabel = `Uncertain album ${crypto.randomUUID()}`;
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(uncertainLabel);
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
  await confirmAlbum(page);
  await page.getByRole('alert').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /retry/i }).click();
  await page.locator('code').first().waitFor({ state: 'visible' });
  await page.unroute('**/_serverFn/**', dropFirstCreateResponse);
  const uncertainPosts = await subjectPosts(uncertainLabel);
  expect(uncertainPosts.length).toBeGreaterThanOrEqual(2);
  expect(uncertainPosts[1]?.idempotencyKey).toBe(uncertainPosts[0]?.idempotencyKey);
  expect(uncertainPosts[1]?.body).toBe(uncertainPosts[0]?.body);

  await page.goto(`${stack.web}/en/catalogue/album`, { waitUntil: 'domcontentloaded' });
  const recoveredLabel = `Recovered album ${crypto.randomUUID()}`;
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(recoveredLabel);
  await stack.injectCreatedSubjectReadFailureOnce({ status: 503, body: '{"title":"Reader temporarily unavailable"}' });
  await confirmAlbum(page);
  const outcome = page.locator('section').filter({ has: page.locator('code') }).first();
  await outcome.waitFor({ state: 'visible' });
  const recoveredId = (await outcome.locator('code').innerText()).trim();
  expect(recoveredId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(await subjectPosts(recoveredLabel)).toHaveLength(1);
  await page.getByRole('button', { name: /retry/i }).click();
  await page.getByRole('link', { name: /open/i }).waitFor({ state: 'visible' });
  expect(await page.getByRole('link', { name: /open/i }).getAttribute('href')).toContain(`/subjects/${recoveredId}`);
  expect(await subjectPosts(recoveredLabel)).toHaveLength(1);
}, 900_000);

test('temporarily unknown album eligibility keeps the draft and stays separate from definitions', async () => {
  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/album' });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(30_000);
  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/viewerActions',
    status: 503,
    body: '{"title":"Temporarily unavailable","status":503,"code":"dependency_unavailable"}',
  });
  await page.goto(`${stack.web}/en/catalogue/album`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/required service is unavailable/i).waitFor({ state: 'visible' });
  await page.getByText(/describe the album as a creative work/i).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /retry creation eligibility/i }).click();
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
}, 300_000);
