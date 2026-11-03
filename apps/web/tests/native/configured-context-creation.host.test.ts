import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { BrowserContext, Page } from 'playwright';
import { releaseDigest, type Release } from '@rezics/definitions';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import { subjectHref } from '../../src/subject/subject-href.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import { startNativeWebStack, type NativeKernelRequest, type NativeWebStack } from './stack.ts';

setDefaultTimeout(600_000);

let stack: NativeWebStack;
let auth: NativeAuthStack;
let alice: BrowserContext;

beforeAll(async () => {
  stack = await startNativeWebStack();
  auth = await startAuthStack(stack);
  const journey = await auth.signIn('alice');
  alice = journey.context;
  if ((await journey.response()).status() !== 200)
    throw new Error('Native Alice must sign in through the served Auth forms');
}, 600_000);

afterAll(async () => {
  try {
    await auth?.stop();
  } finally {
    await stack?.stop();
  }
}, 180_000);

type ContextBody = {
  context: {
    id: string;
    kind: string;
    labels: Record<string, string>;
    settings: { id: string; release: string } | null;
    defaults: Record<string, 'inherit' | 'suppress'>;
  };
};

async function json<T>(response: Response, action: string, status?: number): Promise<T> {
  const text = await response.text();
  if (status !== undefined ? response.status !== status : !response.ok)
    throw new Error(`${action} returned ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function headers(): HeadersInit {
  return { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) };
}

async function grant(accountId: string, actions: string[], persona = 'governor') {
  const response = await stack.kernel(
    '/v1/grants',
    {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        resource: { route: 0, id: GLOBAL_CONTEXT },
        subject: { kind: 'account', id: accountId },
        actions,
        valid: '(,)',
      }),
    },
    persona,
  );
  if (response.status !== 201 && response.status !== 409)
    throw new Error(`grant ${actions.join(',')}: HTTP ${response.status} ${await response.text()}`);
}

async function activateSettings(
  inherit: Record<string, 'inherit' | 'suppress'>,
  suppress: Record<string, 'inherit' | 'suppress'>,
): Promise<string> {
  const steward = await stack.authPersona('steward');
  await grant(steward.accountId, ['gate:definition_publication', 'definitions:publish', 'definitions:activate']);
  const active = await json<{ digest: string; head: number }>(
    await stack.kernel('/v1/definitions/active'),
    'active definitions',
    200,
  );
  const loaded = await json<{ digest: string; release: Release }>(
    await stack.kernel(`/v1/definitions/releases/${encodeURIComponent(active.digest)}`),
    'read active release',
    200,
  );
  const release = structuredClone(loaded.release);
  release.contexts = {
    ...(release.contexts ?? {}),
    'inherit-readers': { labels: { en: 'Inherit published policy' }, defaults: inherit },
    'suppress-readers': { labels: { en: 'Suppress published policy' }, defaults: suppress },
  };
  const digest = releaseDigest(release);
  const published = await json<{ digest: string }>(
    await stack.kernel(
      '/v1/definitions/releases',
      { method: 'POST', headers: headers(), body: JSON.stringify({ release }) },
      'steward',
    ),
    'publish settings',
  );
  expect(published.digest).toBe(digest);
  const activated = await json<{ digest: string }>(
    await stack.kernel(
      `/v1/definitions/releases/${encodeURIComponent(digest)}:activate`,
      { method: 'POST', headers: headers(), body: JSON.stringify({ expected_head: active.head }) },
      'steward',
    ),
    'activate settings',
    200,
  );
  expect(activated.digest).toBe(digest);
  return digest;
}

async function visit(path: string): Promise<Page> {
  const page = await alice.newPage();
  page.setDefaultTimeout(30_000);
  const response = await page.goto(new URL(path, stack.web).href, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(response?.status()).toBe(200);
  return page;
}

function isServerFn(url: string): boolean {
  const path = new URL(url).pathname;
  return path === '/_serverFn' || path.startsWith('/_serverFn/');
}

function bffRequests(since: number): NativeKernelRequest[] {
  return stack
    .kernelRequests()
    .slice(since)
    .filter((request) => !request.fixtureRequest);
}

test('both Web creation callers capture a reviewed released policy and keep native inheritance after later activation', async () => {
  const first = await activateSettings({ 'schema:url': 'inherit' }, { 'schema:url': 'suppress' });
  const personalLabel = `Configured personal ${crypto.randomUUID().slice(0, 8)}`;
  const personal = await visit('/en/my/contexts/new');
  await personal.getByLabel('Context name').fill(personalLabel);
  await personal.getByRole('button', { name: 'Add a language' }).click();
  await personal.locator('[data-context-label-row]').nth(1).locator('select').selectOption('ja');
  await personal.locator('[data-context-label-row]').nth(1).locator('input').fill('設定済み');
  await personal.getByText('Suppress published policy', { exact: true }).click();
  await expect(personal.getByText('Review this Context')).toBeVisible();
  const personalStart = stack.kernelRequests().length;
  const personalBff = personal.waitForResponse(
    (response) => response.request().method() === 'POST' && isServerFn(response.url()),
  );
  await personal.getByRole('button', { name: 'Create a Context' }).click();
  expect((await personalBff).status()).toBe(200);
  await expect(personal.getByText('The request was confirmed')).toBeVisible();
  await expect(personal.getByText('suppress-readers')).toBeVisible();
  const personalWrites = bffRequests(personalStart).filter(
    (request) => request.method === 'POST' && new URL(request.url, stack.kernelOrigin).pathname === '/v1/contexts',
  );
  expect(personalWrites).toHaveLength(1);
  expect(JSON.parse(personalWrites[0]!.body ?? '{}')).toEqual({
    labels: { en: personalLabel, ja: '設定済み' },
    settings: 'suppress-readers',
  });
  const open = personal.getByRole('link', { name: 'Open Context' });
  const personalHref = await open.getAttribute('href');
  const personalId = personalHref!.split('/').at(-1)!;
  const personalRead = await json<ContextBody>(
    await stack.kernel(`/v1/contexts/${personalId}`),
    'read personal context',
    200,
  );
  expect(personalRead.context).toMatchObject({
    settings: { id: 'suppress-readers', release: first },
    defaults: { 'schema:url': 'suppress' },
  });
  await personal.close();

  const editorialLabel = `Configured catalogue ${crypto.randomUUID().slice(0, 8)}`;
  const book = await json<{ subject: { id: string } }>(
    await stack.kernel(
      '/v1/subjects',
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          type: 'schema:Book',
          labels: { en: `Configured book ${crypto.randomUUID().slice(0, 8)}` },
          statements: {
            'schema:url': [
              {
                property: { id: 'schema:url' },
                value: { type: 'value', content: 'https://example.org/configured-context' },
                references: [
                  {
                    parts: [
                      { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/source' } },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      },
      'editor',
    ),
    'create book',
    201,
  );
  const slug = subjectHref({ id: book.subject.id, label: 'Configured book' }, 'en').href.split('/').at(-1)!;
  const editorial = await visit(`/en/contexts/new?${new URLSearchParams({ subject: book.subject.id, slug })}`);
  await editorial.locator('[data-editorial-form] input[id$="-text"]').fill(editorialLabel);
  await editorial.getByText('Inherit published policy', { exact: true }).click();
  const editorialStart = stack.kernelRequests().length;
  const editorialBff = editorial.waitForResponse(
    (response) => response.request().method() === 'POST' && isServerFn(response.url()),
  );
  await editorial.getByRole('button', { name: 'Create Context' }).click();
  expect((await editorialBff).status()).toBe(200);
  await expect(editorial.getByText('Context created')).toBeVisible();
  const editorialWrites = bffRequests(editorialStart).filter(
    (request) => request.method === 'POST' && new URL(request.url, stack.kernelOrigin).pathname === '/v1/contexts',
  );
  expect(editorialWrites).toHaveLength(1);
  expect(JSON.parse(editorialWrites[0]!.body ?? '{}')).toMatchObject({
    labels: { en: editorialLabel },
    settings: 'inherit-readers',
  });
  const review = editorial.getByRole('link', { name: 'Review this subject' });
  await expect(review).toBeVisible();
  const editorialId = new URL(await review.getAttribute('href')!, stack.web).searchParams.get('context')!;
  const editorialRead = await json<ContextBody>(
    await stack.kernel(`/v1/contexts/${editorialId}`),
    'read editorial context',
    200,
  );
  expect(editorialRead.context.settings).toEqual({ id: 'inherit-readers', release: first });

  const global = await json<{ subject: { statements: Record<string, unknown[]>; resolution: Record<string, string> } }>(
    await stack.kernel(`/v1/subjects/${book.subject.id}`),
    'global subject',
    200,
  );
  expect(global.subject.statements['schema:url']).toHaveLength(1);
  const suppressed = await json<{
    subject: { statements: Record<string, unknown[]>; resolution: Record<string, string> };
  }>(await stack.kernel(`/v1/subjects/${book.subject.id}?context=${personalId}`), 'suppressed subject', 200);
  expect(suppressed.subject.statements['schema:url'] ?? []).toHaveLength(0);
  expect(suppressed.subject.resolution['schema:url']).toBe('suppressed');
  await review.click();
  await editorial.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await expect(editorial.getByRole('heading', { name: 'Review Context', exact: true })).toBeVisible();
  await editorial.close();

  const later = await activateSettings({ 'schema:url': 'suppress' }, { 'schema:url': 'inherit' });
  expect(later).not.toBe(first);
  const persisted = await json<ContextBody>(
    await stack.kernel(`/v1/contexts/${personalId}`),
    'persisted capture',
    200,
  );
  expect(persisted.context.settings).toEqual({ id: 'suppress-readers', release: first });
  expect(persisted.context.defaults).toEqual({ 'schema:url': 'suppress' });

  const racedLabel = `Configured race ${crypto.randomUUID().slice(0, 8)}`;
  const raced = await visit('/en/my/contexts/new');
  await raced.getByLabel('Context name').fill(racedLabel);
  await raced.getByText('Inherit published policy', { exact: true }).click();
  await stack.injectKernelFailureOnce({
    method: 'GET',
    path: '/v1/definitions/active',
    status: 503,
    body: JSON.stringify({
      type: 'https://rezics.com/problems/overloaded',
      title: 'Overloaded',
      status: 503,
      code: 'overloaded',
      request_id: crypto.randomUUID(),
      retryable: true,
      effect_status: 'not_applicable',
    }),
  });
  const racedBff = raced.waitForResponse(
    (response) => response.request().method() === 'POST' && isServerFn(response.url()),
  );
  await raced.getByRole('button', { name: 'Create a Context' }).click();
  expect((await racedBff).status()).toBe(200);
  await expect(raced.getByText('The request was confirmed')).toBeVisible();
  const racedHref = await raced.getByRole('link', { name: 'Open Context' }).getAttribute('href');
  const racedId = racedHref!.split('/').at(-1)!;
  const racedRead = await json<ContextBody>(await stack.kernel(`/v1/contexts/${racedId}`), 'raced context', 200);
  expect(racedRead.context.settings?.id).toBe('inherit-readers');
  expect(racedRead.context.settings?.release).toBe(later);
  if (racedRead.context.settings?.release !== first)
    await expect(raced.getByText('The returned Context captured a different policy')).toBeVisible();
  await raced.close();
});
