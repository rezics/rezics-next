import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Locator, Page } from 'playwright';
import { expect as playExpect } from 'playwright/test';
import {
  createNativeCatalogueRelationsFixture,
  type NativeCatalogueRelationsFixture,
} from './catalogue-relations-fixture.ts';

setDefaultTimeout(900_000);
let fixture: NativeCatalogueRelationsFixture;

beforeAll(async () => {
  fixture = await createNativeCatalogueRelationsFixture();
}, 300_000);

afterAll(async () => fixture?.close(), 180_000);

async function open(page: Page, route: string) {
  const response = await page.goto(`${fixture.stack.web}${route}`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.locator('form').waitFor({ state: 'visible' });
}

function posts(label: string) {
  return fixture.stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body) return false;
    return (JSON.parse(request.body) as { labels?: { en?: string } }).labels?.en === label;
  });
}

async function addPart(group: Locator, property: string, label: RegExp, value: string) {
  await group.getByLabel('Add part', { exact: true }).selectOption(property);
  await group.getByRole('button', { name: 'Add', exact: true }).click();
  const part = group.locator('div[data-statement-addition]').filter({ hasText: label }).last();
  await part.getByRole('textbox').fill(value);
}

async function readCreated(id: string) {
  const response = await fixture.stack.kernel(`/v1/subjects/${id}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    subject: {
      id: string;
      type: string;
      statements: Record<
        string,
        {
          value: { type: string; content: unknown };
          qualifiers: { property: { id: string }; value: { type: string; content: unknown } }[];
          references: { parts: { property: { id: string }; value: { type: string; content: unknown } }[] }[];
        }[]
      >;
    };
  };
  expect(body.subject.id).toBe(id);
  return body.subject;
}

test('Literary and Screen creation retain grouped evidence, addressed repair, and exact unknown retry', async () => {
  const token = crypto.randomUUID();
  const literaryLabel = `Structured literary work ${token}`;
  const literaryUrl = 'https://example.org/literary-source';
  const literaryPage = await fixture.alice.context.newPage();
  literaryPage.setDefaultTimeout(60_000);
  await open(literaryPage, '/en/catalogue/literary');
  await literaryPage.locator('#create-label-0').fill(literaryLabel);
  await literaryPage.locator('#create-type').selectOption('schema:Book');
  await literaryPage.getByLabel('Property').selectOption('schema:wordCount');
  await literaryPage.getByRole('button', { name: 'Add', exact: true }).click();
  await literaryPage.getByLabel('Amount', { exact: true }).fill('+0');
  await literaryPage.getByLabel('Unit', { exact: true }).selectOption('1');
  const literaryRow = literaryPage.locator('section[id^="literary-fact-"]').first();
  const literaryReferences = literaryRow.locator('section[id$="-references"]');
  const literaryReference = literaryReferences.getByRole('group', { name: /References 1/ });
  await literaryReference
    .locator('div[data-statement-addition]')
    .filter({ hasText: 'URL' })
    .last()
    .getByRole('textbox')
    .fill(literaryUrl);
  await addPart(literaryReference, 'wdt:P648', /Open Library ID/i, 'OL27548W');
  await addPart(literaryReference, 'schema:inLanguage', /language/i, 'en');
  await literaryPage.locator('form button[type="submit"]').click();
  await literaryPage.waitForURL((url) => /^\/en\/subjects\/[0-9a-f-]+\//i.test(url.pathname));
  const literaryId = new URL(literaryPage.url()).pathname.match(/^\/en\/subjects\/([^/]+)/)?.[1];
  expect(literaryId).toBeTruthy();
  await fixture.stack.syncKernelRequests();
  const literaryPosts = posts(literaryLabel);
  expect(literaryPosts).toHaveLength(1);
  expect(literaryPosts[0]?.responseStatus).toBe(201);
  const literaryBody = JSON.parse(literaryPosts[0]!.body!) as {
    statements: Record<string, { value: { content: unknown }; references: { parts: unknown[] }[] }[]>;
  };
  expect(literaryBody.statements['schema:wordCount']?.[0]?.value.content).toEqual({ amount: '+0', unit: '1' });
  expect(literaryBody.statements['schema:wordCount']?.[0]?.references).toHaveLength(1);
  expect(literaryBody.statements['schema:wordCount']?.[0]?.references[0]?.parts).toEqual([
    { property: { id: 'schema:url' }, value: { type: 'value', content: literaryUrl } },
    { property: { id: 'wdt:P648' }, value: { type: 'value', content: 'OL27548W' } },
    { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } },
  ]);
  const literaryRead = await readCreated(literaryId!);
  expect(literaryRead.type).toBe('schema:Book');
  expect(literaryRead.statements['schema:wordCount']?.[0]?.references[0]?.parts.map((part) => part.property.id)).toEqual([
    'schema:url',
    'wdt:P648',
    'schema:inLanguage',
  ]);

  const screenLabel = `Structured screen work ${token}`;
  const screenPage = await fixture.alice.context.newPage();
  screenPage.setDefaultTimeout(60_000);
  await open(screenPage, '/en/catalogue/screen');
  await screenPage.locator('#create-label-0').fill(screenLabel);
  await screenPage.locator('#create-type').selectOption('schema:Movie');
  await screenPage.getByLabel('Add fact').selectOption('schema:director');
  await screenPage.getByRole('button', { name: 'Add', exact: true }).click();
  const director = screenPage.getByRole('combobox', { name: /director/i });
  await director.fill(fixture.person.label);
  await playExpect(screenPage.getByRole('option', { name: fixture.person.label })).toBeVisible({ timeout: 30_000 });
  await screenPage.getByRole('option', { name: fixture.person.label }).click();
  const screenRow = screenPage
    .locator('section[id^="screen-fact-"]')
    .filter({ has: screenPage.getByRole('combobox', { name: /director/i }) })
    .first();
  const qualifiers = screenRow.locator('section[id$="-qualifiers"]');
  await qualifiers.getByLabel('Add qualifier', { exact: true }).selectOption('schema:position');
  await qualifiers.getByRole('button', { name: 'Add', exact: true }).click();
  await qualifiers.locator('div[data-statement-addition]').filter({ hasText: /position/i }).last().getByRole('textbox').fill('1');
  const screenReferences = screenRow.locator('section[id$="-references"]');
  const firstReference = screenReferences.getByRole('group', { name: /References 1/ });
  const firstUrl = 'https://example.org/removed-source';
  await firstReference
    .locator('div[data-statement-addition]')
    .filter({ hasText: 'URL' })
    .last()
    .getByRole('textbox')
    .fill(firstUrl);
  await screenReferences.getByRole('button', { name: /Add reference/i }).click();
  await screenReferences.getByRole('button', { name: /Add reference/i }).click();
  const secondReference = screenReferences.getByRole('group', { name: /References 3/ });
  const secondUrl = 'https://example.org/screen-source';
  await addPart(secondReference, 'schema:url', /^URL$/i, secondUrl);
  await addPart(secondReference, 'wdt:P648', /Open Library ID/i, 'OL27548W');
  await addPart(secondReference, 'schema:inLanguage', /language/i, 'en');

  const errorPointer = '/statements/schema:director/0/references/2/parts/1/value/content';
  await fixture.stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/subjects',
    status: 422,
    body: JSON.stringify({ title: 'Invalid subject', status: 422, errors: [{ pointer: errorPointer }] }),
  });
  await screenPage.locator('form button[type="submit"]').click();
  const repair = screenPage.getByRole('link', { name: /Open Library ID/i }).last();
  await playExpect(repair).toBeVisible();
  const targetId = decodeURIComponent((await repair.getAttribute('href'))!.slice(1));
  await firstReference.getByRole('button', { name: 'Remove reference', exact: true }).click();
  const confirm = screenPage.getByRole('group', { name: /remove reference/i }).last();
  await confirm.getByRole('button', { name: /confirm/i }).click();
  await repair.click();
  expect(await screenPage.evaluate(() => document.activeElement?.id)).toBe(targetId);
  await screenPage.locator(`[id="${targetId}"]`).fill('OL91234W');

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
  await screenPage.route('**/_serverFn/**', dropFirstCreateResponse);
  const submit = screenPage.locator('form button[type="submit"]');
  await submit.click();
  await screenPage.getByRole('alert').waitFor({ state: 'visible' });
  expect(await submit.innerText()).toMatch(/retry/i);
  await submit.click();
  await screenPage.waitForURL((url) => /^\/en\/subjects\/[0-9a-f-]+\//i.test(url.pathname));
  await screenPage.unroute('**/_serverFn/**', dropFirstCreateResponse);

  expect(droppedResponse?.status).toBe(200);
  await fixture.stack.syncKernelRequests();
  const screenPosts = posts(screenLabel);
  expect(screenPosts).toHaveLength(3);
  expect(screenPosts[0]?.responseStatus).toBe(422);
  expect(screenPosts[1]?.responseStatus).toBe(201);
  expect(screenPosts[1]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(screenPosts[2]?.idempotencyKey).toBe(screenPosts[1]?.idempotencyKey);
  expect(screenPosts[2]?.body).toBe(screenPosts[1]?.body);
  const screenBody = JSON.parse(screenPosts[1]!.body!) as {
    statements: Record<
      string,
      {
        value: { content: string };
        qualifiers: { property: { id: string }; value: { content: string } }[];
        references: { parts: { property: { id: string }; value: { content: unknown } }[] }[];
      }[]
    >;
  };
  expect(screenBody.statements['schema:director']?.[0]?.value.content).toBe(fixture.person.id);
  expect(screenBody.statements['schema:director']?.[0]?.qualifiers).toEqual([
    { property: { id: 'schema:position' }, value: { type: 'value', content: '1' } },
  ]);
  expect(screenBody.statements['schema:director']?.[0]?.references).toEqual([
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value', content: secondUrl } },
        { property: { id: 'wdt:P648' }, value: { type: 'value', content: 'OL91234W' } },
        { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } },
      ],
    },
  ]);
  const screenId = new URL(screenPage.url()).pathname.match(/^\/en\/subjects\/([^/]+)/)?.[1];
  expect(screenId).toBeTruthy();
  const screenRead = await readCreated(screenId!);
  expect(screenRead.type).toBe('schema:Movie');
  expect(screenRead.statements['schema:director']?.[0]?.value.content).toBe(fixture.person.id);
  expect(screenRead.statements['schema:director']?.[0]?.qualifiers[0]?.value.content).toBe('1');
  expect(screenRead.statements['schema:director']?.[0]?.references[0]?.parts.map((part) => part.property.id)).toEqual([
    'schema:url',
    'wdt:P648',
    'schema:inLanguage',
  ]);
}, 900_000);
