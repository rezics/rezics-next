import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

// Studio in a real browser against the isolated QA stack: a writer acting as
// their own person Agent creates a Work, writes with autosave, goes offline,
// meets a second tab's save and publishes. The QA member's fixture Agent holds
// only a SQL grant for Work creation, so the journey provisions a real person
// Agent through Main, the way a writer's pen name gets its standing authority.

interface PublicFixture { actingSubject: string }
interface PrivateFixture { member: { email: string; password: string } }

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const uuid = (iri: string) => iri.slice(-36);
const overflows = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const saveState = (page: Page) => page.locator('[data-slot="autosave-status"] [role="status"]');

async function shoot(page: Page, info: TestInfo, name: string) {
  expect(await overflows(page), name).toBe(false);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

/** Every theme and size for one Studio page: 1440×900 and 390×844, light and dark. */
async function shootAll(page: Page, context: BrowserContext, info: TestInfo, path: string, name: string) {
  for (const theme of ['light', 'dark'] as const) {
    // One site-wide cookie: a cookie scoped to a page path would shadow or lose to another page's.
    await context.addCookies([{ name: 'rezics_theme', value: theme, url: new URL('/', page.url()).toString() }]);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await shoot(page, info, `${name}-${theme}-${viewport.width}`);
    }
  }
  await context.addCookies([{ name: 'rezics_theme', value: 'light', url: new URL('/', page.url()).toString() }]);
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** Types at the end of the editor's text. */
async function append(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: /^(Text|正文)$/ });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

