import { readFileSync } from 'node:fs';
import { type APIRequestContext, type Browser, expect, type Locator, type Page, test, type TestInfo } from '@playwright/test';
import { localizedPath } from '../i18n/locale.ts';
import { realmHref } from '../features/realm/route.ts';
import { signInAtAccounts } from './account-sign-in.ts';

interface PublicFixture { actingSubject: string }
interface PrivateFixture { member: { email: string; password: string } }

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Ark paints the label over the native control, so the click lands on the label. */
const choose = (control: Locator) => control.locator('xpath=ancestor::label[1]').click();
/** A pressed button can scale under the pointer and keep the focus without running its handler. */
const activate = (control: Locator) => control.evaluate(node => { (node as HTMLElement).click(); });

const copy = {
  en: {
    title: 'Create a community', name: 'Community name', handle: 'Community handle',
    description: 'Description',
    choices: { public: /Public/, restricted: /Restricted/, private: /Private/ }, ruleTitle: 'Rule title', ruleBody: 'What does this rule mean?',
    addRule: 'Add a rule', submit: 'Create community', failed: 'Could not create this community',
    owned: 'You already have a community at this handle', openOwned: 'Open your community',
  },
  'zh-Hans': {
    title: '创建社区', name: '社区名称', handle: '社区短名', description: '社区简介',
    choices: { public: /公开/, restricted: /受限/, private: /私密/ }, ruleTitle: '规则标题',
    ruleBody: '这条规则是什么意思？', addRule: '添加规则', submit: '创建社区',
    failed: '无法创建社区',
    owned: '你已经有一个使用这个短名的社区', openOwned: '打开这个社区',
  },
} as const;

const communityName = 'Readers Circle';
const missingTitle = 'This community isn’t here';
const emptyDiscussions = 'No discussions yet';
const discussionsFailed = 'Couldn’t load the discussions';
const ruleTitle = 'Be kind';
const ruleBody = 'Respect every reader.';

type Choice = keyof typeof copy.en.choices;

async function fillRealm(page: Page, locale: keyof typeof copy, handle: string, choice: Choice = 'private') {
  const words = copy[locale];
  await page.goto(localizedPath('/r/new', locale));
  await expect(page.getByRole('heading', { level: 1, name: words.title })).toBeVisible();
  // Buttons on this form do nothing until the shell has hydrated.
  await expect(page.getByRole('button', { name: locale === 'en' ? 'Account menu' : '账户菜单' }))
    .toHaveAttribute('data-hydrated', 'true', { timeout: 30_000 });
  await page.getByRole('textbox', { name: words.name }).fill(communityName);
  await page.getByRole('textbox', { name: new RegExp(words.handle) }).fill(handle);
  await page.getByRole('textbox', { name: words.description }).fill('A private circle for readers.');
  // The writer has not named a language; the form records that instead of the interface locale.
  await choose(page.getByRole('radio', { name: words.choices[choice] }));
  await activate(page.getByRole('button', { name: words.addRule, exact: true }));
  await page.getByRole('textbox', { name: words.ruleTitle }).fill(ruleTitle);
  await page.getByRole('textbox', { name: words.ruleBody }).fill(ruleBody);
}

async function managedRealms(page: Page, actingSubject: string) {
  const listed = await page.request.get(`/api/main/v1/me/managed-realms?${new URLSearchParams({ actingSubject })}`);
  const body = await listed.text();
  expect(listed.status(), body).toBe(200);
  return JSON.parse(body) as { items: { realm: string }[]; nextCursor: string | null };
}

function hidden(body: string, path: string) {
  for (const secret of [communityName, ruleTitle, ruleBody])
    if (body.includes(secret)) throw new Error(`${path} showed ${JSON.stringify(secret)} to an anonymous reader`);
}

/**
 * The document an anonymous reader receives. This uses an API context, which
 * does not share the founder's cookies and does not run inside a page route.
 * While setup is still in flight the only claim is that the reader learns
 * nothing; once the Realm exists the read is the same as a missing address.
 */
