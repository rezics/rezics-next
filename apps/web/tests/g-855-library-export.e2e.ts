import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { materializeData } from 'native-i18n';
import { messages } from '../features/library/messages.ts';
import { clean, credentials, signIn, writeLibrary } from './g-855-library.ts';

// "Download your library" in a real browser on a fresh QA stack: a library of 1,200 records (beyond every
// page bound) is downloaded with a reload in the middle, resumed from where it stopped, and the saved file
// is a complete `rezics-library-export-v1` bundle. The round trip back in is `g-855-library-roundtrip.e2e.ts`.
test.use({ actionTimeout: 20_000 });
const t = materializeData(messages, { locale: 'en' });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}: a download interrupted by a reload resumes where it stopped and saves one complete file`, async ({ page }, info) => {
    test.setTimeout(240_000);
    const account = credentials();
    await page.setViewportSize(viewport);
    await signIn(page, '/en/library', account.member);
    if (await page.getByRole('heading', { name: t.deniedTitle }).isVisible()) return;
    await writeLibrary(page, account.actingSubject);

    // Slow each page a little, so the reload lands in the middle of the download.
    await page.route('**/v1/me/library-export?**', async route => { await new Promise(done => setTimeout(done, 120)); await route.continue(); });
    await page.reload();
    const summary = page.getByRole('heading', { name: t.backupTitle });
    await expect(async () => {
      await summary.click();
      await expect(summary.locator('xpath=ancestor::details[1]')).toHaveAttribute('open', '');
    }).toPass({ timeout: 30_000 });
    await expect(page.getByText(t.backupContains)).toBeVisible();
    await expect(page.getByText(t.backupNever)).toBeVisible();
    await clean(page, info, `export-idle-${viewport.width}`);
    await page.getByRole('button', { name: t.backupStart }).click();
    await expect(page.getByText(/Collected [4-9]\d records/)).toBeVisible({ timeout: 120_000 });
    await page.reload();
    await expect(async () => {
      await summary.click();
      await expect(summary.locator('xpath=ancestor::details[1]')).toHaveAttribute('open', '');
    }).toPass({ timeout: 30_000 });
    const paused = page.getByText(/The download stopped after (\d+) records/);
    await expect(paused).toBeVisible();
    expect(Number((await paused.textContent())!.match(/after (\d+) records/)![1])).toBeGreaterThanOrEqual(40);
    await clean(page, info, `export-paused-${viewport.width}`);
    await page.getByRole('button', { name: t.backupResume }).click();
    const ready = page.getByText(/Your file is ready: ([\d,]+) records/);
    await expect(ready).toBeVisible({ timeout: 180_000 });
    const records = Number((await ready.textContent())!.match(/ready: ([\d,]+) records/)![1].replaceAll(',', ''));
    expect(records).toBeGreaterThanOrEqual(1_200);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: t.backupSave }).click();
    const file = await (await download).path();
    const bundle = JSON.parse(readFileSync(file!, 'utf8')) as { profile: string; rows: Array<Record<string, unknown>> };
    expect(bundle.profile).toBe('rezics-library-export-v1');
    expect(bundle.rows).toHaveLength(records);
    expect(bundle.rows.filter(row => row.kind === 'retained').length).toBeGreaterThanOrEqual(1_200);
    await clean(page, info, `export-ready-${viewport.width}`);
  });
}
