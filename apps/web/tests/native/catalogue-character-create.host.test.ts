import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { startAuthStack } from './auth-stack.ts';
import { createSubject, hydrate } from './catalogue-relations-fixture.ts';
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

async function characterForm(page: Page) {
  await hydrate(page);
  const form = page.getByRole('form', { name: 'Character details' });
  await form.waitFor({ state: 'visible' });
  return form;
}

function posts(label: string) {
  return stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body) return false;
    return (JSON.parse(request.body) as { labels?: { en?: string }; type?: string }).labels?.en === label;
  });
}

test('guest, unsigned grant, unavailable observation, and a stale work stay distinct', async () => {
  const guest = await (await auth.context('anonymous')).newPage();
  guest.setDefaultTimeout(30_000);
  await guest.goto(`${stack.web}/en/catalogue/character`, { waitUntil: 'domcontentloaded' });
  const guestForm = await characterForm(guest);
  await guest.getByText(/sign in to create a catalogue identity/i).waitFor({ state: 'visible' });
  expect(await guestForm.getByRole('textbox', { name: 'Name', exact: true }).count()).toBeGreaterThan(0);
  expect(await guestForm.getByRole('button', { name: 'Review fictional character', exact: true }).isDisabled()).toBe(
    true,
  );
  await guest.close();

  const bob = await auth.signIn('bob', { returnTo: '/en/catalogue/character' });
  const bobPage = bob.context.pages().at(-1)!;
  bobPage.setDefaultTimeout(30_000);
  const bobForm = await characterForm(bobPage);
  await bobPage.getByText(/does not allow creating a catalogue identity/i).waitFor({ state: 'visible' });
  const bobLabel = `Unsigned character ${crypto.randomUUID()}`;
  await bobForm.getByRole('textbox', { name: 'Name', exact: true }).fill(bobLabel);
  expect(await bobForm.getByRole('button', { name: 'Review fictional character', exact: true }).isDisabled()).toBe(true);
  await stack.syncKernelRequests();
  expect(posts(bobLabel)).toHaveLength(0);
  await bobPage.close();

  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/character' });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/viewerActions',
    status: 503,
    body: '{"title":"Temporarily unavailable","status":503,"code":"dependency_unavailable"}',
  });
  await page.goto(`${stack.web}/en/catalogue/character`, { waitUntil: 'domcontentloaded' });
  const unavailableForm = await characterForm(page);
  await page.getByText(/required service is unavailable/i).waitFor({ state: 'visible' });
  expect(await unavailableForm.getByRole('textbox', { name: 'Name', exact: true }).count()).toBeGreaterThan(0);
  expect(
    await unavailableForm.getByRole('button', { name: 'Review fictional character', exact: true }).isDisabled(),
  ).toBe(true);
  await page.getByRole('button', { name: /retry creation eligibility/i }).click();
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });

  const missing = crypto.randomUUID();
  await page.goto(`${stack.web}/en/catalogue/character?work=${missing}`, { waitUntil: 'domcontentloaded' });
  await hydrate(page);
  await page.getByRole('alert').waitFor({ state: 'visible' });
  expect(await page.getByRole('form', { name: 'Character details' }).count()).toBe(0);
  await stack.syncKernelRequests();
  expect(posts(`stale-work-${missing}`)).toHaveLength(0);
}, 300_000);

test('eligible Character create from a work context retries unknown delivery and failed readback', async () => {
  const work = await createSubject(stack, 'schema:Movie', `Character work ${crypto.randomUUID().slice(0, 8)}`);
  const journey = await auth.signIn('alice', { returnTo: `/en/catalogue/character?work=${work.id}` });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  const form = await characterForm(page);
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  expect(await page.getByText(work.label).count()).toBeGreaterThan(0);
  const label = `Native character ${crypto.randomUUID()}`;
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(label);
  await form.getByRole('button', { name: 'Review fictional character', exact: true }).click();
  await page.getByRole('region', { name: 'Review this character' }).waitFor({ state: 'visible' });

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
  await form.getByRole('button', { name: 'Create fictional character', exact: true }).click();
  await page.getByText(/does not allow creating a catalogue identity/i).waitFor({ state: 'visible' });
  await stack.syncKernelRequests();
  expect(posts(label)).toHaveLength(0);

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
  await page.getByRole('button', { name: /retry creation eligibility/i }).click();
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });

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
  await form.getByRole('button', { name: 'Create fictional character', exact: true }).click();
  await page.getByRole('alert').waitFor({ state: 'visible' });
  await stack.injectCreatedSubjectReadFailureOnce({ status: 503, body: '{"title":"Reader temporarily unavailable"}' });
  await form.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.unroute('**/_serverFn/**', dropFirstCreateResponse);
  const outcome = page.locator('[data-slot="character-created"]');
  await outcome.waitFor({ state: 'visible' });
  const createdId = (await outcome.locator('code').innerText()).trim();
  expect(createdId).toMatch(/^[0-9a-f-]{36}$/i);
  await stack.syncKernelRequests();
  const created = posts(label);
  expect(created.length).toBeGreaterThanOrEqual(1);
  expect(created.every((request) => request.idempotencyKey === created[0]?.idempotencyKey)).toBe(true);
  expect(created.every((request) => request.body === created[0]?.body)).toBe(true);
  await outcome.getByRole('button', { name: /retry/i }).click();
  await page.waitForURL((url) => url.pathname.includes(`/subjects/${createdId}`));
  await stack.syncKernelRequests();
  expect(posts(label).length).toBe(created.length);
  const native = await json<{ subject: { id: string; type: string } }>(
    await stack.kernel(`/v1/subjects/${createdId}`),
    'read created Character',
  );
  expect(native.subject.id).toBe(createdId);
  expect(native.subject.type).toBe('wd:Q95074');
}, 900_000);
