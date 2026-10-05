import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { uuidToSid } from '@rezics/model/address';
import { documentText, type DocumentSnapshot } from '@rezics/document';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });
test.afterEach(async ({ page }, info) => {
  if (info.status === 'passed' || !new URL(page.url()).pathname.includes('/studio/')) return;
  if (await page.locator('[data-slot="autosave-status"]').count()) {
    await page.screenshot({ path: info.outputPath('studio-shared-failure.png'), fullPage: true });
  }
});

const saved = (page: Page) => page.locator('[data-slot="autosave-status"] [role="status"]');
const pathOf = (page: Page) => { const url = new URL(page.url()); return `${url.pathname}${url.search}`; };

async function write(page: Page, label: string, text: string) {
  const editor = page.getByRole('textbox', { name: label, exact: true });
  await expect(editor).toBeVisible({ timeout: 60_000 });
  const side = label === 'Author’s note before the chapter' ? 'before'
    : label === 'Author’s note after the chapter' ? 'after' : null;
  const persisted = page.waitForResponse(response => {
    const request = response.request();
    if (request.method() !== 'POST'
      || !/\/(content-drafts|contributions|contribution-edits)$/.test(new URL(request.url()).pathname)) return false;
    const input = request.postDataJSON();
    const part = side ? input.notes?.[side] : input;
    return part && (part.body === text || part.document
      && documentText(part.document as DocumentSnapshot) === text);
  }, { timeout: 60_000 });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
  await expect(editor).toHaveText(text);
  const response = await persisted;
  expect([200, 201]).toContain(response.status());
  const savedRevision = await response.json() as { revisionId?: string; draftRevision?: string };
  expect(savedRevision.revisionId ?? savedRevision.draftRevision).toBeTruthy();
  await expect(saved(page)).toHaveText(/^Saved · /, { timeout: 30_000 });
  if (savedRevision.revisionId) {
    await expect.poll(() => new URL(page.url()).searchParams.get('revision')).toBe(savedRevision.revisionId);
  }
}

