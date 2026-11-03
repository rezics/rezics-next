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
  await page.locator('[data-catalogue-file-create-review]').waitFor({ state: 'visible' });
  await submit.click();
}

function posts(label: string) {
  return stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body) return false;
    return (JSON.parse(request.body) as { labels?: { en?: string } }).labels?.en === label;
  });
}

test('File creation reviews grouped evidence, copies a reference, and retries unknown delivery with the same key', async () => {
  const journey = await auth.signIn('alice', { returnTo: '/en/catalogue/file' });
  expect(journey.url).toBe(`${stack.web}/en/catalogue/file`);
  const page = journey.context.pages().at(-1)!;
  page.setDefaultTimeout(60_000);
  await page.locator('form').waitFor({ state: 'visible' });
  const type = page.getByLabel('Type', { exact: true });
  const options = await type
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value.length > 0));
  expect(options.length).toBeGreaterThan(0);
  await type.selectOption(options[0]!);
  const token = crypto.randomUUID().slice(0, 8);
  const label = `Native evidenced catalogue file ${token}`;
  await page.locator('#create-label-0').fill(label);
  const addFact = page.getByLabel('Add an initial fact', { exact: true });
  if (await addFact.count()) {
    const properties = await addFact
      .locator('option')
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value.length > 0),
      );
    if (properties.includes('schema:sameAs')) {
      await addFact.selectOption('schema:sameAs');
      await page.getByRole('button', { name: 'Add an initial fact', exact: true }).click();
      const row = page.locator('[data-slot="catalogue-file-initial-fact"]').first();
      await row.getByRole('textbox').first().fill(`https://example.org/file/${token}`);
      const refs = row.getByRole('group', { name: /Citations 1/ });
      await refs.getByRole('textbox').first().fill(`https://example.org/file-source/${token}`);
      await addPart(refs, 'schema:inLanguage', /language/i, 'en');
      if (properties.includes('schema:sha256')) {
        await addFact.selectOption('schema:sha256');
        await page.getByRole('button', { name: 'Add an initial fact', exact: true }).click();
        await page.getByText('Catalogue statement, not a verified local match.').waitFor({ state: 'visible' });
        await refs.getByRole('button', { name: /Reuse this reference/ }).click();
        const panel = page.locator('[data-fact-reuse]');
        await panel.waitFor({ state: 'visible' });
        await panel.getByRole('checkbox').first().click();
        await panel.getByRole('button', { name: 'Copy onto selected drafts', exact: true }).click();
        await playExpect(panel.getByText('Copied onto 1 drafts.')).toBeVisible();
      }
    }
  }

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
  await page.waitForURL((url) => url.pathname.includes('/subjects/') && url.pathname.endsWith('/file'));
  await page.unroute('**/_serverFn/**', dropFirstCreateResponse);

  expect(droppedResponse?.status).toBe(200);
  await stack.syncKernelRequests();
  const created = posts(label);
  expect(created.length).toBeGreaterThanOrEqual(2);
  expect(created[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(created[1]?.idempotencyKey).toBe(created[0]?.idempotencyKey);
  expect(created[1]?.body).toBe(created[0]?.body);
  const body = JSON.parse(created[0]!.body!) as { type: string; statements?: Record<string, { rank?: string }[]> };
  expect(options).toContain(body.type);
});
