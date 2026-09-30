import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

interface PublicFixture { actingSubject: string }
interface PrivateFixture { member: { email: string; password: string } }

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Studio opens as the session Agent, at that Agent's own address. */
function sessionStudio(): string {
  return `/en/studio/@agent-${fixture<PublicFixture>('REZICS_WEB_AUTH_PUBLIC_PATH').actingSubject.slice(-36)}`;
}

async function signIn(page: Page, next = sessionStudio()): Promise<void> {
  const privateFixture = fixture<PrivateFixture>('REZICS_WEB_AUTH_PRIVATE_PATH');
  await signInAtAccounts(page, next, privateFixture.member);
}

/** Creates a Work from Studio's new-work form and returns its ID from the editor it opens. */
async function createWork(page: Page, title: string): Promise<string> {
  await page.goto(`${sessionStudio()}/new`);
  await page.getByRole('textbox', { name: 'Title' }).fill(title);
  // A story opens its editor; a book opens its chapters.
  await page.getByText('A story', { exact: true }).click();
  await page.getByRole('button', { name: /^Create as / }).click();
  await page.waitForURL(new RegExp(`^[^?]*${sessionStudio()}/works/[0-9a-f-]{36}/write\\?language=en$`));
  return /\/works\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
}

/** Opens the shell's account menu; a click that lands before hydration does nothing, so retry. */
async function openAccountMenu(page: Page): Promise<void> {
  const trigger = page.getByRole('banner').getByRole('button', { name: 'Account menu' });
  await expect(async () => {
    if (await page.getByRole('menu').isVisible()) return;
    await trigger.click();
    await expect(page.getByRole('menu')).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

async function cookie(context: BrowserContext, name: string) {
  return (await context.cookies()).find(item => item.name === name);
}

test('IAM02: invalid OAuth state is rejected at the web callback', async ({ page }) => {
  const issuer = `${process.env.ACCOUNT_ORIGIN ?? 'http://127.0.0.1:3004'}/api/auth`;
  const invalidCallback = await page.goto(`/auth/callback?code=invalid&state=invalid&iss=${encodeURIComponent(issuer)}`);
  // G-537: a failed callback lands on a page that says what failed and offers a retry.
  expect(invalidCallback?.status()).toBe(200);
  await expect(page).toHaveURL(/\/en\/identity\/failed\?reason=state/);
  await expect(page.getByRole('alert')).toContainText('started in another browser');
  await expect(page.getByRole('link', { name: 'Try signing in again' })).toBeVisible();
  const wrongIssuer = await page.goto('/auth/callback?code=invalid&state=invalid&iss=https://evil.test/api/auth');
  expect(wrongIssuer?.status()).toBe(200);
  await expect(page).toHaveURL(/\/en\/identity\/failed\?reason=issuer/);
  await expect(page.getByRole('alert')).toContainText('did not come from your REZICS Account service');
});

test('IAM01: a web session outlives its access token, keeps its Agent and signs out', async ({ page, context }, testInfo) => {
  const publicFixture = fixture<PublicFixture>('REZICS_WEB_AUTH_PUBLIC_PATH');
  await signIn(page);
  // The member may act as exactly one Agent, so the new session starts with it.
  await expect(page).toHaveURL(sessionStudio());
  const sessionKey = (await cookie(context, 'rezics_session_key'))?.value;
  expect(sessionKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(await cookie(context, 'rezics_subject')).toBeUndefined();
  for (const name of ['rezics_access', 'rezics_refresh', 'rezics_session', 'rezics_session_key']) {
    expect((await cookie(context, name))?.httpOnly, name).toBe(true);
  }
  const selected = await page.request.get('/api/main/v1/me/session-agent', {
    headers: { 'x-session-key': sessionKey! } });
  expect(selected.status()).toBe(200);
  expect((await selected.json() as { sessionAgent: { actingSubject: string } }).sessionAgent.actingSubject)
    .toBe(publicFixture.actingSubject);
  expect(await page.evaluate(() => document.cookie)).not.toContain('rezics_');

  // Forced expiry: the next request refreshes and rotates, and the person stays signed in.
  const refresh = (await cookie(context, 'rezics_refresh'))?.value;
  await context.clearCookies({ name: 'rezics_access' });
  await page.reload();
  await expect(page).toHaveURL(sessionStudio());
  expect(await cookie(context, 'rezics_access')).toBeDefined();
  expect((await cookie(context, 'rezics_refresh'))?.value).not.toBe(refresh);

  // Choosing an Agent Main does not list is refused, and the session Agent stays.
  const forged = await page.request.post('/identity/select', { maxRedirects: 0,
    form: { agent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001', next: '/en/studio' } });
  expect(forged.headers().location).toContain('/en/identity?error=invalid');
  expect((await cookie(context, 'rezics_session_key'))?.value).toBe(sessionKey);
  // The shell's account menu shows the session Agent and switches it explicitly.
  await page.goto('/en/studio');
  const account = page.getByRole('banner').getByRole('button', { name: 'Account menu' });
  const discovery = await page.request.get('/api/main/v1/me/acting-contexts?task=work.create');
  expect(discovery.status()).toBe(200);
  const body = await discovery.json() as { contexts: Array<{ actingSubject: string;
    displayName: string | null }> };
  const displayName = body.contexts.find(option => option.actingSubject === publicFixture.actingSubject)
    ?.displayName;
  await expect(account).toContainText(displayName
    ?? `Agent ${publicFixture.actingSubject.split('/').at(-1)!.slice(0, 8)}`);
  await openAccountMenu(page);
  await expect(page.getByRole('menu')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('session-account-menu-desktop.png') });
  await page.getByRole('menuitem', { name: 'Switch Agent' }).click();
  await expect(page).toHaveURL(`/en/identity?next=${encodeURIComponent(sessionStudio())}`);
  await expect(page.getByRole('radio', { checked: true })).toHaveValue(publicFixture.actingSubject);
  await page.screenshot({ path: testInfo.outputPath('session-agent-picker-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('session-agent-picker-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('checkbox', { name: /Make this my default/ }).check();
  await page.getByRole('button', { name: 'Use this Agent' }).click();
  await expect(page).toHaveURL(sessionStudio());
  const mainAgent = await page.request.get('/api/main/v1/me/main-agent-preference');
  expect(mainAgent.status()).toBe(200);
  expect((await mainAgent.json() as { mainAgent: { actingSubject: string } }).mainAgent.actingSubject)
    .toBe(publicFixture.actingSubject);
  expect(await cookie(context, 'rezics_subject')).toBeUndefined();

  // A clear written directly to Main must take effect without changing a web cookie.
  const beforeClear = await page.request.get('/api/main/v1/me/session-agent', {
    headers: { 'x-session-key': sessionKey! } });
  const revision = (await beforeClear.json() as { sessionAgent: { revision: string } }).sessionAgent.revision;
  const clear = await page.request.put('/api/main/v1/me/session-agent', {
    headers: { 'x-session-key': sessionKey!, 'idempotency-key': crypto.randomUUID() },
    data: { actingSubject: null, expectedRevision: revision } });
  expect(clear.status()).toBe(200);
  await page.goto('/en/studio');
  await expect(page).toHaveURL('/en/identity?next=%2Fen%2Fstudio');
  await expect(account).toContainText('Choose an Agent');
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
  await page.getByRole('radio', { name: new RegExp(publicFixture.actingSubject) }).check();
  await page.getByRole('button', { name: 'Use this Agent' }).click();
  await expect(page).toHaveURL(sessionStudio());

  // Signing out revokes this product's refresh token and returns to public Home.
  await openAccountMenu(page);
  await expect(page.getByRole('menuitem', { name: 'Manage your REZICS Account' }))
    .toHaveAttribute('href', process.env.ACCOUNT_ORIGIN ?? 'http://127.0.0.1:3004');
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/en');
  for (const name of ['rezics_access', 'rezics_refresh', 'rezics_session',
    'rezics_session_key', 'rezics_subject']) {
    expect(await cookie(context, name), name).toBeUndefined();
  }
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();
});

test('IAM03: the Agent held by Main is used for Work creation', async ({ page, context }) => {
  const publicFixture = fixture<PublicFixture>('REZICS_WEB_AUTH_PUBLIC_PATH');
  await signIn(page);
  await expect(page).toHaveURL(sessionStudio());
  const sessionKey = (await cookie(context, 'rezics_session_key'))?.value;
  expect(sessionKey).toBeDefined();
  const state = await page.request.get('/api/main/v1/me/session-agent', {
    headers: { 'x-session-key': sessionKey! } });
  expect(state.status()).toBe(200);
  const agent = (await state.json() as { sessionAgent: { actingSubject: string } })
    .sessionAgent.actingSubject;
  expect(agent).toBe(publicFixture.actingSubject);
  // Studio's address names the session Agent, and the new Work opens in that Agent's Studio.
  const work = await createWork(page, `Session Agent Work ${Date.now()}`);
  expect(work).toMatch(/^[0-9a-f-]{36}$/);
  expect(await cookie(context, 'rezics_subject')).toBeUndefined();
});

test('WORK01: authenticated member creates a metadata-only Work with an empty Main Version', async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await signIn(page);
  await expect(page).toHaveURL(sessionStudio());
  const title = `Browser Work ${Date.now()}`;
  const id = await createWork(page, title);
  const work = `https://rezics.com/id/${id}`;
  const grant = spawnSync('bun', ['apps/web/tests/grant-read.ts'], { cwd: process.cwd(),
    env: { ...process.env, REZICS_QA_WORK: work }, encoding: 'utf8', timeout: 30_000 });
  if (grant.status !== 0 || grant.error) {
    throw new Error(`QA Work read grant failed: ${grant.stderr || grant.error?.message || grant.status}`);
  }
  // The fixture Agent reads its new Work through the QA grant; the editor then opens it.
  const read = await page.request.get(`/api/main/v1/works/${id}?actingSubject=${encodeURIComponent(
    fixture<PublicFixture>('REZICS_WEB_AUTH_PUBLIC_PATH').actingSubject)}`);
  expect(read.status()).toBe(200);
  const header = await read.json() as { mainVersion: string; revision: string; title: { value: string } };
  expect(header.title.value).toBe(title);
  expect(header.mainVersion).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/);
  expect(header.mainVersion).not.toBe(work);
  // The BFF serves the same Main paths to the browser as Main does.
  const selection = await page.request.get(`/api/main/v1/main-versions/${header.mainVersion.split('/').at(-1)}/selection`);
  expect(selection.status()).toBe(404);
  // Per-language selection resolves the native variant first, so an empty Main Version reports it missing.
  expect((await selection.json() as { code: string }).code).toBe('variant_unavailable');
  const revision = header.revision;
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('work-created-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('work-created-mobile.png') });

  await page.request.post('/locale/select', { form: { locale: 'zh-Hans' } });
  await page.goto(`/zh-Hans/works/${revision.split('/').at(-1)}`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('heading', { name: '修订详情' })).toBeVisible();
  await expect(page.getByText(/此元数据修订的标识为/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('work-revision-chinese-mobile.png') });
  expect(browserErrors).toEqual([]);
});