async function publish(page: Page) {
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const consent = dialog.getByRole('checkbox', { name: /I wrote this text/ });
  await consent.press('Space');
  await expect(consent).toBeChecked();
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(dialog.getByRole('list', { name: 'Publish' }).getByText('Done', { exact: true })).toHaveCount(2, { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

test('A writer publishes separate chapter notes and reads them through chapter search and old addresses in both UI languages and sizes',
  async ({ page }, info) => {
    test.setTimeout(480_000);
    const privatePath = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
    if (!privatePath) throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must name the shared member fixture');
    // Credentials stay in memory for sign-in; never copy the fixture into test artifacts.
    const member = (JSON.parse(readFileSync(privatePath, 'utf8')) as {
      member: { email: string; password: string };
    }).member;
    await signInAtAccounts(page, '/en', member);
    const key = randomUUID();
    const writer = await page.request.post('/api/main/v1/agents', {
      headers: { 'idempotency-key': `author-notes-writer-${key}` },
      data: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Author Notes Writer' },
    });
    expect([200, 201]).toContain(writer.status());
    const agent = (await writer.json() as { agent: string }).agent;
    const studio = `/en/studio/@${uuidToSid(agent.slice(-36))}`;
    await page.goto(`${studio}/new`);
    await page.waitForLoadState('networkidle');
    const title = `The Lantern Road ${key.slice(0, 8)}`;
    const chapterTitle = 'At the harbour';
    const phrase = `lanternroad${key.replaceAll('-', '').slice(0, 12)}`;
    const text = `The ${phrase} lantern lights the path to the harbour.`;
    const before = 'Thank you for returning to this story. This chapter begins at the harbour.';
    const after = 'The mapmaker returns next week. Until then, take care.';
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
    await page.getByText('Book', { exact: true }).click();
    const english = page.getByRole('option', { name: 'English', exact: true });
    await expect(async () => {
      if (!await english.isVisible()) await page.getByRole('combobox', { name: 'Language you’ll write in' }).click();
      await expect(english).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 60_000 });
    await english.click();
    await page.getByRole('button', { name: 'Create as Author Notes Writer' }).click();
    await page.waitForURL(/\/works\/[0-9a-f-]{36}\?tab=chapters$/);
    const book = /\/works\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    const bookStudio = `${studio}/works/${book}`;
    // A public introduction makes the Book discoverable alongside its chapter's search hit.
    await page.goto(`${bookStudio}?tab=text`);
    await page.getByRole('link', { name: 'Write the introduction' }).click();
    await page.waitForLoadState('networkidle');
    await write(page, 'Text', 'A mapmaker follows an old road to the harbour.');
    await publish(page);
    await page.goto(`${bookStudio}?tab=chapters`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('textbox', { name: 'New chapter' }).fill(chapterTitle);
    await page.getByRole('button', { name: 'Add chapter', exact: true }).click();
    const writeChapter = page.getByRole('link', { name: `Write “${chapterTitle}”` });
    await expect(writeChapter).toBeVisible({ timeout: 60_000 });
    await writeChapter.click();
    await page.waitForURL(/\/chapters\/[0-9a-f-]{36}/);
    await page.waitForLoadState('networkidle');
    await write(page, 'Chapter text', text);
    await write(page, 'Author’s note before the chapter', before);
    await write(page, 'Author’s note after the chapter', after);
    const chapterPath = pathOf(page);
    const post = /\/chapters\/([0-9a-f-]{36})/.exec(chapterPath)![1]!;
    const revision = new URL(page.url()).searchParams.get('revision');
    const ownDraft = await page.request.get(`/api/main/v1/content-revisions/${revision}?actingSubject=${encodeURIComponent(agent)}`);
    expect(ownDraft.status()).toBe(200);
    expect(await ownDraft.json()).toMatchObject({ body: { body: text,
      notes: { before: { body: before }, after: { body: after } } } });
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Author’s note before the chapter' })).toHaveText(before);
    await expect(page.getByRole('textbox', { name: 'Author’s note after the chapter' })).toHaveText(after);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await screenshot(page, info, `studio-en-${viewport.width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await publish(page);

    // An unpublished language variant starts with its own empty notes.
    await page.goto(`${studio}/works/${book}/chapters/${post}?language=zh-Hant`);
    await expect(page.getByRole('textbox', { name: 'Chapter text' })).toHaveAttribute('lang', 'zh-Hant');
    await expect(page.getByRole('textbox', { name: 'Author’s note before the chapter' })).toHaveText('');
    await expect(page.getByRole('textbox', { name: 'Author’s note after the chapter' })).toHaveText('');

    // The historical chapter Work URL resolves to the Post's placement in the reader.
    // ast-grep-ignore: web-links-use-address -- A raw chapter UUID independently exercises the historical Work URL redirect.
    await page.goto(`/en/w/${post}?language=en`);
    await page.waitForURL(/\/read\//);
    await expect(page.getByRole('heading', { level: 1, name: chapterTitle })).toBeVisible();
    const readerPath = pathOf(page);
    expect(new URL(page.url()).pathname.split('/')).toContain('read');
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const locale of ['en', 'zh-Hant'] as const) {
        // Interface language changes the labels; the chosen Content variant stays explicitly English.
        await page.goto(readerPath.replace(/^\/en\//, `/${locale}/`));
        await expect(page.getByRole('article')).toHaveAttribute('lang', 'en');
        await expect(page.getByRole('note', { name: locale === 'en' ? 'Author’s note' : '作者的話' })).toHaveCount(2);
        await expect(page.locator('[data-author-note="before"]')).toContainText(before);
        await expect(page.locator('[data-reader-text]')).toHaveText(text);
        await expect(page.locator('[data-author-note="after"]')).toContainText(after);
        await expect(page.locator('[data-author-note] [data-paragraph]')).toHaveCount(0);
        await screenshot(page, info, `reader-${locale}-${viewport.width}`);
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(async () => {
      await page.goto(`/en/discover?q=${phrase}`);
      await expect(page.getByRole('link', { name: chapterTitle, exact: true })).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 90_000 });
    await screenshot(page, info, 'chapter-search-hit');
    await page.getByRole('link', { name: chapterTitle, exact: true }).click();
    await page.waitForURL(/\/read\//);
    await expect(page.locator('[data-author-note="before"]')).toContainText(before);
    await expect(page.locator('[data-author-note="after"]')).toContainText(after);
  });