async function anonymousDocument(request: APIRequestContext, handle: string, realmIri: string | null) {
  const paths = [realmHref('en', handle)];
  if (realmIri) paths.push(realmHref('en', realmIri.slice(-36)));
  for (const path of paths) {
    const response = await request.get(path, { timeout: 20_000 });
    const body = await response.text();
    const headings = [...body.matchAll(/<h1\b[^>]*>(.*?)<\/h1>/gis)]
      .map(match => match[1]!.replace(/<[^>]+>/g, '').trim());
    console.log(`realm-create anonymous ${response.status()} ${path} bytes ${body.length} headings ${JSON.stringify(headings)}`);
    // A missing or unreadable Realm is a 404 that renders the same "isn't here" screen.
    expect(response.status(), path).toBe(404);
    expect(headings, path).toEqual([missingTitle]);
    hidden(body, path);
  }
  const resolve = await request.get(`/api/main/v1/addresses/resolve?${new URLSearchParams({
    scope: 'space', key: handle })}`, { timeout: 20_000 });
  const resolveBody = await resolve.text();
  if (realmIri) expect(resolve.status(), resolveBody).toBe(404);
  else hidden(resolveBody, 'resolve');
  if (!realmIri) return;
  const header = await request.get(`/api/main/v1/realms/${realmIri.slice(-36)}`, { timeout: 20_000 });
  expect(header.status(), await header.text()).toBe(404);
}

/** An anonymous reader gets the same answer as a missing community. */
async function anonymousMisses(browser: Browser, testInfo: TestInfo, handle: string, realmIri: string) {
  const id = realmIri.slice(-36);
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error('The anonymous reader needs the journey base URL');
  const context = await browser.newContext({
    baseURL, viewport: { width: 1280, height: 800 }, storageState: { cookies: [], origins: [] },
  });
  try {
    const reader = await context.newPage();
    reader.setDefaultTimeout(20_000);
    reader.setDefaultNavigationTimeout(45_000);
    for (const path of [realmHref('en', id), realmHref('en', handle)]) {
      const response = await reader.goto(path);
      const text = await reader.locator('body').innerText();
      console.log(`realm-create reader ${response?.status()} ${reader.url()} text ${JSON.stringify(text.slice(0, 160))}`);
      expect(response?.status(), path).toBe(404);
      expect(text, path).not.toContain(communityName);
      expect(text, path).not.toContain(ruleTitle);
      expect(text, path).not.toContain(ruleBody);
    }
    const resolve = await context.request.get(`/api/main/v1/addresses/resolve?${new URLSearchParams({
      scope: 'space', key: handle })}`);
    expect(resolve.status()).toBe(404);
    const header = await context.request.get(`/api/main/v1/realms/${id}`);
    expect(header.status()).toBe(404);
  } finally { await context.close(); }
}

/** After a reload the same details meet the founder's Realm. The notice links to it; nothing is written over it. */
async function openRecoveredRealm(page: Page, locale: keyof typeof copy, home: string) {
  const words = copy[locale];
  await expect(page.getByRole('alert')).toContainText(words.owned, { timeout: 60_000 });
  if (page.viewportSize()?.width === 390)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await activate(page.getByRole('link', { name: words.openOwned, exact: true }));
  await page.waitForURL(url => url.pathname === home, { timeout: 60_000 });
}

async function shoot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, fullPage: true });
  console.log(`realm-create screenshot ${path}`);
  return path;
}

