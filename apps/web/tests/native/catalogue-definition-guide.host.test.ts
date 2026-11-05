import { afterAll, expect } from 'bun:test';
import type { Page } from 'playwright';
import { expect as ui } from 'playwright/test';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';
import {
  startCatalogueDefinitionGuideFixture,
  type CatalogueDefinitionGuideFixture,
} from './catalogue-definition-guide-fixture.ts';
import type { NativeKernelRequest } from './stack.ts';

const lifecycle = new NativeTestLifecycle('native catalogue definition guide suite');
let fixture: CatalogueDefinitionGuideFixture;

nativeBeforeAll(lifecycle, 360_000, async () => {
  fixture = await startCatalogueDefinitionGuideFixture();
});
afterAll(async () => {
  await fixture?.close();
}, 180_000);
nativeAfterAll(lifecycle, 180_000);

const typeHelp = 'About this Type · Opens in a new tab; your draft stays here.';
const fieldHelp = 'Field guide · Opens in a new tab; your draft stays here.';

function userReads(from: number): NativeKernelRequest[] {
  return fixture.stack
    .kernelRequests()
    .slice(from)
    .filter((request) => !request.fixtureRequest);
}

function definitionPath(request: NativeKernelRequest): string {
  return decodeURIComponent(request.url.split('?')[0]!);
}

function definitionReads(from: number): NativeKernelRequest[] {
  return userReads(from).filter((request) => {
    const path = definitionPath(request);
    return (
      request.method === 'GET' &&
      (path === '/v1/definitions/active' ||
        path.startsWith('/v1/definitions/releases/') ||
        path.startsWith('/v1/definitionTypes'))
    );
  });
}

function writes(from: number): NativeKernelRequest[] {
  return userReads(from).filter((request) => request.method !== 'GET' && request.method !== 'HEAD');
}

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function openHelp(page: Page, name: string): Promise<Page> {
  const popup = page.context().waitForEvent('page');
  await page.getByRole('link', { name, exact: true }).click();
  const guide = await popup;
  await guide.waitForLoadState('domcontentloaded');
  await hydrate(guide);
  return guide;
}

async function chooseBook(page: Page): Promise<void> {
  await page.locator('#create-type-search-mode').selectOption('id');
  const query = page.locator('#create-type-query');
  await query.fill('schema:Book');
  await query.press('Enter');
  const select = page.getByRole('button', { name: /^Select / });
  await select.waitFor({ state: 'visible' });
  await select.click();
}

nativeTest(
  'contribution help uses the active Type pointer, pinned assertion digest, and keeps the unsent editor draft',
  300_000,
  async () => {
    const draft = `Guide draft ${crypto.randomUUID().slice(0, 8)}`;
    const journey = await fixture.auth.signIn('alice', { returnTo: '/en/catalogue/new' });
    const create = journey.context.pages().at(-1)!;
    create.setDefaultTimeout(60_000);
    await hydrate(create);
    await chooseBook(create);
    await create.locator('#create-label-0').fill(draft);

    const beforeCreate = fixture.stack.kernelRequests().length;
    const createGuide = await openHelp(create, typeHelp);
    await fixture.stack.syncKernelRequests();
    await fixture.stack.refreshKernelRequests();
    const createHref = new URL(createGuide.url());
    expect(createHref.pathname).toBe('/en/catalogue/definitions');
    expect(createHref.searchParams.get('type')).toBe('schema:Book');
    expect(createHref.searchParams.get('release')).toBeNull();
    expect(createHref.searchParams.get('returnTo')).toBe('/en/catalogue/new');
    await ui(createGuide.getByRole('heading', { name: 'Type and field guide', exact: true })).toBeVisible();
    await ui(createGuide.getByText('Active release', { exact: true })).toBeVisible();
    expect(await createGuide.getByText(fixture.digest).count()).toBeGreaterThan(0);
    expect(await createGuide.getByText(fixture.historicalDigest).count()).toBe(0);
    await ui(createGuide.getByRole('link', { name: 'author', exact: false }).first()).toBeVisible();
    const createReturn = createGuide.getByRole('link', { name: 'Return to contribution', exact: true });
    expect(await createReturn.getAttribute('href')).toBe('/en/catalogue/new');
    const createReads = definitionReads(beforeCreate);
    expect(createReads.some((request) => definitionPath(request) === '/v1/definitionTypes/schema:Book')).toBe(true);
    expect(createReads.every((request) => !definitionPath(request).includes(fixture.historicalDigest))).toBe(true);
    expect(writes(beforeCreate)).toHaveLength(0);
    expect(await create.locator('#create-label-0').inputValue()).toBe(draft);
    await createGuide.close();

    const page = await fixture.alice.context.newPage();
    page.setDefaultTimeout(60_000);
    const beforePublic = await fixture.current();
    const published = beforePublic.statements['schema:datePublished']![0]!;
    expect(published.rezics.release).toBe(fixture.digest);
    const opened = await page.goto(new URL(fixture.path, fixture.stack.web).href, { waitUntil: 'domcontentloaded' });
    expect(opened?.status()).toBe(200);
    await hydrate(page);
    const date = page.getByRole('region', { name: 'publication date', exact: true });
    await date.getByRole('button', { name: 'Edit this field', exact: true }).click();
    await date.getByText('Private proposal draft').waitFor({ state: 'visible' });
    await date.getByLabel('Day', { exact: true }).fill('7');

    const beforePin = fixture.stack.kernelRequests().length;
    const pinGuide = await openHelp(page, fieldHelp);
    await fixture.stack.syncKernelRequests();
    await fixture.stack.refreshKernelRequests();
    const pinHref = new URL(pinGuide.url());
    expect(pinHref.searchParams.get('type')).toBe('schema:Book');
    expect(pinHref.searchParams.get('property')).toBe('schema:datePublished');
    expect(pinHref.searchParams.get('release')).toBe(published.rezics.release);
    expect(pinHref.searchParams.get('returnTo')).toContain(`property=schema%3AdatePublished`);
    expect(pinHref.searchParams.get('returnTo')).toContain(`statement=${published.id}`);
    await ui(pinGuide.getByText('Pinned release', { exact: true })).toBeVisible();
    expect(await pinGuide.getByText(published.rezics.release).count()).toBeGreaterThan(0);
    await ui(pinGuide.getByText('Date with a precision and calendar', { exact: true })).toBeVisible();
    await ui(pinGuide.getByText('This field allows one selected value.', { exact: true })).toBeVisible();
    const pinReturn = await pinGuide
      .getByRole('link', { name: 'Return to contribution', exact: true })
      .getAttribute('href');
    expect(pinReturn).toContain('/edit');
    expect(pinReturn).toContain('property=schema%3AdatePublished');
    expect(pinReturn).toContain(`statement=${published.id}`);
    const pinReads = definitionReads(beforePin);
    expect(
      pinReads.some((request) => definitionPath(request) === `/v1/definitions/releases/${published.rezics.release}`),
    ).toBe(true);
    expect(pinReads.every((request) => definitionPath(request) !== '/v1/definitions/active')).toBe(true);
    expect(writes(beforePin)).toHaveLength(0);
    expect(await date.getByLabel('Day', { exact: true }).inputValue()).toBe('7');
    expect((await fixture.current()).statements['schema:datePublished']![0]!.value).toEqual(published.value);
    await pinGuide.close();
    await page.close();
    await create.close();
  },
  lifecycle,
);

