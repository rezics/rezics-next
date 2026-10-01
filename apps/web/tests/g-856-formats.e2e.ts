import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { materializeData } from 'native-i18n';
import { messages } from '../features/library/messages.ts';
import { clean, credentials, exportRows, signIn } from './g-855-library.ts';

const t = materializeData(messages, { locale: 'en' });
const formats = [
  { radio: 'The StoryGraph', file: 'storygraph.csv', mime: 'text/csv', retained: 'hopeful' },
  {
    radio: 'MyAnimeList',
    file: 'mal-manga.xml',
    mime: 'application/xml',
    retained: 'Private group',
  },
  { radio: 'VNDB', file: 'vndb.xml', mime: 'application/xml', retained: 'Private note' },
  {
    radio: t.importFormatCsv,
    file: 'novelupdates.csv',
    mime: 'text/csv',
    retained: 'Private fan group',
  },
] as const;

test.use({ actionTimeout: 20_000 });
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`G856 ${viewport.width}: each additional supported tool imports through review and retains its source fields`, async ({
    page,
  }, info) => {
    test.setTimeout(480_000);
    await page.setViewportSize(viewport);
    const account = credentials();
    await signIn(page, '/en/library', account.member);
    await expect(page.getByRole('heading', { name: t.deniedTitle })).toHaveCount(0);
    for (const format of formats) {
      await page.reload();
      const summary = page.getByRole('heading', { name: t.importTitle }).first();
      await expect(async () => {
        await summary.click();
        await expect(summary.locator('xpath=ancestor::details[1]')).toHaveAttribute('open', '');
      }).toPass({ timeout: 30_000 });
      await page.getByRole('radio', { name: format.radio, exact: true }).check();
      const buffer = readFileSync(`tests/fixtures/library-exports/${format.file}`);
      await page
        .locator('#library-import-file')
        .setInputFiles({ name: format.file, mimeType: format.mime, buffer });
      if (format.file === 'novelupdates.csv') {
        const title = page.getByRole('combobox', { name: t.importColTitle, exact: true });
        await expect(title).toBeVisible();
        await title.click();
        await page.getByRole('option', { name: 'Title', exact: true }).click();
        await page.getByRole('button', { name: t.importMapSubmit, exact: true }).click();
      }
      await expect(page.getByRole('button', { name: t.importApply, exact: true })).toBeVisible({
        timeout: 180_000,
      });
      // An ambiguous row needs a reader's choice. Retaining it privately is a
      // valid reviewed outcome; never invent an edition or completion to apply.
      const ambiguity = page.getByRole('button', {
        name: new RegExp(`^${t.importGroupAmbiguous} [1-9]`),
      });
      if (await ambiguity.isVisible()) {
        await ambiguity.click();
        const keep = page
          .locator('[data-group="ambiguous"]')
          .getByRole('button', { name: new RegExp(`^${t.importKeepPrivate}`) });
        while (await keep.count()) await keep.first().click();
      }
      await expect(page.getByRole('button', { name: t.importApply, exact: true })).toBeEnabled();
      await page.getByRole('button', { name: t.importApply, exact: true }).click();
      await expect(
        page.getByText(/^Finished: .* rows added or kept private cleanly\./),
      ).toBeVisible({ timeout: 180_000 });
      const rows = await exportRows(page, account.actingSubject);
      expect(rows.some((row) => JSON.stringify(row.raw).includes(format.retained))).toBe(true);
      await clean(page, info, `format-${format.file}-${viewport.width}`);
    }
  });
}
