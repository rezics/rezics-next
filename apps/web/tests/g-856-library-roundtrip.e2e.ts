import { expect, test } from '@playwright/test';
import { materializeData } from 'native-i18n';
import { messages } from '../features/library/messages.ts';
import {
  clean,
  credentials,
  exportRows,
  retainedFields,
  signIn,
  writeLibrary,
} from './g-855-library.ts';

// A 1,200-record library, exported as the Library page’s download assembles it, is imported back through the Library page and
// every row is matched and applies without a problem; a new export then holds the same records. The QA
// harness has one web member, so this is the same account: the second-account comparison is G-854's
// integration test (`g-854-large-library`), which this journey drives from the browser.
test.use({ actionTimeout: 20_000 });
const t = materializeData(messages, { locale: 'en' });

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`G856 ${viewport.width}: a downloaded 1,200-record library imports back with the same contents`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    test.setTimeout(280_000);
    const account = credentials();
    await signIn(page, '/en/library', account.member);
    await expect(page.getByRole('heading', { name: t.deniedTitle })).toHaveCount(0);
    await writeLibrary(page, account.actingSubject);
    const before = await exportRows(page, account.actingSubject);
    expect(before.length).toBeGreaterThanOrEqual(1_200);

    // The file the download offers is this bundle; the import page takes it as the REZICS format.
    const summary = page.getByRole('heading', { name: t.importTitle });
    await page.reload();
    await expect(async () => {
      await summary.click();
      await expect(summary.locator('xpath=ancestor::details[1]')).toHaveAttribute('open', '');
    }).toPass({ timeout: 30_000 });
    await page.getByRole('radio', { name: 'REZICS' }).check();
    await page.locator('#library-import-file').setInputFiles({
      name: 'rezics-library.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ profile: 'rezics-library-export-v1', rows: before }) +
          '\n'.repeat(viewport.width === 390 ? 1 : 2),
      ),
    });
    await expect(page.getByRole('button', { name: t.importApply })).toBeEnabled({
      timeout: 150_000,
    });
    await clean(page, info, 'roundtrip-review');
    await page.getByRole('button', { name: t.importApply }).click();
    await expect(page.getByText(/Finished: [\d,]+ of [\d,]+ rows/)).toBeVisible({
      timeout: 240_000,
    });
    await clean(page, info, 'roundtrip-finished');
    expect(retainedFields(await exportRows(page, account.actingSubject))).toEqual(
      retainedFields(before),
    );
  });
}
