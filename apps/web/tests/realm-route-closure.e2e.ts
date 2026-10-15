import { expect, type Page, test, type TestInfo } from '@playwright/test';
import type { UiLocale } from '../i18n/define.ts';
import { localizedPath } from '../i18n/locale.ts';
import { resourceHref, spaceHref, threadHref } from '../features/address/path.ts';
import { realmHref, siteHref } from '../features/realm/route.ts';
import { messages as english } from '../features/realm/messages.ts';
import japanese from '../features/realm/messages/ja.ts';
import { closureFixture, closureRequestEvidence, short } from './realm-route-closure-fixture.ts';
import { expectClean, type Findings, pressByKeyboard } from './g-743-matrix.ts';

const locales = ['en', 'ja'] as const satisfies readonly UiLocale[];
const copy = { en: english, ja: japanese };
let fixture: Awaited<ReturnType<typeof closureFixture>>;

test.use({ actionTimeout: 15_000 });
test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(420_000);
  fixture = await closureFixture(browser, info);
});
test.afterAll(async () => { await fixture?.dispose(); });

async function open(page: Page, path: string) {
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    // Chromium can lose a navigation during host network-interface churn. Only replay this read.
    if (!(error instanceof Error) || !error.message.includes('net::ERR_NETWORK_CHANGED')) throw error;
    await page.goto(path, { waitUntil: 'domcontentloaded' });
  }
  await page.getByRole('main').waitFor({ timeout: 60_000 });
}

async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

async function missing(page: Page, locale: typeof locales[number]) {
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.getByRole('heading', { name: copy[locale].notFoundTitle, exact: true })).toBeVisible();
  await expect(page.getByText(fixture.realmName, { exact: true })).toHaveCount(0);
  await expect(page.getByText(fixture.opening.body, { exact: true })).toHaveCount(0);
  await expect(page.getByText(fixture.reply.body, { exact: true })).toHaveCount(0);
}

/** A failed owner request is retained verbatim in the report, never replaced by a browser stub. */
async function closedRequest(page: Page, path: string, info: TestInfo) {
  const response = await page.request.get(`/api/main/v1${path}`);
  const body = await response.text();
  await closureRequestEvidence(info, 'closed-realm-read', { method: 'GET', path: `/api/main/v1${path}`,
    status: response.status(), response: body });
  expect(response.status(), `GET ${path}: ${body}`).toBe(404);
}

test('realm-closure-direct: readers and the Realm owner lose direct pages after reload and recover after restoration', async ({ page }, info) => {
  test.setTimeout(300_000);
  const findings: Findings = [];
  const tabs = ['home', 'about', 'rules', 'members', 'decisions'] as const;
  // The signed-in owner has no disclosure exception on ordinary community pages.
  for (const reader of [page, fixture.page]) for (const locale of locales) for (const tab of tabs) {
    await open(reader, realmHref(locale, fixture.realm.space, tab));
    await expect(reader.getByRole('heading', { name: fixture.realmName, exact: true }).first()).toBeVisible();
  }
  await fixture.closeRealm(info);
  try {
    await closedRequest(page, `/realms/${short(fixture.realm.realm)}`, info);
    for (const reader of [page, fixture.page]) for (const locale of locales) for (const tab of tabs) {
      await open(reader, realmHref(locale, fixture.realm.space, tab));
      await reader.reload();
      await missing(reader, locale);
    }
    await shot(page, info, 'closed-direct-ja');
    await pressByKeyboard(page, page.getByRole('link', { name: japanese.browse, exact: true }), findings, 'Browse works (ja)');
    await expect(page).toHaveURL(url => url.pathname === localizedPath('/discover', 'ja'));
    // Closing a Realm does not close the independently published Work it adopted.
    await open(page, localizedPath(resourceHref('/w/', short(fixture.work.work)), 'en'));
    await page.reload();
    await expect(page.getByRole('heading', { name: fixture.title, exact: true }).first()).toBeVisible();
  } finally { await fixture.restoreRealm(info); }
  for (const locale of locales) {
    await open(page, realmHref(locale, fixture.realm.space));
    await page.reload();
    await expect(page.getByRole('heading', { name: fixture.realmName, exact: true }).first()).toBeVisible();
  }
  expectClean(findings);
});