test('A lost private-Realm response reloads into the one Realm the founder created', async ({ page, context, request }, testInfo) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(45_000);
  const session = fixture<PublicFixture>('REZICS_WEB_AUTH_PUBLIC_PATH');
  const member = fixture<PrivateFixture>('REZICS_WEB_AUTH_PRIVATE_PATH').member;
  const browser = context.browser();
  if (!browser) throw new Error('The journey needs a browser to open an anonymous reader');
  const handle = `readers-${crypto.randomUUID().slice(0, 6)}`;
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtAccounts(page, '/en/r/new', member);
  const before = await managedRealms(page, session.actingSubject);
  expect(before.items, 'the fixture member starts with no managed Realm, so exactly one is meaningful').toEqual([]);

  let realmIri = '';
  let withheld = 0;
  // The reader looks while Main still holds the receipt. Page work stays
  // outside the route: waiting on it there never delivers the failure.
  let duringSetup: Promise<void> = Promise.resolve();
  let duringFailure: unknown;
  await page.route('**/api/main/v1/spaces', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'POST' || !url.pathname.endsWith('/v1/spaces')) {
      await route.continue();
      return;
    }
    const flight = route.fetch();
    if (withheld === 0) duringSetup = anonymousDocument(request, handle, null).catch(error => { duringFailure = error; });
    try {
      const response = await flight;
      const body = await response.json() as { realm?: string };
      console.log(`realm-create withheld ${response.status()} ${body.realm ?? 'no-realm'}`);
      if (!body.realm?.startsWith('https://rezics.com/id/'))
        throw new Error(`Creation reached Main without a Realm receipt: ${response.status()} ${JSON.stringify(body)}`);
      if (!realmIri) realmIri = body.realm;
      else if (body.realm !== realmIri)
        throw new Error(`The same creation key read back ${body.realm} instead of ${realmIri}`);
    } finally {
      withheld++;
      await route.abort('failed');
    }
  });

  await fillRealm(page, 'en', handle);
  await shoot(page, testInfo, 'realm-create-en-1280-form.png');
  await activate(page.getByRole('button', { name: copy.en.submit, exact: true }));
  await expect(page.getByRole('alert')).toContainText(copy.en.failed, { timeout: 120_000 });
  expect(withheld).toBeGreaterThan(0);
  await duringSetup;
  if (duringFailure) throw duringFailure;
  await anonymousDocument(request, handle, realmIri);
  await anonymousMisses(browser, testInfo, handle, realmIri);
  await page.unroute('**/api/main/v1/spaces');
  const id = realmIri.slice(-36);
  const home = realmHref('en', id);

  await page.reload();
  await fillRealm(page, 'en', handle);
  await activate(page.getByRole('button', { name: copy.en.submit, exact: true }));
  await openRecoveredRealm(page, 'en', home);
  await expect(page.getByRole('heading', { level: 1, name: communityName })).toBeVisible();
  await shoot(page, testInfo, 'realm-create-en-1280-realm.png');
  await page.goto(realmHref('en', id, 'about'));
  await expect(page.getByRole('heading', { level: 1, name: communityName })).toBeVisible();
  const englishRules = page.getByRole('region', { name: 'Community rules' });
  await expect(englishRules).toContainText(ruleTitle, { timeout: 20_000 });
  await expect(englishRules).toContainText(ruleBody);
  await anonymousMisses(browser, testInfo, handle, realmIri);

  const listed = await managedRealms(page, session.actingSubject);
  expect(listed.nextCursor).toBeNull();
  expect(listed.items.map(item => item.realm)).toEqual([realmIri]);

  await page.setViewportSize({ width: 390, height: 844 });
  await fillRealm(page, 'en', handle);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await shoot(page, testInfo, 'realm-create-en-390-form.png');
  await activate(page.getByRole('button', { name: copy.en.submit, exact: true }));
  await openRecoveredRealm(page, 'en', home);
  await expect(page.getByRole('heading', { level: 1, name: communityName })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await shoot(page, testInfo, 'realm-create-en-390-realm.png');

  await page.setViewportSize({ width: 1280, height: 800 });
  await fillRealm(page, 'zh-Hans', handle);
  await shoot(page, testInfo, 'realm-create-zh-Hans-1280-form.png');
  await activate(page.getByRole('button', { name: copy['zh-Hans'].submit, exact: true }));
  await openRecoveredRealm(page, 'zh-Hans', realmHref('zh-Hans', id));
  await expect(page.getByRole('heading', { level: 1, name: communityName })).toBeVisible();
  await shoot(page, testInfo, 'realm-create-zh-Hans-1280-realm.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await fillRealm(page, 'zh-Hans', handle);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await shoot(page, testInfo, 'realm-create-zh-Hans-390-form.png');
  await activate(page.getByRole('button', { name: copy['zh-Hans'].submit, exact: true }));
  await openRecoveredRealm(page, 'zh-Hans', realmHref('zh-Hans', id));
  await expect(page.getByRole('heading', { level: 1, name: communityName })).toBeVisible();
  await page.goto(realmHref('zh-Hans', id, 'about'));
  const chineseRules = page.getByRole('region', { name: '社区规则' });
  await expect(chineseRules).toContainText(ruleTitle, { timeout: 20_000 });
  await expect(chineseRules).toContainText(ruleBody);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await shoot(page, testInfo, 'realm-create-zh-Hans-390-realm.png');

  const after = await managedRealms(page, session.actingSubject);
  expect(after.nextCursor).toBeNull();
  expect(after.items.map(item => item.realm)).toEqual([realmIri]);
  console.log(`realm-create qa ${process.env.REZICS_QA_RUN_ID ?? 'local'} realm ${realmIri}`);
});


