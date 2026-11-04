import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Page } from 'playwright';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { candidateContext } from '../../src/subject/candidates.ts';
import { subjectHref } from '../../src/subject/subject-href.ts';
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

function candidateWrites() {
  return stack.kernelRequests().filter((request) => {
    if (request.fixtureRequest || !request.body) return false;
    return request.method === 'POST' && request.url.includes('/candidates');
  });
}

async function selectConceptType(page: Page) {
  const type = page.getByLabel('Type', { exact: true });
  await type.waitFor({ state: 'visible' });
  const values = await type
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value.length > 0));
  const concept = values.find((value) => value === 'skos:Concept') ?? values[0];
  expect(concept).toBeTruthy();
  await type.selectOption(concept!);
}

async function confirmIdentity(page: Page, label: string) {
  await page.locator('#create-language-0').fill('en');
  await page.locator('#create-label-0').fill(label);
  await page.getByRole('button', { name: /search catalogue identities/i }).click();
  await page.getByRole('button', { name: /continue with this type/i }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /continue with this type/i }).click();
}

async function confirmCreate(page: Page) {
  const submit = page.getByRole('button', { name: 'Create subject', exact: true });
  await submit.click();
  await page.locator('[data-concept-create-review]').waitFor({ state: 'visible' });
  await submit.click();
}

