import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Locator, Page } from 'playwright';
import { expect as playExpect } from 'playwright/test';
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

async function addPart(group: Locator, property: string, label: RegExp, value: string) {
  await group.getByLabel('Add citation part', { exact: true }).selectOption(property);
  await group.getByRole('button', { name: 'Add', exact: true }).click();
  const part = group.locator('div[data-statement-addition]').filter({ hasText: label }).last();
  await part.getByRole('textbox').fill(value);
}

async function confirmCreate(page: Page) {
  const submit = page.getByRole('button', { name: 'Create subject', exact: true });
  await submit.click();
  await page.locator('[data-addon-create-review]').waitFor({ state: 'visible' });
  await playExpect(page.getByText('No base-work statement is included', { exact: false })).toBeVisible();
  await submit.click();
}

function posts(label: string) {
  return stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body) return false;
    return (JSON.parse(request.body) as { labels?: { en?: string } }).labels?.en === label;
  });
}

test('Add-on creation reviews evidenced facts, copies a reference, and retries unknown delivery with the same key', async () => {
  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/addon' });
  expect(journey.url).toBe(`${stack.web}/en/catalogue/addon`);
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await page.locator('form').waitFor({ state: 'visible' });
  const token = crypto.randomUUID().slice(0, 8);
  const label = `Native evidenced add-on ${token}`;
  await page.locator('#create-label-0').fill(label);
  await page.getByLabel('Add fact', { exact: true }).selectOption('schema:url');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await page.getByLabel('Add fact', { exact: true }).selectOption('schema:sameAs');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  const facts = page.locator('[data-slot="addon-initial-facts"]');
  const urlRow = facts.locator('[data-slot="game-initial-fact"]').nth(0);
  const sameRow = facts.locator('[data-slot="game-initial-fact"]').nth(1);
  await urlRow.getByLabel('URL', { exact: true }).first().fill(`https://example.org/addon/${token}`);
  await urlRow.getByRole('button', { name: 'Add citation', exact: true }).click();
  const urlRefs = urlRow.getByRole('group', { name: /Citations 1/ });
  await addPart(urlRefs, 'schema:url', /URL/i, `https://example.org/addon-source/${token}`);
  await sameRow.getByLabel('URL', { exact: true }).first().fill(`https://example.org/also/${token}`);
  await sameRow.getByRole('button', { name: 'Add citation', exact: true }).click();
  await addPart(sameRow.getByRole('group', { name: /Citations 1/ }), 'schema:url', /URL/i, `https://example.org/also-source/${token}`);
  await urlRefs.getByRole('button', { name: /Reuse this reference/ }).click();
  const panel = page.locator('[data-fact-reuse]');
  await panel.waitFor({ state: 'visible' });
  await playExpect(panel.getByText('does not export an editable copy-target holder', { exact: false })).toBeVisible();
  await panel.getByRole('checkbox').first().click();
  await panel.getByRole('button', { name: 'Copy onto selected drafts', exact: true }).click();
  await playExpect(panel.getByText('Copied onto 1 drafts.')).toBeVisible();

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
  const created = posts(label);
  expect(created.length).toBeGreaterThanOrEqual(2);
  expect(created[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(created[1]?.idempotencyKey).toBe(created[0]?.idempotencyKey);
  expect(created[1]?.body).toBe(created[0]?.body);
  const body = JSON.parse(created[0]!.body!) as {
    type: string;
    statements: Record<string, { rank?: string; references: { parts: unknown[] }[] }[]>;
  };
  expect(body.type).toBe('wd:Q209163');
  expect(body.statements['schema:url']?.[0]?.rank ?? 'normal').toBe('normal');
  expect(body.statements['schema:sameAs']?.[0]?.references.length).toBeGreaterThanOrEqual(2);
});
