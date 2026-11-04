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

const peoplePath = '/en/catalogue/people';

async function openPeople(page: Page) {
  await page.goto(`${stack.web}${peoplePath}`, { waitUntil: 'domcontentloaded' });
  await page.locator('form').waitFor({ state: 'visible' });
}

async function chooseProfile(page: Page, type: 'schema:Person' | 'schema:Organization') {
  const selector = page.getByLabel('Type', { exact: true });
  const options = await selector
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
  expect(options).toContain(type);
  await selector.selectOption(type);
}

function subjectPosts(label: string) {
  return stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body) return false;
    return (JSON.parse(request.body) as { labels?: { en?: string } }).labels?.en === label;
  });
}

async function createAndRead(page: Page, type: 'schema:Person' | 'schema:Organization') {
  const label = `Native people profile ${crypto.randomUUID()}`;
  await chooseProfile(page, type);
  await page.getByLabel('Name', { exact: true }).fill(label);
  const submit = page.getByRole('button', { name: 'Create subject', exact: true });
  await submit.click();
  await page.locator('[data-people-create-review]').waitFor({ state: 'visible' });
  await submit.click();
  await page.waitForURL((url) => url.pathname.includes('/subjects/'));
  const id = new URL(page.url()).pathname.match(/^\/en\/subjects\/([^/]+)/)?.[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  await stack.syncKernelRequests();

  const posts = subjectPosts(label);
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0]!.body!)).toMatchObject({ type, labels: { en: label } });
  expect(
    stack.kernelRequests().some(
      (request) =>
        request.method === 'GET' &&
        request.url.split('?')[0] === `/v1/subjects/${id}` &&
        request.responseStatus === 200,
    ),
  ).toBe(true);
}

test('the ordinary People route uses current Access and both released profile choices', async () => {
  const guest = await (await auth.context('anonymous')).newPage();
  await guest.goto(`${stack.web}${peoplePath}`, { waitUntil: 'domcontentloaded' });
  await guest.getByText(/sign in to create a catalogue identity/i).waitFor({ state: 'visible' });
  expect(await guest.getByRole('button', { name: 'Create subject', exact: true }).count()).toBe(0);
  await guest.close();

  const journey = await auth.signIn('alice', { returnTo: peoplePath });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(30_000);
  for (const type of ['schema:Person', 'schema:Organization'] as const) {
    await openPeople(page);
    await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
    await createAndRead(page, type);
  }

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
  await openPeople(page);
  await page.getByText(/does not allow creating a catalogue identity/i).waitFor({ state: 'visible' });
  await chooseProfile(page, 'schema:Organization');
  const refused = `Refused organization ${crypto.randomUUID()}`;
  await page.getByLabel('Name', { exact: true }).fill(refused);
  expect(await page.getByRole('button', { name: 'Create subject', exact: true }).isDisabled()).toBe(true);
  expect(subjectPosts(refused)).toHaveLength(0);

  const restored = await stack.kernel(
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
  );
  expect([200, 201, 204, 409]).toContain(restored.status);

  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/viewerActions',
    status: 503,
    body: '{"title":"Temporarily unavailable","status":503,"code":"dependency_unavailable"}',
  });
  await openPeople(page);
  await page.getByText(/required service is unavailable/i).waitFor({ state: 'visible' });
  const unavailableTypes = await page
    .getByLabel('Type', { exact: true })
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
  expect(unavailableTypes).toEqual(expect.arrayContaining(['schema:Person', 'schema:Organization']));
  await page.getByRole('button', { name: /retry creation eligibility/i }).click();
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  await page.close();
}, 900_000);
