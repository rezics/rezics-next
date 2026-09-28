import { readFileSync } from 'node:fs';
import { type BrowserContext, expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

// Studio in a real browser against the isolated QA stack: a writer acting as
// their own person Agent starts a Chinese book, adds chapters in place and
// reorders them, writes a chapter with autosave through offline and a second
// tab's save, publishes it and an update, publishes the book's introduction,
// edits its details and cover, and submits it to a Realm. The QA member's
// fixture Agent holds only a SQL grant for Work creation, so the journey
// provisions a real person Agent through Main, the way a writer's pen name
// gets its standing authority.

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
const pathOf = (page: Page) => { const url = new URL(page.url()); return `${url.pathname}${url.search}`; };

async function shoot(page: Page, info: TestInfo, name: string) {
  expect(await overflows(page), name).toBe(false);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

/**
 * Every theme and size for one Studio page: 1440×900 and 390×844, light and dark. The theme cookie paints the
 * first render and the shell then adopts the account's own display preference, so both name the theme captured.
 */
async function shootAll(page: Page, context: BrowserContext, info: TestInfo, path: string, name: string) {
  let theme: 'light' | 'dark' = 'light';
  await page.route('**/api/preferences', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json().catch(() => null) as Record<string, unknown> | null;
    return json ? route.fulfill({ response, json: { ...json, displayMode: theme } }) : route.fulfill({ response });
  });
  for (const current of ['light', 'dark'] as const) {
    theme = current;
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await context.addCookies([{ name: 'rezics_theme', value: theme, url: new URL('/', page.url()).toString() }]);
      await page.setViewportSize(viewport);
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await shoot(page, info, `${name}-${theme}-${viewport.width}`);
    }
  }
  await page.unroute('**/api/preferences');
  await context.addCookies([{ name: 'rezics_theme', value: 'light', url: new URL('/', page.url()).toString() }]);
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** Types at the end of a manuscript editor's text. */
async function append(page: Page, text: string, name: RegExp = /^(Text|Chapter text|正文|章节正文)$/) {
  const editor = page.getByRole('textbox', { name });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

/** Publishes from the open editor and waits for every step Main reports; the second one may be refused. */
async function publish(page: Page, button: string, heading: string, steps: RegExp[], where?: string) {
  await page.getByRole('button', { name: button, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: heading })).toBeVisible();
  if (where) await expect(dialog).toContainText(where);
  await dialog.getByRole('checkbox', { name: /I wrote this text/ }).check();
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  const list = dialog.getByRole('list', { name: 'Publish' });
  for (const [index, step] of steps.entries()) {
    await expect(list.getByRole('listitem').nth(index)).toContainText(step, { timeout: 60_000 });
  }
  return dialog;
}

test('STUDIO01: a writer builds a chaptered book, writes through offline and a second tab, publishes and submits it',
  async ({ page, context }, info) => {
    test.setTimeout(480_000);
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

    // A new book, in Chinese: it opens on its chapters.
    await page.getByRole('link', { name: 'New work', exact: true }).click();
    await expect(page).toHaveURL(`${studio}/new`);
    const title = `雨夜书店 ${Date.now() % 1000}`;
    await page.getByRole('textbox', { name: 'Title' }).fill(title);
    await page.getByText('A book', { exact: true }).click();
    const writingLanguage = page.getByRole('combobox', { name: 'Language you’ll write in' });
    await expect(writingLanguage).toHaveText('Choose a language');
    await page.getByRole('button', { name: 'Create as Studio Writer 书生' }).click();
    await expect(page).toHaveURL(`${studio}/new`);
    await expect(page.getByText('Choose the language of this work, or select Undetermined.')).toBeVisible();
    await writingLanguage.click();
    await page.getByRole('option', { name: 'Simplified Chinese' }).click();
    await shoot(page, info, 'studio-new-work');
    await page.getByRole('button', { name: 'Create as Studio Writer 书生' }).click();
    await page.waitForURL(/\/works\/[0-9a-f-]{36}\?tab=chapters$/);
    const work = /\/works\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    const workPage = `${studio}/works/${work}`;
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

    // Chapters are added in place, in order, and reorder on the composition's current head.
    for (const chapter of ['第一章 雨夜', '第二章 未寄出的信', '第三章 最后一班车']) {
      await expect(async () => {
        await page.getByRole('textbox', { name: 'New chapter' }).fill(chapter);
        await page.getByRole('button', { name: 'Add chapter' }).click();
        await expect(page.getByRole('link', { name: `Write “${chapter}”` })).toBeVisible({ timeout: 30_000 });
      }).toPass({ timeout: 90_000 });
    }
    // A chapter moves from its handle's menu (the keyboard's way) as well as by dragging the handle.
    /** Opens a control's menu; a press before the page hydrates opens nothing, so it is pressed again. */
    const menu = async (button: string, item: string) => {
      await expect(async () => {
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: button, exact: true }).click();
        await expect(page.getByRole('menuitem', { name: item })).toBeVisible({ timeout: 3_000 });
      }).toPass({ timeout: 60_000 });
      await page.getByRole('menuitem', { name: item }).click();
    };
    const move = async (chapter: string, how: string) => {
      await menu(`Move “${chapter}”`, how);
      await expect(page.getByRole('status').filter({ hasText: `Moved “${chapter}”` })).toBeAttached({ timeout: 30_000 });
    };
    await move('第三章 最后一班车', 'Move “第三章 最后一班车” up');
    await page.reload();
    const chapters = page.getByRole('region', { name: 'Chapters' });
    await expect(chapters.getByRole('listitem').nth(1)).toContainText('第三章 最后一班车');
    // Main says where each chapter stands: nothing is written yet.
    await expect(chapters.getByRole('listitem').filter({ hasText: '第一章 雨夜' })).toContainText('Not started',
      { timeout: 30_000 });
    await move('第三章 最后一班车', 'Move “第三章 最后一班车” down');
    await page.reload();
    await expect(chapters.getByRole('listitem').nth(2)).toContainText('第三章 最后一班车');
    await shoot(page, info, 'studio-chapters');

    // Writing a chapter: the first pause saves its draft, and the address pins the saved revision.
    await page.getByRole('link', { name: 'Write “第一章 雨夜”' }).click();
    await page.waitForURL(/\/chapters\/[0-9a-f-]{36}/);
    await expect(page.getByRole('textbox', { name: 'Chapter text' })).toHaveAttribute('lang', 'zh-Hans');
    await page.waitForLoadState('networkidle');
    await append(page, '雨停在书店打烊前。');
    await expect(saveState(page)).toHaveText(/^Saved · /, { timeout: 30_000 });
    await expect(page).toHaveURL(/\/chapters\/[0-9a-f-]{36}\?revision=[0-9a-f-]{36}&language=zh-Hans$/);
    // Chinese is measured in characters.
    await expect(page.getByText('9 characters')).toBeVisible();

    // Offline: the text stays on this device and saves when the network returns.
    await context.setOffline(true);
    await append(page, '\n她在门口发现一封没有地址的信。');
    await expect(saveState(page)).toHaveText('Offline — kept on this device', { timeout: 15_000 });
    expect(await page.evaluate(() => Object.keys(localStorage).some(item => item.startsWith('rezics:studio:draft:')
      && localStorage.getItem(item)!.includes('没有地址的信')))).toBe(true);
    await context.setOffline(false);
    await expect(saveState(page)).toHaveText(/^Saved · /, { timeout: 30_000 });

    // A second tab saves first; Main names the head that won, and this tab compares and keeps its own text on top.
    const other = await context.newPage();
    await other.goto(page.url());
    await expect(other.getByRole('textbox', { name: 'Chapter text' })).toHaveValue(/没有地址的信/);
    // Typing before the editor hydrates would land in the server-rendered field and never save.
    await other.waitForLoadState('networkidle');
    await append(other, '\n另一个标签页写下的一段。');
    await expect(saveState(other)).toHaveText(/^Saved · /, { timeout: 30_000 });
    await other.close();
    await append(page, '\n这个标签页写下的一段。');
    await expect(page.getByRole('alert').filter({ hasText: 'This text was changed somewhere else' }))
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('另一个标签页写下的一段。')).toBeVisible();
    await shoot(page, info, 'studio-chapter-conflict');
    await page.getByRole('button', { name: 'Keep mine' }).click();
    await expect(saveState(page)).toHaveText(/^Saved · /, { timeout: 30_000 });
    const chapterPath = pathOf(page);

    // Publishing a chapter, then an update of it.
    let dialog = await publish(page, 'Publish', 'Publish “第一章 雨夜”', [/Done/, /Done/],
      `In “${title}” on REZICS, for everyone to read`);
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await append(page, '\n信封里只有一张旧车票。');
    await expect(saveState(page)).toHaveText(/^Saved · /, { timeout: 30_000 });
    dialog = await publish(page, 'Publish update', 'Publish an update to “第一章 雨夜”', [/Done/, /Done/]);
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await page.goto(`${workPage}?tab=chapters`);
    await expect(page.getByRole('region', { name: 'Chapters' }).getByRole('listitem').filter({ hasText: '第一章 雨夜' }))
      .toContainText('Published');

    // Volumes: made in place, chapters moved into them by menu and by drag, and a new chapter added to a chosen one.
    const volume = async (name: string) => {
      await page.getByRole('button', { name: 'New volume' }).click();
      await page.getByRole('textbox', { name: /^Title/ }).fill(name);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(chapters.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible({ timeout: 30_000 });
    };
    await volume('第一卷 雨夜');
    // Into a volume from the Move menu, as the keyboard does it: ↓ to the volume under "Move to", Enter.
    const highlight = async (name: string) => {
      const item = page.getByRole('menuitem', { name, exact: true });
      await expect(item).toBeVisible();
      // The menu takes focus a frame after it opens; keys pressed before then reach the page instead.
      await expect(item.locator('xpath=ancestor::*[@role="menu"][1]')).toBeFocused();
      for (let step = 0; step < 8 && await item.getAttribute('data-highlighted') === null; step++) {
        await page.keyboard.press('ArrowDown');
      }
      await expect(item).toHaveAttribute('data-highlighted', '');
    };
    await expect(async () => {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Move “第一章 雨夜”', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Move to' }).getByRole('menuitem', { name: '第一卷 雨夜' }))
        .toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await highlight('第一卷 雨夜');
    await page.keyboard.press('Enter');
    await expect(chapters.getByRole('button', { name: /^第一卷 雨夜/ })).toContainText('1 chapter', { timeout: 30_000 });
    // A pointer drags the grip beside the Move button, once the list has settled and its controls are enabled.
    await expect(page.getByRole('button', { name: 'Move “第二章 未寄出的信”', exact: true })).toBeEnabled({ timeout: 30_000 });
    await chapters.getByRole('listitem').filter({ hasText: '第二章 未寄出的信' }).last().locator('[data-drag-handle]')
      .dragTo(chapters.getByRole('button', { name: /^第一卷 雨夜/ }));
    await expect(chapters.getByRole('button', { name: /^第一卷 雨夜/ })).toContainText('2 chapters', { timeout: 30_000 });
    await volume('第二卷 末班车');
    await expect(page.getByRole('combobox', { name: 'Add to' })).toContainText('第二卷 末班车');
    await page.getByRole('textbox', { name: 'New chapter' }).fill('第四章 站台');
    await page.getByRole('button', { name: 'Add chapter' }).click();
    await expect(chapters.getByRole('button', { name: /^第二卷 末班车/ })).toContainText('1 chapter', { timeout: 30_000 });
    await page.reload();
    // Numbers run through the book in reading order: the chapter left at the top level stands before the volumes.
    await expect(chapters.getByRole('button', { name: /^第一卷 雨夜/ })).toContainText('2 chapters');
    await expect(chapters.getByRole('listitem').filter({ hasText: '第四章 站台' }).last()).toContainText('4');
    await shoot(page, info, 'studio-volumes');

    // The book's introduction is its own text: what readers see first and what a Realm reviews.
    await page.goto(`${workPage}?tab=text`);
    await page.getByRole('link', { name: 'Write the introduction' }).click();
    await append(page, '一封没有地址的信，把雨夜书店带向二十年前的秘密。', /^Text$/);
    await expect(saveState(page)).toHaveText(/^Saved · /, { timeout: 30_000 });
    dialog = await publish(page, 'Publish', `Publish “${title}”`, [/Done/, /Done|Didn’t work/]);
    await dialog.getByRole('button', { name: 'Close' }).first().click();

    // Details: tagline, serial status and description, saved by the Work's creator.
    await page.goto(`${workPage}?tab=details`);
    const details = page.getByRole('region', { name: 'Details' });
    await details.getByRole('combobox', { name: 'Status' }).click();
    await page.getByRole('option', { name: 'Ongoing' }).click();
    await details.getByRole('textbox', { name: 'Tagline' }).fill('一封没有地址的信，把雨夜书店带向二十年前的秘密。');
    await details.getByRole('textbox', { name: 'Description' }).fill('雨夜里，一家书店和一封没有地址的信。');
    await details.getByRole('button', { name: 'Save details' }).click();
    await expect(details.getByRole('status').filter({ hasText: 'Details saved.' })).toBeVisible({ timeout: 30_000 });

    // A cover, framed to the book's shape before it is sent.
    const png = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 900; canvas.height = 600;
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#1d3557'; g.fillRect(0, 0, 900, 600);
      g.fillStyle = '#f1faee'; g.beginPath(); g.arc(600, 200, 90, 0, Math.PI * 2); g.fill();
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
      return [...new Uint8Array(await blob.arrayBuffer())];
    });
    await page.locator('input[type="file"]').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from(png) });
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Frame the cover' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Use this cover' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Cover updated.' })).toBeVisible({ timeout: 60_000 });

    // A Realm to submit to, created by the writer the way anyone starts one; its review mode is shown before submitting.
    const realm = await page.request.post('/api/main/v1/spaces', { headers: { 'idempotency-key': `${key}-realm` },
      data: { profile: 'space-realm-v1', name: 'Studio QA Realm', capabilities: ['realm'], actingSubject: writer } });
    await page.goto(`${workPage}?tab=realms`);
    const choice = page.getByRole('radio', { name: /Studio QA Realm/ });
    if (realm.ok() && await choice.count()) {
      await expect(page.getByRole('group', { name: 'Realm' })).toContainText(/review|accepted at once/);
      await choice.check();
      await page.getByRole('button', { name: 'Submit', exact: true }).click();
      await expect(page.getByRole('status').or(page.getByRole('alert'))
        .filter({ hasText: /Submitted to Studio QA Realm|can’t submit to this Realm/ })).toBeVisible({ timeout: 60_000 });
    }
    await shoot(page, info, 'studio-realms');

    // The session Agent opening the writer's book: each chapter names the identity that writes it, even one still
    // private to the writer, and Switch opens it in the writer's Studio. The book is public once its introduction
    // is its main text; Main may refuse that step above.
    await expect(async () => {
      await page.goto(`${sessionStudio}/works/${work}?tab=chapters`);
      await expect(page.getByRole('region', { name: 'Writing as' })).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    if (await page.getByRole('heading', { level: 1, name: title }).isVisible()) {
      const region = page.getByRole('region', { name: 'Chapters' });
      // The volume being written (the last) opens by itself; the first opens on request.
      await region.getByRole('button', { name: /^第一卷 雨夜/ }).click();
      const rows = region.getByRole('listitem');
      await expect(rows.filter({ hasText: '第一章 雨夜' }).last()).toContainText('Written as Studio Writer 书生',
        { timeout: 30_000 });
      await expect(rows.filter({ hasText: '第二章 未寄出的信' }).last()).toContainText('Written as Studio Writer 书生');
      await shoot(page, info, 'studio-chapters-written-as');
      await page.getByRole('link', { name: 'Switch to Studio Writer 书生 to write “第一章 雨夜”' }).click();
      await page.waitForURL(url => url.pathname.startsWith(`${studio}/works/${work}/chapters/`));
      await expect(page.getByRole('region', { name: 'Writing as' })).toContainText('Studio Writer 书生');
    }

    // Another identity's Studio is reported, never opened or switched to.
    await expect(async () => {
      await page.goto('/en/studio/@agent-00000000-0000-4000-8000-000000000001');
      await expect(page.getByRole('heading', { name: 'You can’t write as this identity' })).toBeVisible();
    }).toPass({ timeout: 30_000 });

    // Screens in English and Simplified Chinese, light and dark, desktop and phone.
    await shootAll(page, context, info, studio, 'studio-home-en');
    await shootAll(page, context, info, `${workPage}?tab=chapters`, 'studio-chapters-en');
    await shootAll(page, context, info, chapterPath, 'studio-chapter-en');
    await shootAll(page, context, info, `${workPage}?tab=chapters`.replace('/en/', '/zh-Hans/'), 'studio-chapters-zh');
    await shootAll(page, context, info, chapterPath.replace('/en/', '/zh-Hans/'), 'studio-chapter-zh');
    await expect(page.getByRole('textbox', { name: '章节正文' })).toBeVisible();
    expect(errors).toEqual([]);
  });
