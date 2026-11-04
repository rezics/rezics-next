import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { startAuthStack } from './auth-stack.ts';
import { startNativeWebStack } from './stack.ts';

setDefaultTimeout(900_000);
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

async function json<T>(response: Response, action: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${action} returned ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function posts(label: string) {
  return stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body) return false;
    return (JSON.parse(request.body) as { labels?: { en?: string } }).labels?.en === label;
  });
}

async function admittedType(page: Page) {
  const type = page.getByLabel('Type', { exact: true });
  const options = await type
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value.length > 0));
  expect(options.length).toBeGreaterThan(0);
  const selected = options.includes('schema:Place') ? 'schema:Place' : options[0]!;
  await type.selectOption(selected);
  return selected;
}

async function confirmCreate(page: Page) {
  const submit = page.getByRole('button', { name: 'Create subject', exact: true });
  await submit.click();
  await page.locator('[data-music-context-create-review]').waitFor({ state: 'visible' });
  await submit.click();
}

test('an admitted music-context Type is created once and independently readable with its initial facts', async () => {
  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/music-context' });
  expect(journey.url).toBe(`${stack.web}/en/catalogue/music-context`);
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await page.locator('form').waitFor({ state: 'visible' });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  const selected = await admittedType(page);
  const token = crypto.randomUUID().slice(0, 8);
  const label = `Native music context ${token}`;
  await page.locator('#create-language-0').fill('en');
  await page.locator('#create-label-0').fill(label);
  const addFact = page.getByLabel('Add an initial fact', { exact: true });
  let fact: string | undefined;
  if (await addFact.count()) {
    const properties = await addFact
      .locator('option')
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value.length > 0),
      );
    fact = properties.find((id) => id === 'schema:sameAs' || id === 'schema:url');
    if (fact) {
      await addFact.selectOption(fact);
      await page.getByRole('button', { name: 'Add an initial fact', exact: true }).click();
      const row = page.locator('[data-slot="music-context-initial-fact"]').first();
      await row.getByRole('textbox').first().fill(`https://example.org/place/${token}`);
    }
  }
  await confirmCreate(page);
  await page.waitForURL((url) => url.pathname.includes('/subjects/') && !url.pathname.endsWith('/music-context'));
  const createdId = new URL(page.url()).pathname.match(/^\/en\/subjects\/([^/]+)/)?.[1];
  expect(createdId).toBeTruthy();
  await stack.syncKernelRequests();
  const created = posts(label);
  expect(created).toHaveLength(1);
  const body = JSON.parse(created[0]!.body!) as {
    type: string;
    statements?: Record<string, { rank?: string; value?: { content?: unknown } }[]>;
  };
  expect(body.type).toBe(selected);
  if (fact) expect(body.statements?.[fact]?.[0]?.rank).toBe('normal');
  const native = await json<{
    subject: { id: string; type: string; statements?: Record<string, { value?: { content?: unknown } }[]> };
  }>(await stack.kernel(`/v1/subjects/${createdId}`), 'read created music context');
  expect(native.subject.id).toBe(createdId);
  expect(native.subject.type).toBe(selected);
  if (fact) expect(native.subject.statements?.[fact]?.[0]?.value?.content).toBe(`https://example.org/place/${token}`);
});

