import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { BrowserContext, Page } from 'playwright';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
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

type DirectoryPage = {
  contexts: {
    id: string;
    kind: string;
    labels: Record<string, string>;
    state: string;
    deletedAt: string | null;
    purgeAfter: string | null;
  }[];
  next: string | null;
};

async function kernelJson<T>(
  path: string,
  init: RequestInit = {},
  persona = 'alice',
): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET' && !headers.has('idempotency-key'))
    headers.set('idempotency-key', JSON.stringify(crypto.randomUUID()));
  const response = await stack.kernel(path, { ...init, headers }, persona);
  const text = await response.text();
  let body: T;
  try {
    body = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${text}`);
  }
  return { status: response.status, body };
}

async function waitForDirectory(label: string, deleted = false): Promise<DirectoryPage['contexts'][number]> {
  const deadline = Date.now() + 60_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const listed = await kernelJson<DirectoryPage>(
      `/v1/contexts?query=${encodeURIComponent(label)}&limit=20&deleted=${deleted}`,
    );
    last = { status: listed.status, body: listed.body };
    const found =
      listed.status === 200
        ? listed.body.contexts.find((entry) => Object.values(entry.labels).includes(label))
        : undefined;
    if (found) return found;
    await Bun.sleep(500);
  }
  throw new Error(`Native directory never listed ${label}: ${JSON.stringify(last)}`);
}

async function visit(path: string): Promise<Page> {
  const page = await alice.newPage();
  page.setDefaultTimeout(30_000);
  const response = await page.goto(new URL(path, stack.web).href, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  expect(response?.status()).toBe(200);
  return page;
}

async function waitForBff(page: Page): Promise<void> {
  await page.locator('[aria-busy="true"]').waitFor({ state: 'detached' }).catch(() => {});
  await stack.refreshKernelRequests();
}

function bffRequests(since: number): NativeKernelRequest[] {
  return stack.kernelRequests().slice(since).filter((request) => !request.fixtureRequest);
}

function isServerFn(url: string): boolean {
  const path = new URL(url).pathname;
  return path === '/_serverFn' || path.startsWith('/_serverFn/');
}

test('signed-in Alice discovers a named Context, creates one, then deletes and restores through the workspace BFF', async () => {
  const discovered = `Native directory ${crypto.randomUUID()}`;
  const created = await kernelJson<{ context: { id: string; kind: string } }>('/v1/contexts', {
    method: 'POST',
    body: JSON.stringify({ labels: { en: discovered } }),
  });
  expect(created.status).toBe(201);
  expect(created.body.context.kind).toBe('community');
  const discoveredId = created.body.context.id;
  await waitForDirectory(discovered);

  const directoryStart = stack.kernelRequests().length;
  const directory = await visit(`/en/my/contexts?query=${encodeURIComponent(discovered)}`);
  await expect(directory.getByRole('heading', { name: 'Editorial Contexts' })).toBeVisible();
  await expect(directory.getByRole('link', { name: discovered })).toBeVisible();
  await waitForBff(directory);
  const directoryReads = bffRequests(directoryStart).filter(
    (request) => request.method === 'GET' && new URL(request.url, stack.kernelOrigin).pathname === '/v1/contexts',
  );
  expect(directoryReads.length).toBeGreaterThan(0);
  const listed = new URL(directoryReads[0]!.url, stack.kernelOrigin).searchParams;
  expect(listed.get('limit')).toBe('20');
  expect(listed.get('query')).toBe(discovered);
  expect(listed.get('deleted')).not.toBe('true');

  await directory.getByRole('searchbox', { name: 'Search Contexts' }).fill('no-such-native-context');
  await directory.getByRole('button', { name: 'Search' }).click();
  await directory.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await expect(directory.getByText('No matching Contexts')).toBeVisible();

  await directory.getByRole('link', { name: 'Create a Context' }).click();
  await directory.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await directory.getByLabel('Name language').selectOption('ja');
  const createdLabel = `読者の編集 ${crypto.randomUUID().slice(0, 8)}`;
  await directory.getByLabel('Context name').fill(createdLabel);
  const createStart = stack.kernelRequests().length;
  const createBff = directory.waitForResponse(
    (response) => response.request().method() === 'POST' && isServerFn(response.url()),
  );
  await directory.getByRole('button', { name: 'Create a Context' }).click();
  expect((await createBff).status()).toBe(200);
  await expect(directory.getByText('The request was confirmed')).toBeVisible();
  await waitForBff(directory);
  const createWrites = bffRequests(createStart).filter(
    (request) => request.method === 'POST' && new URL(request.url, stack.kernelOrigin).pathname === '/v1/contexts',
  );
  expect(createWrites).toHaveLength(1);
  const open = directory.getByRole('link', { name: 'Open Context' });
  await expect(open).toBeVisible();
  const workspaceHref = await open.getAttribute('href');
  expect(workspaceHref).toMatch(/\/en\/my\/contexts\/[0-9a-f-]{36}$/i);
  const createdId = workspaceHref!.split('/').at(-1)!;

  await open.click();
  await directory.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  await expect(directory.getByRole('heading', { name: createdLabel })).toBeVisible();
  await expect(directory.getByText('Community Context')).toBeVisible();
  await expect(directory.getByRole('button', { name: 'Delete Context' })).toBeEnabled();

  const deleteStart = stack.kernelRequests().length;
  await directory.getByRole('button', { name: 'Delete Context' }).click();
  const deleteBff = directory.waitForResponse(
    (response) => response.request().method() === 'POST' && isServerFn(response.url()),
  );
  await directory.getByRole('dialog').getByRole('button', { name: 'Delete Context' }).click();
  expect((await deleteBff).status()).toBe(200);
  await expect(directory.getByText('The request was confirmed')).toBeVisible();
  await expect(directory.getByText('This deleted Context is unavailable as an editorial source')).toBeVisible();
  await expect(directory.getByText('Purge scheduled after')).toBeVisible();
  await expect(directory.getByRole('button', { name: 'Restore Context' })).toBeEnabled();
  await waitForBff(directory);
  const deletedWrites = bffRequests(deleteStart).filter(
    (request) =>
      request.method === 'DELETE' &&
      new URL(request.url, stack.kernelOrigin).pathname === `/v1/contexts/${createdId}`,
  );
  expect(deletedWrites).toHaveLength(1);
  const rereads = bffRequests(deleteStart).filter((request) => {
    const url = new URL(request.url, stack.kernelOrigin);
    return (
      request.method === 'GET' &&
      (url.pathname === `/v1/contexts/${createdId}` || url.pathname === `/v1/contexts/${createdId}/lifecycle`)
    );
  });
  expect(rereads.some((request) => new URL(request.url, stack.kernelOrigin).pathname.endsWith('/lifecycle'))).toBe(
    true,
  );

  const deletedEntry = await waitForDirectory(createdLabel, true);
  expect(deletedEntry.state).toBe('deleted');
  expect(deletedEntry.purgeAfter).toBeTruthy();
  const deletedPage = await visit(`/en/my/contexts?query=${encodeURIComponent(createdLabel)}&deleted=true`);
  await expect(deletedPage.getByRole('link', { name: createdLabel })).toBeVisible();
  await deletedPage.close();
  const activePage = await visit(`/en/my/contexts?query=${encodeURIComponent(createdLabel)}`);
  await expect(activePage.getByText('No matching Contexts')).toBeVisible();
  await activePage.close();

  const restoreStart = stack.kernelRequests().length;
  const restoreBff = directory.waitForResponse(
    (response) => response.request().method() === 'POST' && isServerFn(response.url()),
  );
  await directory.getByRole('button', { name: 'Restore Context' }).click();
  await directory.getByRole('dialog').getByRole('button', { name: 'Restore Context' }).click();
  expect((await restoreBff).status()).toBe(200);
  await expect(directory.getByRole('button', { name: 'Delete Context' })).toBeEnabled();
  await waitForBff(directory);
  expect(
    bffRequests(restoreStart).some(
      (request) =>
        request.method === 'POST' &&
        new URL(request.url, stack.kernelOrigin).pathname === `/v1/contexts/${createdId}:restore`,
    ),
  ).toBe(true);

  const global = await visit(`/en/my/contexts/${PAGE_GLOBAL_CONTEXT}`);
  await expect(global.getByText('Global is shared editorial authority')).toBeVisible();
  await expect(global.getByRole('button', { name: 'Delete Context' })).toHaveCount(0);
  await expect(global.getByRole('button', { name: 'Restore Context' })).toHaveCount(0);
  await global.close();

  await stack.injectKernelFailureOnce({
    method: 'GET',
    path: `/v1/contexts/${createdId}`,
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
  await directory.getByRole('button', { name: 'Delete Context' }).click();
  const failedReadBff = directory.waitForResponse(
    (response) => response.request().method() === 'POST' && isServerFn(response.url()),
  );
  await directory.getByRole('dialog').getByRole('button', { name: 'Delete Context' }).click();
  expect((await failedReadBff).status()).toBe(200);
  await expect(directory.getByText('The request was confirmed')).toBeVisible();
  await expect(directory.getByText('Current Context information is unavailable')).toBeVisible();

  const discoveredPage = await visit(`/en/my/contexts/${discoveredId}`);
  await expect(discoveredPage.getByRole('heading', { name: discovered })).toBeVisible();
  await discoveredPage.close();
  await directory.close();
});