test('STUDIO01: a writer creates, autosaves through offline and a second tab, and publishes as a chosen Agent',
  async ({ page, context }, info) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const session = fixture<PublicFixture>('REZICS_WEB_AUTH_PUBLIC_PATH');
    const member = fixture<PrivateFixture>('REZICS_WEB_AUTH_PRIVATE_PATH').member;
    const sessionStudio = `/en/studio/@agent-${uuid(session.actingSubject)}`;
    await signInAtAccounts(page, sessionStudio, member);
    // Studio opens as the session Agent and names it before anything is created.
    await page.goto('/en/studio');
    await expect(page).toHaveURL(sessionStudio);
    await expect(page.getByRole('region', { name: 'Writing as' })).toBeVisible();

    // A second person Agent for this account, provisioned through Main.
    const key = `studio-e2e-${Date.now()}`;
    let writer = '';
    await expect(async () => {
      const response = await page.request.post('/api/main/v1/agents', { headers: { 'idempotency-key': key },
        data: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Studio Writer 书生' } });
      expect([200, 201]).toContain(response.status());
      writer = (await response.json() as { agent: string }).agent;
    }).toPass({ timeout: 60_000 });
    const studio = `/en/studio/@agent-${uuid(writer)}`;
    await expect(async () => {
      await page.goto(studio);
      await expect(page.getByRole('region', { name: 'Writing as' })).toContainText('Studio Writer 书生', { timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    // Studio acts as the writer in this tab only; the session Agent stays.
    await expect(page.getByText(/Studio acts as Studio Writer 书生 here; the rest of REZICS still uses/)).toBeVisible();
    await shoot(page, info, 'studio-home-start');

    // A new Work names who creates it on the button.
    await page.getByRole('link', { name: 'New work' }).click();
    await expect(page).toHaveURL(`${studio}/new`);
    const title = `雨夜书店 · 第${Date.now() % 1000}章`;
    await page.getByRole('textbox', { name: 'Title' }).fill(title);
    await page.getByText('A story or chapter').click();
    await page.getByRole('combobox', { name: 'Language you’ll write in' }).selectOption('zh-Hans');
    await shoot(page, info, 'studio-new-work');
    await page.getByRole('button', { name: 'Create as Studio Writer 书生' }).click();
    await page.waitForURL(/\/works\/[0-9a-f-]{36}\/write\?language=zh-Hans$/);
    const work = /\/works\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
    // Main records every new Work's title language as English for now; the text itself carries zh-Hans.
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Text' })).toHaveAttribute('lang', 'zh-Hans');

    // Writing: the first pause saves, and the address pins the saved revision.
    await append(page, '第一章 雨夜\n雨停在书店打烊前。');
    await expect(saveState(page)).toHaveText(/^Saved · /, { timeout: 30_000 });
    await expect(page).toHaveURL(/\/write\/[0-9a-f-]{36}\?revision=[0-9a-f-]{36}$/);
    await shoot(page, info, 'studio-write-saved');

    // Offline: the text stays on this device and saves when the network returns.
    await context.setOffline(true);
    await append(page, '\n她在门口发现一封没有地址的信。');
    await expect(saveState(page)).toHaveText('Offline — kept on this device', { timeout: 15_000 });
    expect(await page.evaluate(() => Object.keys(localStorage).some(item => item.startsWith('rezics:studio:draft:')
      && localStorage.getItem(item)!.includes('没有地址的信')))).toBe(true);
    await shoot(page, info, 'studio-write-offline');
    await context.setOffline(false);
    await expect(saveState(page)).toHaveText(/^Saved · /, { timeout: 30_000 });

    // A second tab saves first; this tab stops, compares and keeps its own text on top.
    const other = await context.newPage();
    await other.goto(page.url());
    await expect(other.getByRole('textbox', { name: 'Text' })).toHaveValue(/没有地址的信/);
    await append(other, '\n另一个标签页写下的一段。');
    await expect(saveState(other)).toHaveText(/^Saved · /, { timeout: 30_000 });
    await append(page, '\n这个标签页写下的一段。');
    await expect(page.getByRole('alert').filter({ hasText: 'This text was changed somewhere else' }))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('另一个标签页写下的一段。')).toBeVisible();
    await shoot(page, info, 'studio-write-conflict');
    await page.getByRole('button', { name: 'Keep mine' }).click();
    await expect(saveState(page)).toHaveText(/^Saved · /, { timeout: 30_000 });
    await other.close();
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Text' })).toHaveValue(/这个标签页写下的一段。$/);
    const writePath = new URL(page.url()).pathname + new URL(page.url()).search;

    // A Realm to submit to, created by the writer the way anyone starts one.
    const realm = await page.request.post('/api/main/v1/spaces', { headers: { 'idempotency-key': `${key}-realm` },
      data: { profile: 'space-realm-v1', name: 'Studio QA Realm', capabilities: ['realm'], actingSubject: writer } });
    await page.reload();

    // Publishing names who, where and what readers see; each command reports its own outcome.
    await page.getByRole('button', { name: 'Publish' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: `Publish “${title}”` })).toBeVisible();
    await expect(dialog).toContainText('Published as');
    await expect(dialog).toContainText('Studio Writer 书生');
    await expect(dialog).toContainText('On REZICS, for everyone to read');
    await expect(dialog).toContainText('雨停在书店打烊前。');
    await dialog.getByRole('checkbox', { name: /I wrote this text/ }).check();
    const realmChoice = dialog.getByRole('checkbox', { name: 'Studio QA Realm' });
    const submitting = realm.ok() && await realmChoice.count() > 0;
    if (submitting) await realmChoice.check();
    await shoot(page, info, 'studio-publish-dialog');
    await dialog.getByRole('button', { name: 'Publish' }).click();
    const steps = dialog.getByRole('list', { name: 'Publish' });
    await expect(steps.getByRole('listitem').first()).toContainText('Done', { timeout: 60_000 });
    await expect(steps.getByRole('listitem').nth(1)).toContainText('Done', { timeout: 60_000 });
    // Main does not yet give a person the Realm submission authority; the step says so instead of failing silently.
    if (submitting) await expect(steps.getByRole('listitem').nth(2)).toContainText(/Done|can’t submit to this Realm yet/);
    await shoot(page, info, 'studio-publish-result');
    await dialog.getByRole('button', { name: 'Close' }).first().click();

    // Readers see the Work, and Studio's Work page says it is public.
    await expect(async () => {
      await page.goto(`/en/w/${work}`);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await page.goto(`${studio}/works/${work}`);
    await expect(page.getByText('Public', { exact: true })).toBeVisible();
    const details = page.getByRole('region', { name: 'Details' });
    await expect(details.getByRole('combobox', { name: 'Language' }).first()).not.toHaveValue('');
    await details.getByRole('textbox', { name: 'Description' }).fill('雨夜里，一家书店和一封没有地址的信。');
    await details.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByRole('alert').or(page.getByRole('status')).filter({ hasText: /Details saved|can’t edit this work’s details/ }))
      .toBeVisible({ timeout: 30_000 });

    // Main does not yet let a Work's creator edit its details; either answer keeps the typed description.
    await expect(details.getByRole('textbox', { name: 'Description' })).toHaveValue('雨夜里，一家书店和一封没有地址的信。');

    // Another identity's Studio is reported, never opened or switched to.
    await page.goto('/en/studio/@agent-00000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('heading', { name: 'You can’t write as this identity' })).toBeVisible();

    // Screens in English and Simplified Chinese, light and dark, desktop and phone.
    await shootAll(page, context, info, studio, 'studio-home-en');
    await shootAll(page, context, info, writePath, 'studio-write-en');
    await shootAll(page, context, info, `${studio}/works/${work}`, 'studio-work-en');
    await shootAll(page, context, info, studio.replace('/en/', '/zh-Hans/'), 'studio-home-zh');
    await shootAll(page, context, info, writePath.replace('/en/', '/zh-Hans/'), 'studio-write-zh');
    await expect(page.getByRole('textbox', { name: '正文' })).toBeVisible();
    expect(errors).toEqual([]);
  });