test('eligible Concept create retries unknown delivery with the same key and recovers a known id', async () => {
  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/concept' });
  expect(journey.url).toBe(`${stack.web}/en/catalogue/concept`);
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await page.locator('form').waitFor({ state: 'visible' });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  await selectConceptType(page);
  const label = `Native concept ${crypto.randomUUID().slice(0, 8)}`;
  await confirmIdentity(page, label);
  let dropped = false;
  await page.route('**/_serverFn/**', async (route) => {
    if (!dropped && route.request().method() === 'POST') {
      dropped = true;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await confirmCreate(page);
  await page.getByRole('alert').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForURL((url) => url.pathname.includes('/subjects/'));
  const createdId = new URL(page.url()).pathname.match(/^\/en\/subjects\/([^/]+)/)?.[1];
  expect(createdId).toBeTruthy();
  await page.unroute('**/_serverFn/**');
  await stack.syncKernelRequests();
  const created = posts(label);
  expect(created.length).toBeGreaterThanOrEqual(2);
  expect(created.every((request) => request.idempotencyKey === created[0]?.idempotencyKey)).toBe(true);
  expect(created.every((request) => request.body === created[0]?.body)).toBe(true);

  await page.goto(`${stack.web}/en/catalogue/concept`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  await selectConceptType(page);
  const recoveredLabel = `Recovered concept ${crypto.randomUUID().slice(0, 8)}`;
  await confirmIdentity(page, recoveredLabel);
  await stack.injectCreatedSubjectReadFailureOnce({ status: 503, body: '{"title":"Reader temporarily unavailable"}' });
  await confirmCreate(page);
  const outcome = page.locator('section[role="status"]');
  await outcome.waitFor({ state: 'visible' });
  const recoveredId = (await outcome.locator('code').innerText()).trim();
  expect(recoveredId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(await posts(recoveredLabel)).toHaveLength(1);
  await outcome.getByRole('button', { name: /retry/i }).click();
  await page.waitForURL((url) => url.pathname.includes(`/subjects/${recoveredId}`));
  await stack.syncKernelRequests();
  expect(posts(recoveredLabel)).toHaveLength(1);
});

test('guest, unavailable observation, and revoked grant stay distinct from Concept creation', async () => {
  const guest = await (await auth.context('anonymous')).newPage();
  guest.setDefaultTimeout(30_000);
  await guest.goto(`${stack.web}/en/catalogue/concept`, { waitUntil: 'domcontentloaded' });
  await guest.getByText(/sign in to create a catalogue identity/i).waitFor({ state: 'visible' });
  expect(await guest.getByLabel('Type', { exact: true }).count()).toBeGreaterThan(0);
  expect(await guest.locator('#create-subject-submit').isDisabled()).toBe(true);
  await guest.close();

  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/concept' });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/viewerActions',
    status: 503,
    body: '{"title":"Temporarily unavailable","status":503,"code":"dependency_unavailable"}',
  });
  await page.goto(`${stack.web}/en/catalogue/concept`, { waitUntil: 'domcontentloaded' });
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
  await page.goto(`${stack.web}/en/catalogue/concept`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/does not allow creating a catalogue identity/i).waitFor({ state: 'visible' });
  await selectConceptType(page);
  const refusedLabel = `Refused concept ${crypto.randomUUID().slice(0, 8)}`;
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
});

test('an expired classification handoff still creates and never writes a classification', async () => {
  const token = crypto.randomUUID();
  const journey = await auth.signIn('alice', {
    returnTo: `/en/catalogue/concept?classificationHandoff=${token}`,
  });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await page.getByText(/this classification return is not valid for the current reader/i).waitFor({
    state: 'visible',
  });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  await selectConceptType(page);
  const label = `Handoff concept ${crypto.randomUUID().slice(0, 8)}`;
  await confirmIdentity(page, label);
  await confirmCreate(page);
  await page.waitForURL((url) => url.pathname.includes('/subjects/'));
  const createdId = new URL(page.url()).pathname.match(/^\/en\/subjects\/([^/]+)/)?.[1];
  expect(createdId).toBeTruthy();
  await stack.syncKernelRequests();
  expect(posts(label)).toHaveLength(1);
  expect(candidateWrites()).toHaveLength(0);
});

test('an acknowledged detour resumes by UUID and returns a fresh suggestion without a classification write', async () => {
  const sourceLabel = `Native classification source ${crypto.randomUUID().slice(0, 8)}`;
  const source = await json<{ subject: { id: string } }>(
    await stack.kernel(
      '/v1/subjects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ type: 'wd:Q95074', labels: { en: sourceLabel } }),
      },
      'alice',
    ),
    'create classification source',
  );
  const reader = await stack.authPersona('alice');
  const token = crypto.randomUUID();
  const holder = crypto.randomUUID();
  const returnPath = `${subjectHref({ id: source.subject.id, label: sourceLabel }, 'en').href}/character`;
  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/concept' });
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await page.goto(`${stack.web}/en/catalogue/concept`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ token, holder, sourceId, sourceLabel, reader, returnPath }) => {
      window.sessionStorage.setItem(
        `rezics:classification-create-handoff:${token}`,
        JSON.stringify({
          version: 1,
          token,
          createdAt: Date.now(),
          sourceId,
          sourceLabel,
          sourceType: 'wd:Q95074',
          returnPath,
          reader,
          context: candidateContext,
          releaseDigest: 'native-release',
          propertyId: 'schema:keywords',
          propertyLabel: 'keywords',
          holder,
          originalStatementId: null,
          targets: ['skos:Concept'],
          drafts: [
            {
              holder,
              property: 'schema:keywords',
              source: null,
              included: true,
              statement: {
                property: { id: 'schema:keywords' },
                value: { type: 'value', content: '' },
                qualifiers: [],
                references: [],
                rank: 'normal',
              },
              baseline: null,
            },
          ],
          reviewFingerprint: '',
          phase: 'creating',
        }),
      );
    },
    { token, holder, sourceId: source.subject.id, sourceLabel, reader: reader.accountId, returnPath },
  );
  await page.goto(`${stack.web}/en/catalogue/concept?classificationHandoff=${token}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByText(/you can create a new catalogue identity/i).waitFor({ state: 'visible' });
  await selectConceptType(page);
  const label = `Native resumed concept ${crypto.randomUUID().slice(0, 8)}`;
  await confirmIdentity(page, label);
  await stack.injectCreatedSubjectReadFailureOnce({
    status: 503,
    body: '{"title":"Reader temporarily unavailable"}',
  });
  await confirmCreate(page);
  const result = page.locator('section[role="status"]');
  await result.waitFor({ state: 'visible' });
  const createdId = (await result.locator('code').innerText()).trim();
  expect(createdId).toMatch(/^[0-9a-f-]{36}$/i);
  await stack.syncKernelRequests();
  expect(posts(label)).toHaveLength(1);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText(createdId, { exact: true }).waitFor({ state: 'visible' });
  await stack.syncKernelRequests();
  expect(posts(label)).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByText('Current public reading', { exact: true }).waitFor({ state: 'visible' });
  await page.getByText(label, { exact: true }).waitFor({ state: 'visible' });
  await page.getByText('skos:Concept', { exact: true }).waitFor({ state: 'visible' });
  await page.getByText('schema:Thing', { exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Return to the classification draft', exact: true }).click();
  await page.waitForURL((url) => url.pathname === returnPath);
  await page.getByRole('button', { name: 'Choose this concept', exact: true }).waitFor({ state: 'visible' });
  await stack.syncKernelRequests();
  expect(posts(label)).toHaveLength(1);
  const createdPost = posts(label)[0];
  expect(createdPost && (JSON.parse(createdPost.body!) as { type?: string }).type).toBe('skos:Concept');
  const exactReads = stack
    .kernelRequests()
    .filter((request) => request.method === 'GET' && request.url === `/v1/subjects/${createdId}`);
  expect(exactReads.length).toBeGreaterThanOrEqual(2);
  expect(stack.kernelRequests().some((request) => request.method === 'POST' && request.url === '/v1/viewerActions')).toBe(
    true,
  );
  expect(candidateWrites()).toHaveLength(0);
});
