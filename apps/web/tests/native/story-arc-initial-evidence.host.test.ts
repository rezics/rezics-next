import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Locator } from 'playwright';
import { expect as playExpect } from 'playwright/test';
import { hydrate, readPublicStatements } from './catalogue-relations-fixture.ts';
import { startCatalogueStoryArcFixture, type NativeStoryArcFixture } from './catalogue-story-arc-fixture.ts';
import type { NativeKernelRequest } from './stack.ts';

setDefaultTimeout(900_000);

const storyArcType = 'wd:Q2620972';
const storyArcProperty = 'rezics:storyArc';
let fixture: NativeStoryArcFixture;

beforeAll(async () => {
  fixture = await startCatalogueStoryArcFixture();
}, 300_000);

afterAll(async () => fixture?.close(), 180_000);

async function addCitationPart(group: Locator, property: string, label: RegExp, value: string) {
  await group.getByLabel('Add citation part', { exact: true }).selectOption(property);
  await group.getByRole('button', { name: 'Add', exact: true }).click();
  const part = group.locator('div[data-statement-addition]').filter({ hasText: label }).last();
  await part.getByRole('textbox').fill(value);
}

function createPosts(label: string): NativeKernelRequest[] {
  return fixture.stack.kernelRequests().filter((request) => {
    if (request.fixtureRequest || request.method !== 'POST' || request.url !== '/v1/subjects' || !request.body)
      return false;
    return (JSON.parse(request.body) as { labels?: Record<string, string> }).labels?.en === label;
  });
}