/** The reader has no cookies: the same answer for a private Realm and a handle nobody holds. */
async function anonymousPage(browser: Browser, baseURL: string, path: string) {
  const context = await browser.newContext({
    baseURL, viewport: { width: 1280, height: 800 }, storageState: { cookies: [], origins: [] },
  });
  try {
    const reader = await context.newPage();
    reader.setDefaultTimeout(20_000);
    reader.setDefaultNavigationTimeout(45_000);
    const response = await reader.goto(path);
    const heading = reader.getByRole('heading', { level: 1 });
    await expect(heading.first()).toBeVisible();
    return { status: response?.status(), heading: await heading.first().innerText(), text: await reader.locator('body').innerText() };
  } finally { await context.close(); }
}

test('Each privacy choice opens a Realm that reads as chosen, with an empty discussion list for its founder', async ({ page, context }, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(45_000);
  const baseURL = testInfo.project.use.baseURL;
  const browser = context.browser();
  if (!baseURL || !browser) throw new Error('The journey needs a base URL and a browser to open anonymous readers');
  const member = fixture<PrivateFixture>('REZICS_WEB_AUTH_PRIVATE_PATH').member;
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtAccounts(page, '/en/r/new', member);

  const readable: Record<Choice, boolean> = { public: true, restricted: true, private: false };
  for (const choice of Object.keys(copy.en.choices) as Choice[]) {
    const handle = `${choice}-${crypto.randomUUID().slice(0, 6)}`;
    await fillRealm(page, 'en', handle, choice);
    await activate(page.getByRole('button', { name: copy.en.submit, exact: true }));
    // A Realm with a public address opens at its handle; a private one has none and opens at its id.
    await page.waitForURL(url => /^\/en\/r\/[^/]+$/.test(url.pathname) && url.pathname !== '/en/r/new', { timeout: 120_000 });
    const home = new URL(page.url()).pathname;
    await expect(page.getByRole('heading', { level: 1, name: communityName })).toBeVisible();
    // A new Realm has no threads: the list invites the first post instead of reporting a failure.
    await expect(page.getByText(emptyDiscussions)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(discussionsFailed)).toHaveCount(0);
    await shoot(page, testInfo, `realm-create-${choice}-1280-founder.png`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByText(emptyDiscussions)).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await shoot(page, testInfo, `realm-create-${choice}-390-founder.png`);
    await page.setViewportSize({ width: 1280, height: 800 });

    for (const path of new Set([home, realmHref('en', handle)])) {
      const reader = await anonymousPage(browser, baseURL, path);
      console.log(`realm-create ${choice} anonymous ${reader.status} ${path} heading ${JSON.stringify(reader.heading)}`);
      if (readable[choice]) {
        expect(reader.status, path).toBe(200);
        expect(reader.heading, path).toBe(communityName);
      } else {
        expect(reader.status, path).toBe(404);
        expect(reader.heading, path).toBe(missingTitle);
        expect(reader.text, path).not.toContain(communityName);
      }
    }
  }

  const absent = await anonymousPage(browser, baseURL, realmHref('en', `nobody-${crypto.randomUUID().slice(0, 6)}`));
  expect(absent.status).toBe(404);
  expect(absent.heading).toBe(missingTitle);
});