test('guest, unavailable observation, revoked grant, and a stale sealed command stay distinct', async () => {
  const guest = await (await auth.context('anonymous')).newPage();
  guest.setDefaultTimeout(30_000);
  await guest.goto(`${stack.web}/en/catalogue/music-context`, { waitUntil: 'domcontentloaded' });
  await guest.getByText(/sign in to create a catalogue identity/i).waitFor({ state: 'visible' });
  expect(await guest.getByLabel('Type', { exact: true }).count()).toBeGreaterThan(0);
  expect(await guest.locator('#create-subject-submit').isDisabled()).toBe(true);
  await guest.close();

  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/music-context' });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/viewerActions',
    status: 503,
    body: '{"title":"Temporarily unavailable","status":503,"code":"dependency_unavailable"}',
  });
  await page.goto(`${stack.web}/en/catalogue/music-context`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/required service is unavailable/i).waitFor({ state: 'visible' });
  expect(await page.getByLabel('Type', { exact: true }).count()).toBeGreaterThan(0);
  expect(await page.locator('#create-subject-submit').isDisabled()).toBe(true);
  await page.getByRole('button', { name: /retry creation eligibility/i }).click();
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });

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
  await page.goto(`${stack.web}/en/catalogue/music-context`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/does not allow creating a catalogue identity/i).waitFor({ state: 'visible' });
  await admittedType(page);
  const refusedLabel = `Refused music context ${crypto.randomUUID().slice(0, 8)}`;
  await page.locator('#create-language-0').fill('en');
  await page.locator('#create-label-0').fill(refusedLabel);
  expect(await page.locator('#create-subject-submit').isDisabled()).toBe(true);
  expect(posts(refusedLabel)).toHaveLength(0);

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

  await page.goto(`${stack.web}/en/catalogue/music-context`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  await admittedType(page);
  const staleLabel = `Stale music context ${crypto.randomUUID().slice(0, 8)}`;
  await page.locator('#create-language-0').fill('en');
  await page.locator('#create-label-0').fill(staleLabel);
  await page.getByRole('button', { name: 'Create subject', exact: true }).click();
  await page.locator('[data-music-context-create-review]').waitFor({ state: 'visible' });
  let dropped = false;
  await page.route('**/_serverFn/**', async (route) => {
    if (!dropped && route.request().method() === 'POST') {
      dropped = true;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Create subject', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'visible' });
  const sealed = await stack.kernel(
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
  expect([200, 201, 204, 409]).toContain(sealed.status);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'visible' });
  await stack.syncKernelRequests();
  const stale = posts(staleLabel);
  expect(stale.length).toBeGreaterThanOrEqual(1);
  expect(stale.every((request) => request.idempotencyKey === stale[0]?.idempotencyKey)).toBe(true);
  expect(stale.every((request) => request.body === stale[0]?.body)).toBe(true);

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
    'restore subject:create after stale command',
  );
});

test('unknown delivery retries the same bytes and key; a known acknowledgment retries only the reader', async () => {
  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/music-context' });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await page.locator('form').waitFor({ state: 'visible' });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  await admittedType(page);
  const token = crypto.randomUUID().slice(0, 8);
  const uncertainLabel = `Uncertain music context ${token}`;
  await page.locator('#create-language-0').fill('en');
  await page.locator('#create-label-0').fill(uncertainLabel);
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
  await confirmCreate(page);
  await page.getByRole('alert').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForURL((url) => url.pathname.includes('/subjects/'));
  await page.unroute('**/_serverFn/**', dropFirstCreateResponse);
  expect(droppedResponse?.status).toBe(200);
  await stack.syncKernelRequests();
  const uncertain = posts(uncertainLabel);
  expect(uncertain.length).toBeGreaterThanOrEqual(2);
  expect(uncertain[1]?.idempotencyKey).toBe(uncertain[0]?.idempotencyKey);
  expect(uncertain[1]?.body).toBe(uncertain[0]?.body);

  await page.goto(`${stack.web}/en/catalogue/music-context`, { waitUntil: 'domcontentloaded' });
  await admittedType(page);
  const recoveredLabel = `Recovered music context ${crypto.randomUUID().slice(0, 8)}`;
  await page.locator('#create-language-0').fill('en');
  await page.locator('#create-label-0').fill(recoveredLabel);
  await stack.injectCreatedSubjectReadFailureOnce({
    status: 503,
    body: '{"title":"Reader temporarily unavailable"}',
  });
  await confirmCreate(page);
  const outcome = page.locator('section[role="status"]');
  await outcome.waitFor({ state: 'visible' });
  const recoveredId = (await outcome.locator('code').innerText()).trim();
  expect(recoveredId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(await posts(recoveredLabel)).toHaveLength(1);
  await outcome.getByRole('button', { name: /retry/i }).click();
  await page.waitForURL((url) => url.pathname.includes(`/subjects/${recoveredId}`));
  expect(await posts(recoveredLabel)).toHaveLength(1);
});