test('creates cited StoryArc evidence, repairs a native nested diagnostic, and resolves unknown delivery exactly', async () => {
  const token = crypto.randomUUID().slice(0, 8);
  const label = `Native evidenced story arc ${token}`;
  const alternate = `旅の編 ${token}`;
  const statementUrl = 'https://';
  const correctedUrl = `https://example.org/story-arc/${token}`;
  const externalUrl = `https://example.net/story-arc/${token}`;
  const citation = `https://source.example/story-arc/${token}`;
  const page = await fixture.alice.context.newPage();
  page.setDefaultTimeout(60_000);
  const opened = await page.goto(`${fixture.stack.web}/en/catalogue/story-arc?work=${fixture.parent.id}`, {
    waitUntil: 'domcontentloaded',
  });
  expect(opened?.status()).toBe(200);
  await hydrate(page);
  const form = page.locator('form').filter({ has: page.getByLabel('Initial fact property', { exact: true }) });
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(label);
  await page.getByRole('button', { name: 'Add a language', exact: true }).click();
  await page.getByRole('textbox', { name: 'Data language' }).nth(1).fill('ja');
  await page.getByRole('textbox', { name: 'Name', exact: true }).nth(1).fill(alternate);
  await page.getByRole('textbox', { name: 'Aliases (optional)' }).nth(1).fill(`別名 ${token}`);

  await page.getByLabel('Initial fact property', { exact: true }).selectOption('schema:url');
  await page.getByRole('button', { name: 'Add URL', exact: true }).click();
  const urlRow = form.locator('fieldset[id^="story-arc-initial-fact-"]').filter({ hasText: 'URL' }).first();
  await urlRow.locator('[id$="-fact"]').getByRole('textbox', { name: 'URL', exact: true }).fill(statementUrl);
  const urlCitation = urlRow.locator('section[id$="-references"]').getByRole('group', { name: /Citations 1/ });
  await urlCitation.getByLabel('URL', { exact: true }).fill(citation);
  await addCitationPart(urlCitation, 'wdt:P648', /Open Library ID/i, `OL${token}W`);
  await addCitationPart(urlCitation, 'schema:inLanguage', /language/i, 'en');

  await page.getByLabel('Initial fact property', { exact: true }).selectOption('schema:sameAs');
  await page.getByRole('button', { name: /Add same as/i }).click();
  const sameAsRow = form
    .locator('fieldset[id^="story-arc-initial-fact-"]')
    .filter({ hasText: /same as/i })
    .first();
  await sameAsRow.locator('[id$="-fact"]').getByRole('textbox', { name: 'URL', exact: true }).fill(externalUrl);
  await urlRow.getByRole('button', { name: /Reuse this reference/ }).click();
  const reuse = page.locator('[data-fact-reuse]');
  await reuse.getByRole('checkbox').check();
  await reuse.getByRole('button', { name: 'Copy onto selected drafts', exact: true }).click();

  const submit = page.getByRole('button', { name: 'Create subject', exact: true });
  await submit.click();
  const review = page.getByRole('region', { name: 'Review this story arc' });
  await playExpect(review).toBeVisible();
  await playExpect(review).toContainText(alternate);
  await playExpect(review).toContainText(citation);
  await playExpect(review).toContainText(`OL${token}W`);
  await submit.click();

  const repair = page.getByRole('link', { name: /Value/ }).last();
  await playExpect(repair).toBeVisible();
  const targetId = decodeURIComponent((await repair.getAttribute('href'))!.slice(1));
  await repair.click();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(targetId);
  await page.locator(`[id="${targetId}"]`).fill(correctedUrl);

  await submit.click();
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
  await submit.click();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await playExpect(page.getByRole('status').filter({ hasText: 'Subject created.' })).toBeVisible();
  await page.unroute('**/_serverFn/**', dropFirstCreateResponse);

  expect(droppedResponse?.status).toBe(200);
  await fixture.stack.syncKernelRequests();
  const posts = createPosts(label);
  expect(posts).toHaveLength(3);
  expect(posts[0]?.responseStatus).toBe(422);
  expect(posts[1]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(posts[2]?.idempotencyKey).toBe(posts[1]?.idempotencyKey);
  expect(posts[2]?.body).toBe(posts[1]?.body);
  const item = JSON.parse(posts[1]!.body!) as {
    type: string;
    labels: Record<string, string>;
    aliases: Record<string, string[]>;
    statements: Record<
      string,
      {
        rank?: string;
        value: { type: string; content: unknown };
        qualifiers: unknown[];
        references: { parts: { property: { id: string }; value: { type: string; content: unknown } }[] }[];
      }[]
    >;
  };
  expect(item.type).toBe(storyArcType);
  expect(item.labels).toMatchObject({ en: label, ja: alternate });
  expect(item.aliases.ja).toEqual([`別名 ${token}`]);
  expect(item.statements['schema:url']?.[0]).toMatchObject({
    rank: 'normal',
    value: { type: 'value', content: correctedUrl },
    qualifiers: [],
    references: [
      {
        parts: [
          { property: { id: 'schema:url' }, value: { type: 'value', content: citation } },
          { property: { id: 'wdt:P648' }, value: { type: 'value', content: `OL${token}W` } },
          { property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'en' } },
        ],
      },
    ],
  });
  expect(item.statements['schema:sameAs']?.[0]?.references).toEqual(item.statements['schema:url']?.[0]?.references);

  const continuation = page.getByRole('link', { name: 'Connect and correct this arc', exact: true });
  const href = await continuation.getAttribute('href');
  expect(href).toContain(`/story-arc?work=${fixture.parent.id}`);
  const createdId = href!.match(/\/subjects\/([^/]+)/)?.[1];
  expect(createdId).toBeTruthy();
  expect(await readPublicStatements(fixture.stack, fixture.parent.id, storyArcProperty)).toEqual([]);
  const nativeRead = await fixture.stack.kernel(`/v1/subjects/${createdId}`);
  expect(nativeRead.status).toBe(200);
  expect(await readPublicStatements(fixture.stack, createdId!, 'schema:url')).toHaveLength(1);
  expect(await readPublicStatements(fixture.stack, createdId!, 'schema:sameAs')).toHaveLength(1);

  await continuation.click();
  await page.waitForURL((url) => url.pathname.includes(`/subjects/${createdId}/`));
  await hydrate(page);
  expect(await readPublicStatements(fixture.stack, fixture.parent.id, storyArcProperty)).toEqual([]);
  await page.close();
});