nativeTest(
  'a missing pin stays unread, historical digest is distinct from active, and a failed pin is not empty Types',
  300_000,
  async () => {
    const page = await fixture.alice.context.newPage();
    page.setDefaultTimeout(60_000);
    const returnTo = encodeURIComponent('/en/catalogue/new');
    const historicalUrl = `${fixture.stack.web}/en/catalogue/definitions?type=schema%3ARecipe&property=schema%3AcookTime&release=${encodeURIComponent(fixture.historicalDigest)}&returnTo=${returnTo}`;

    const beforeHistorical = fixture.stack.kernelRequests().length;
    const historical = await page.goto(historicalUrl, { waitUntil: 'domcontentloaded' });
    expect(historical?.status()).toBe(200);
    await hydrate(page);
    await fixture.stack.syncKernelRequests();
    await fixture.stack.refreshKernelRequests();
    await ui(page.getByText('Pinned release', { exact: true })).toBeVisible();
    expect(await page.getByText(fixture.historicalDigest).count()).toBeGreaterThan(0);
    expect(await page.getByText(fixture.digest, { exact: true }).count()).toBe(0);
    await ui(page.getByText('Quantity with a unit', { exact: true })).toBeVisible();
    expect(await page.getByRole('link', { name: 'Return to contribution', exact: true }).getAttribute('href')).toBe(
      '/en/catalogue/new',
    );
    const historicalReads = definitionReads(beforeHistorical);
    expect(
      historicalReads.some(
        (request) => definitionPath(request) === `/v1/definitions/releases/${fixture.historicalDigest}`,
      ),
    ).toBe(true);
    expect(historicalReads.every((request) => definitionPath(request) !== '/v1/definitions/active')).toBe(true);
    expect(writes(beforeHistorical)).toHaveLength(0);

    const missingUrl = `${fixture.stack.web}/en/catalogue/definitions?type=schema%3ABook&release=${encodeURIComponent(fixture.missingDigest)}&returnTo=${returnTo}`;
    const beforeMissing = fixture.stack.kernelRequests().length;
    const missing = await page.goto(missingUrl, { waitUntil: 'domcontentloaded' });
    expect(missing?.status()).toBe(404);
    await fixture.stack.syncKernelRequests();
    await fixture.stack.refreshKernelRequests();
    await ui(page.getByText('No released Types are available', { exact: true })).toHaveCount(0);
    await ui(page.getByText('Active release', { exact: true })).toHaveCount(0);
    await ui(page.getByText(fixture.digest, { exact: true })).toHaveCount(0);
    const missingReads = definitionReads(beforeMissing);
    expect(
      missingReads.some((request) => definitionPath(request) === `/v1/definitions/releases/${fixture.missingDigest}`),
    ).toBe(true);
    expect(missingReads.every((request) => definitionPath(request) !== '/v1/definitions/active')).toBe(true);
    expect(writes(beforeMissing)).toHaveLength(0);

    await fixture.stack.injectKernelFailureOnce({
      method: 'GET',
      path: '/v1/definitions/releases/*',
      status: 503,
      body: JSON.stringify({
        type: 'https://rezics.com/problems/overloaded',
        title: 'Overloaded',
        status: 503,
        code: 'overloaded',
      }),
    });
    const failed = await page.goto(historicalUrl, { waitUntil: 'domcontentloaded' });
    expect(failed?.status()).toBe(200);
    await hydrate(page);
    await ui(page.getByRole('alert')).toContainText('Definitions could not be read');
    await ui(page.getByText('No released Types are available', { exact: true })).toHaveCount(0);
    await ui(page.getByText('Active release', { exact: true })).toHaveCount(0);
    await ui(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await page.close();
  },
  lifecycle,
);
