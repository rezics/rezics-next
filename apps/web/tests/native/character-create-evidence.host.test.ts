import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Locator } from 'playwright';
import { expect as playExpect } from 'playwright/test';
import {
  createNativeCatalogueRelationsFixture,
  hydrate,
  readPublicStatements,
  type NativeCatalogueRelationsFixture,
} from './catalogue-relations-fixture.ts';

setDefaultTimeout(900_000);
let fixture: NativeCatalogueRelationsFixture;

beforeAll(async () => {
  fixture = await createNativeCatalogueRelationsFixture();
}, 300_000);

afterAll(async () => fixture?.close(), 180_000);

function posts(label: string) {
  return fixture.stack.kernelRequests().filter((request) => {
    if (request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body) return false;
    return (JSON.parse(request.body) as { labels?: { en?: string } }).labels?.en === label;
  });
}

async function addPart(group: Locator, property: string, label: RegExp, value: string) {
  await group.getByLabel('Add citation part', { exact: true }).selectOption(property);
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
      labels: Record<string, string>;
      aliases?: Record<string, string[]>;
      statements: Record<
        string,
        {
          rank?: string;
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

test('Character create reviews evidenced multilingual item, retries exact unknown delivery, and associates independently', async () => {
  const token = crypto.randomUUID();
  const label = `Evidenced character ${token}`;
  const heightUrl = 'https://example.org/character-height';
  const characterUrl = 'https://example.org/character-page';
  const pageUrl = 'https://example.org/character-source';
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  const response = await page.goto(`${fixture.stack.web}/en/catalogue/character?work=${fixture.movie.id}`, {
    waitUntil: 'domcontentloaded',
  });
  expect(response?.status()).toBe(200);
  await hydrate(page);
  const form = page.getByRole('form', { name: 'Character details' });
  await form.waitFor({ state: 'visible' });

  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(label);
  await form.getByRole('button', { name: 'Add a language', exact: true }).click();
  await form.getByRole('textbox', { name: 'Data language' }).nth(1).fill('ja');
  await form.getByRole('textbox', { name: 'Name', exact: true }).nth(1).fill('旅人');
  await form.getByRole('textbox', { name: 'Aliases (optional)' }).nth(1).fill('旅の人');

  await form.getByLabel('Optional initial fact').selectOption('schema:height');
  await form.getByRole('button', { name: 'Add fact', exact: true }).click();
  const height = form.locator('[data-slot="character-initial-fact"]').first();
  await height.getByLabel('Amount', { exact: true }).fill('+0');
  await height.getByLabel('Unit', { exact: true }).selectOption('http://www.wikidata.org/entity/Q174728');
  await height.getByLabel('Rank', { exact: true }).selectOption('preferred');
  const heightReferences = height.locator('section[id$="-references"]');
  const heightCitation = heightReferences.getByRole('group', { name: /Citations 1/ });
  await heightCitation
    .locator('div[data-statement-addition]')
    .filter({ hasText: 'URL' })
    .last()
    .getByRole('textbox')
    .fill(heightUrl);
  await addPart(heightCitation, 'wdt:P648', /Open Library ID/i, 'OL27548W');
  await addPart(heightCitation, 'schema:inLanguage', /language/i, 'en');

  await form.getByLabel('Optional initial fact').selectOption('schema:url');
  await form.getByRole('button', { name: 'Add fact', exact: true }).click();
  const urlRow = form.locator('[data-slot="character-initial-fact"]').nth(1);
  await urlRow.locator('[id$="-fact"]').getByRole('textbox', { name: 'URL' }).fill(characterUrl);
  const urlReferences = urlRow.locator('section[id$="-references"]');
  const urlCitation = urlReferences.getByRole('group', { name: /Citations 1/ });
  await urlCitation
    .locator('div[data-statement-addition]')
    .filter({ hasText: 'URL' })
    .last()
    .getByRole('textbox')
    .fill(pageUrl);
  await addPart(urlCitation, 'wdt:P648', /Open Library ID/i, 'OL91234W');
  await addPart(urlCitation, 'schema:inLanguage', /language/i, 'ja');

  await height.getByRole('button', { name: 'Reuse this reference · Citations 1' }).click();
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Copy onto selected drafts', exact: true }).click();

  await form.getByRole('button', { name: 'Review fictional character', exact: true }).click();
  const review = page.getByRole('region', { name: 'Review this character' });
  await playExpect(review).toBeVisible();
  await playExpect(review).toContainText('旅人');
  await playExpect(review).toContainText(heightUrl);
  await playExpect(review).toContainText(pageUrl);

  const errorPointer = '/statements/schema:height/0/value/content/amount';
  await fixture.stack.injectKernelFailureOnce({
    method: 'POST',
    path: '/v1/subjects',
    status: 422,
    body: JSON.stringify({ title: 'Invalid subject', status: 422, errors: [{ pointer: errorPointer }] }),
  });
  await form.getByRole('button', { name: 'Create fictional character', exact: true }).click();
  const repair = page.getByRole('link', { name: /Amount/i }).last();
  await playExpect(repair).toBeVisible();
  const targetId = decodeURIComponent((await repair.getAttribute('href'))!.slice(1));
  await repair.click();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(targetId);
  await page.locator(`[id="${targetId}"]`).fill('+171');

  await form.getByRole('button', { name: 'Review fictional character', exact: true }).click();
  await playExpect(review).toBeVisible();

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
  expect(await form.locator('button[type="submit"]').innerText()).toMatch(/retry/i);

  await fixture.stack.injectKernelFailureOnce({
    method: 'GET',
    path: '/v1/subjects/*',
    status: 503,
    body: '{"title":"Reader temporarily unavailable","status":503}',
  });
  await form.getByRole('button', { name: /retry/i }).click();
  await page.unroute('**/_serverFn/**', dropFirstCreateResponse);
  const created = page.locator('[data-slot="character-created"]');
  await playExpect(created).toBeVisible();
  await playExpect(created).toContainText(/created/i);
  expect(droppedResponse?.status).toBe(200);

  await fixture.stack.syncKernelRequests();
  const characterPosts = posts(label);
  expect(characterPosts.map((request) => request.responseStatus)).toEqual([422, 201, 201]);
  expect(characterPosts[1]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(characterPosts[2]?.idempotencyKey).toBe(characterPosts[1]?.idempotencyKey);
  expect(characterPosts[2]?.body).toBe(characterPosts[1]?.body);
  const body = JSON.parse(characterPosts[1]!.body!) as {
    type: string;
    labels: Record<string, string>;
    aliases?: Record<string, string[]>;
    statements: Record<
      string,
      {
        rank?: string;
        value: { type: string; content: unknown };
        qualifiers: { property: { id: string }; value: { type: string; content: unknown } }[];
        references: { parts: { property: { id: string }; value: { type: string; content: unknown } }[] }[];
      }[]
    >;
  };
  expect(body.type).toBe('wd:Q95074');
  expect(body.labels).toEqual({ en: label, ja: '旅人' });
  expect(body.aliases).toEqual({ ja: ['旅の人'] });
  expect(body.statements['schema:height']?.[0]).toMatchObject({
    rank: 'preferred',
    value: { type: 'value', content: { amount: '+171', unit: 'http://www.wikidata.org/entity/Q174728' } },
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: heightUrl } },
          { property: { id: 'wdt:P648' }, value: { type: 'value', content: 'OL27548W' } },
          { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } },
        ],
      },
    ],
  });
  expect(body.statements['schema:url']?.[0]?.value).toEqual({ type: 'value', content: characterUrl });
  expect(body.statements['schema:url']?.[0]?.references).toEqual([
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value', content: pageUrl } },
        { property: { id: 'wdt:P648' }, value: { type: 'value', content: 'OL91234W' } },
        { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'ja' } },
      ],
    },
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value', content: heightUrl } },
        { property: { id: 'wdt:P648' }, value: { type: 'value', content: 'OL27548W' } },
        { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } },
      ],
    },
  ]);

  const failedRead = fixture.stack
    .kernelRequests()
    .findLast(
      (request) =>
        request.method === 'GET' && request.failure?.status === 503 && request.url.startsWith('/v1/subjects/'),
    );
  expect(failedRead).toBeDefined();
  const characterId = failedRead!.url.slice('/v1/subjects/'.length);
  expect(await created.locator('code').innerText()).toBe(characterId);

  await created.getByRole('button', { name: /retry/i }).click();
  await fixture.stack.syncKernelRequests();
  expect(posts(label)).toHaveLength(3);
  const createdRead = await readCreated(characterId);
  expect(createdRead.type).toBe('wd:Q95074');
  expect(createdRead.labels.ja).toBe('旅人');
  expect(createdRead.statements['schema:height']?.[0]?.rank).toBe('preferred');
  expect(createdRead.statements['schema:height']?.[0]?.value.content).toEqual({
    amount: '+171',
    unit: 'http://www.wikidata.org/entity/Q174728',
  });
  expect(
    createdRead.statements['schema:url']?.[0]?.references.map((group) => group.parts.map((part) => part.property.id)),
  ).toEqual([
    ['schema:url', 'wdt:P648', 'schema:inLanguage'],
    ['schema:url', 'wdt:P648', 'schema:inLanguage'],
  ]);

  const associate = page.locator('[data-slot="character-associate"]');
  await playExpect(associate).toBeVisible();
  await associate.getByRole('button', { name: 'Open relation editor', exact: true }).click();
  await playExpect(associate.getByLabel('Relation', { exact: true })).toHaveValue('schema:character');
  await playExpect(associate.getByRole('combobox', { name: 'Target subject', exact: true })).toHaveValue(characterId);
  await associate.getByLabel('Citation URL', { exact: true }).fill('https://example.org/character-appearance');
  await associate.getByRole('button', { name: 'Add citation', exact: true }).click();
  const confirm = page.getByRole('group', { name: 'Confirm: Propose relation' });
  if (!(await confirm.isVisible())) {
    await associate.getByRole('button', { name: 'Propose relation', exact: true }).click();
    await playExpect(confirm).toBeVisible();
  }
  await confirm.getByRole('button', { name: 'Propose relation', exact: true }).click();
  await playExpect(page.getByRole('status').filter({ hasText: 'Relation proposed.' })).toBeVisible();
  await playExpect(page.getByRole('heading', { name: 'Review this slot', exact: true })).toBeVisible();
  await fixture.stack.syncKernelRequests();
  expect(posts(label)).toHaveLength(3);
  expect(await readPublicStatements(fixture.stack, fixture.movie.id, 'schema:character')).toEqual([]);
  const work = await readCreated(fixture.movie.id);
  expect(work.statements['schema:character'] ?? []).toEqual([]);
  await page.close();
}, 900_000);