test('realm-closure-threads: a reader cannot reopen an opening or nested reply until the Realm is restored', async ({ page }, info) => {
  test.setTimeout(240_000);
  const findings: Findings = [];
  const thread = (locale: UiLocale, reply: string) => localizedPath(threadHref(spaceHref(fixture.realm.space, 'community'), reply), locale);
  const liveThread = async (locale: UiLocale, item: typeof fixture.opening, bodies = [item.body]) => {
    // A read that loses its consistency cut offers reload. Recover through
    // that same public page; closure checks below still require immediate absence.
    await expect(async () => {
      await open(page, thread(locale, item.reply));
      await page.reload();
      for (const body of bodies) await expect(page.getByText(body, { exact: true }).first()).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 60_000, intervals: [1000] });
  };
  for (const locale of locales) for (const item of [fixture.opening, fixture.reply]) {
    await liveThread(locale, item);
  }
  await fixture.closeRealm(info);
  try {
    for (const item of [fixture.opening, fixture.reply]) {
      await closedRequest(page, `/realms/${short(fixture.realm.realm)}/threads/${short(item.reply)}`, info);
      for (const locale of locales) {
        await open(page, thread(locale, item.reply));
        await page.reload();
        await missing(page, locale);
      }
    }
    await shot(page, info, 'closed-nested-reply-ja');
    await pressByKeyboard(page, page.getByRole('link', { name: japanese.browse, exact: true }), findings, 'Leave the closed reply (ja)');
    await expect(page).toHaveURL(url => url.pathname === localizedPath('/discover', 'ja'));
  } finally { await fixture.restoreRealm(info); }
  for (const item of [fixture.opening, fixture.reply]) {
    const path = `/api/main/v1/realms/${short(fixture.realm.realm)}/threads/${short(item.reply)}`;
    const response = await page.request.get(path, { timeout: 60_000 });
    const body = await response.text();
    await closureRequestEvidence(info, 'restored-thread-read', { method: 'GET', path, status: response.status(), response: body });
    expect(response.status(), `GET ${path}: ${body}`).toBe(200);
  }
  for (const locale of locales) {
    await liveThread(locale, fixture.opening, [fixture.opening.body, fixture.reply.body]);
    await liveThread(locale, fixture.reply);
  }
  await shot(page, info, 'restored-thread-ja');
  expectClean(findings);
});

test('realm-closure-directory: a newcomer sees only live communities after reload and follows one by keyboard', async ({ page }, info) => {
  test.setTimeout(240_000);
  const findings: Findings = [];
  const at = (locale: UiLocale) => localizedPath(`/discover?type=communities&q=${encodeURIComponent('Closure harbor')}`, locale);
  const card = (name: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('link');
  // Wait only for initial indexing. Closed rows must disappear at read time, without waiting for an index drain.
  await expect(async () => {
    await open(page, at('en'));
    await expect(card(fixture.realmName)).toBeVisible({ timeout: 1000 });
    await expect(card(fixture.liveName)).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await fixture.closeRealm(info);
  try {
    for (const locale of locales) {
      await open(page, at(locale));
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(card(fixture.realmName)).toHaveCount(0);
      await expect(card(fixture.liveName)).toBeVisible();
      await shot(page, info, `closed-directory-${locale}`);
      await pressByKeyboard(page, card(fixture.liveName), findings, `live community (${locale})`);
      await expect(page.getByRole('heading', { name: fixture.liveName, exact: true }).first()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
    }
  } finally { await fixture.restoreRealm(info); }
  for (const locale of locales) {
    await open(page, at(locale));
    await page.reload();
    await expect(card(fixture.realmName)).toBeVisible();
    await expect(card(fixture.liveName)).toBeVisible();
  }
  expectClean(findings);
});

test('realm-closure-zone: a visitor keeps the independent Zone while its Realm discussion and shelf disappear after reload', async ({ page }, info) => {
  test.setTimeout(240_000);
  const findings: Findings = [];
  const discussion = () => page.getByRole('region').filter({ has: page.getByRole('link', { name: fixture.realmName, exact: true }) });
  const shelf = () => page.getByRole('region', { name: 'Harbor community shelf', exact: true });
  for (const locale of locales) {
    await open(page, siteHref(locale, fixture.zone.space, []));
    await expect(page.getByText(fixture.homeText, { exact: true })).toBeVisible();
    await expect(shelf().getByText(fixture.title, { exact: true }).first()).toBeVisible();
    await open(page, siteHref(locale, fixture.zone.space, ['guide']));
    await expect(discussion().first()).toBeVisible();
  }
  await fixture.closeRealm(info);
  try {
    for (const locale of locales) {
      await open(page, siteHref(locale, fixture.zone.space, []));
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByText(fixture.homeText, { exact: true })).toBeVisible();
      await expect(shelf().getByText(fixture.title, { exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: fixture.realmName, exact: true })).toHaveCount(0);
      await shot(page, info, `closed-zone-shelf-${locale}`);
      await open(page, siteHref(locale, fixture.zone.space, ['guide']));
      await page.reload();
      await expect(page.getByRole('heading', { name: fixture.title, exact: true }).first()).toBeVisible();
      await expect(discussion()).toHaveCount(0);
      await expect(page.getByText(fixture.opening.body, { exact: true })).toHaveCount(0);
    }
  } finally { await fixture.restoreRealm(info); }
  for (const locale of locales) {
    await open(page, siteHref(locale, fixture.zone.space, []));
    await page.reload();
    await expect(shelf().getByText(fixture.title, { exact: true }).first()).toBeVisible();
    await open(page, siteHref(locale, fixture.zone.space, ['guide']));
    await page.reload();
    await expect(discussion().first()).toBeVisible();
    const link = discussion().first().getByRole('link', { name: fixture.realmName, exact: true });
    await pressByKeyboard(page, link, findings, `restored discussion community (${locale})`);
    await expect(page.getByRole('heading', { name: fixture.realmName, exact: true }).first()).toBeVisible();
  }
  expectClean(findings);
});
