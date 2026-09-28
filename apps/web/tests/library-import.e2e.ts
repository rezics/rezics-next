import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signInAtAccounts } from './account-sign-in.ts';

const member = { email: 'rezics-demo-daniel@example.test', password: 'Rezics-demo-2026-daniel' };
const sample = `Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies
1885,"Pride and Prejudice","Jane Austen","Austen, Jane","","=""0679783261""","=""9780679783268""",5,4.29,"Modern Library","Paperback",279,2000,1813,2025/03/02,2025/01/10,"classics","classics (#1)",read,"Still funny.","","",1,0
2767052,"Frankenstein","Mary Wollstonecraft Shelley","Shelley, Mary","","","",0,3.89,"","",260,2003,1818,,2025/04/01,"to-read","to-read (#3)",to-read,"","","",0,0
99999999,"A Book That Does Not Exist Anywhere","Nobody Real","Real, Nobody","","","",3,3.0,"","",100,2020,2020,2024/12/12,2024/12/01,"","",read,"","","",1,0
`;
const known = [['Pride and Prejudice', 'Jane Austen'], ['Jane Eyre', 'Charlotte Brontë'],
  ['Frankenstein', 'Mary Shelley'], ['Little Women', 'Louisa May Alcott'],
  ['The Odyssey', 'Homer'], ['Moby-Dick', 'Herman Melville'],
  ['Great Expectations', 'Charles Dickens'], ['Wuthering Heights', 'Emily Brontë']];
const synthetic = ['Book Id,Title,Author,ISBN13,My Rating,Date Read,Bookshelves,Exclusive Shelf,My Review',
  ...Array.from({ length: 200 }, (_, index) => index < 160
    ? `${index + 1},${known[index % known.length]![0]},${known[index % known.length]![1]},,5,2026/08/01,classics,read,`
    : `${index + 1},Unknown import title ${index - 159},Nobody Real,,0,,to-read,to-read,`)].join('\n');
function fixture(name: 'goodreads_library_export.csv' | 'goodreads-200.csv') {
  const copied = resolve('.temp/goal/fixtures', name);
  return { name, mimeType: 'text/csv', buffer: existsSync(copied) ? readFileSync(copied)
    : Buffer.from(name === 'goodreads-200.csv' ? synthetic : sample) };
}

test('G428: Daniel imports a reviewed Goodreads export twice and a 200-row export', async ({ page, context }, info) => {
  test.skip(process.env.REZICS_LIBRARY_IMPORT_DEMO !== '1', 'Requires task dev:seed on the isolated worktree stack');
  test.setTimeout(600_000);
  await signInAtAccounts(page, '/en/library', member);
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  const directSource = await page.request.post('/api/main/v1/sources/acquisitions/open-library/works', {
    data: { profile: 'open-library-work-acquisition-v1', workId: 'OL66554W' },
    headers: { 'idempotency-key': 'g428-reader-direct-source-denied' },
  });
  expect(directSource.status()).toBe(401);
  expect(await directSource.json()).toMatchObject({ code: 'account_assertion_denied' });
  await page.getByRole('heading', { name: 'Import your books' }).click();
  const importPanel = page.locator('details').filter({ has: page.locator('#library-import') });
  for (let pass = 0; pass < 2; pass++) {
    await page.locator('#library-import-file').setInputFiles([]);
    await page.locator('#library-import-file').setInputFiles(fixture('goodreads_library_export.csv'));
    await expect(importPanel.getByRole('status').filter({ hasText: /found/ }))
      .toBeVisible({ timeout: 90_000 });
    const frankenstein = importPanel.locator('li').filter({ hasText: 'Frankenstein' }).first();
    await frankenstein.getByRole('button', { name: 'Search REZICS' }).click();
    await expect(frankenstein.getByText('Choose a Work')).toBeVisible({ timeout: 20_000 });
    await frankenstein.getByRole('button', { name: /Frankenstein; or, The Modern Prometheus/ }).click();
    const unknown = importPanel.locator('li').filter({ hasText: 'A Book That Does Not Exist Anywhere' }).first();
    await unknown.getByRole('button', { name: 'Skip this book' }).click();
    await importPanel.getByRole('button', { name: 'Import selected books' }).click();
    await expect(importPanel.getByRole('link', { name: 'View Library' })).toBeVisible({ timeout: 90_000 });
    const pride = importPanel.locator('li').filter({ hasText: 'Pride and Prejudice' }).first();
    await expect(pride.getByRole('button', { name: 'Keep mine' })).toBeVisible();
    await pride.getByRole('button', { name: 'Keep mine' }).click();
    await importPanel.getByRole('button', { name: 'Import selected books' }).click();
    await expect(importPanel.getByText('Imported 2 books.')).toBeVisible({ timeout: 90_000 });
  }
  await page.locator('#library-import-file').setInputFiles([]);
  await page.locator('#library-import-file').setInputFiles(fixture('goodreads-200.csv'));
  await expect(importPanel.getByRole('status').filter({ hasText: /Checking matches:.*of 200/ }))
    .toBeVisible({ timeout: 30_000 });
  await expect(importPanel.getByRole('status').filter({ hasText: /Checking matches:/ }))
    .toHaveCount(0, { timeout: 240_000 });
  await expect(importPanel.getByRole('status').filter({ hasText: /found/ }))
    .toBeVisible({ timeout: 240_000 });
  await expect(importPanel.getByText('Page 1 of 10')).toBeVisible();
  await page.screenshot({ path: info.outputPath('import-review-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath('import-review-phone.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await importPanel.getByRole('button', { name: 'Skip all needing attention' }).click();
  await importPanel.getByRole('button', { name: 'Import selected books' }).click();
  await expect(importPanel.getByRole('link', { name: 'View Library' })).toBeVisible({ timeout: 240_000 });
  await expect(importPanel.getByText(/Imported \d+ books?\./)).toBeVisible();
  await page.screenshot({ path: info.outputPath('import-result-desktop.png') });
  const tooMany = ['Title,Author,Exclusive Shelf',
    ...Array.from({ length: 501 }, (_, index) => `Unknown ${index},Nobody,to-read`)].join('\n');
  await page.locator('#library-import-file').setInputFiles([]);
  await page.locator('#library-import-file').setInputFiles({ name: 'too-many.csv', mimeType: 'text/csv',
    buffer: Buffer.from(tooMany) });
  await expect(importPanel.getByText('Import up to 500 books at a time. Split this CSV and try again.'))
    .toBeVisible();
  for (const locale of ['en', 'zh-Hans'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      await context.addCookies([{ name: 'rezics_theme', value: theme, url: page.url() }]);
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await page.goto(`/${locale}/library`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByRole('heading', { name: locale === 'en'
          ? 'Reading in 2026' : '2026 年阅读统计' })).toBeVisible();
        await expect(page.getByText(locale === 'en' ? /Average rating given:/ : /我的平均评分：/))
          .toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        await page.screenshot({ path: info.outputPath(`import-${locale}-${theme}-${viewport.width}.png`) });
      }
    }
  }
});
