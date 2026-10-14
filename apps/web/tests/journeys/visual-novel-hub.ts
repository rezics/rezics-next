import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect as playwrightExpect, test } from '@playwright/test';
import { resourceHref } from '../../features/address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInAtAccounts } from '../account-sign-in.ts';
import { expectClean, type Findings, pressByKeyboard } from '../g-743-matrix.ts';
import type { VisualNovelHubFixture } from '../visual-novel-hub-seed.ts';
import { chooseByKeyboard } from './keyboard-choice.ts';

const expect = playwrightExpect.configure({ timeout: 30_000 });

export function registerVisualNovelHubJourney() {
  test.use({ actionTimeout: 15_000 });

for (const locale of ['en', 'ja'] as const) {
  test(`visual-novel-hub / ${locale}: a player chooses a release by keyboard and returns to the saved edition`, async ({ page }, info) => {
    test.setTimeout(180_000);
    const fixture = JSON.parse(readFileSync(resolve('.temp/visual-novel-hub', process.env.REZICS_QA_RUN_ID!, 'seed.json'), 'utf8')) as VisualNovelHubFixture;
    const at = localizedPath(resourceHref('/w/', fixture.work.slice(-36)), locale);
    const { member } = JSON.parse(readFileSync(process.env.REZICS_WEB_AUTH_PRIVATE_PATH!, 'utf8')) as { member: { email: string; password: string } };
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signInAtAccounts(page, localizedPath(resourceHref('/w/', fixture.work.slice(-36)), 'en'), member);
    if (locale !== 'en') await page.goto(at);
    const found: Findings = [];
    const t = locale === 'en'
      ? { availability: 'Your edition and availability', language: 'Language', english: 'English', edition: 'Edition', save: 'Save choice', saved: 'Saved.', line: 'Your edition:', retry: 'Try again' }
      : { availability: 'あなたの版と入手状況', language: '言語', english: '英語', edition: '版', save: '選択を保存', saved: '保存しました。', line: 'あなたの版：', retry: 'もう一度試す' };
    try {
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { level: 1, name: fixture.title, exact: true })).toBeVisible();
      const availability = page.getByRole('region', { name: t.availability, exact: true });
      await expect(availability).toContainText('Windows');
      await expect(availability).toContainText('Linux');
      const language = availability.getByRole('combobox', { name: t.language, exact: true });
      await chooseByKeyboard(page, language, page.getByRole('option', { name: t.english, exact: true }), found);
      // Choose both alternatives so a pre-existing preference cannot make this a no-op.
      for (const release of fixture.releases) {
        // A temporarily unavailable inventory offers an explicit retry; do not treat the preview's releases as loaded choices.
        const offered = availability.locator('select option').filter({ hasText: release.title });
        await expect(async () => {
          const retry = availability.getByRole('button', { name: t.retry, exact: true });
          if (await offered.count() === 0 && await retry.isVisible() && await retry.isEnabled())
            await pressByKeyboard(page, retry, found, t.retry);
          await expect(offered).toHaveCount(1, { timeout: 2_000 });
        }).toPass({ timeout: 45_000, intervals: [1_000, 2_000] });
        const edition = availability.getByRole('combobox', { name: t.edition, exact: true });
        await chooseByKeyboard(page, edition, page.getByRole('option', { name: new RegExp(`^${release.title} ·`) }), found);
        await expect(edition).toContainText(release.title);
        await pressByKeyboard(page, availability.getByRole('button', { name: t.save, exact: true }), found, t.save);
        await expect(availability.getByRole('status')).toHaveText(t.saved);
        await page.waitForLoadState('networkidle');
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(availability.getByRole('combobox', { name: t.language, exact: true })).toHaveText(t.english);
        await expect(availability.getByRole('combobox', { name: t.edition, exact: true })).toContainText(release.title);
        await expect(page.locator('[data-identity-status]:visible').first()).toContainText(t.line);
        await expect(page.locator('[data-identity-status]:visible').first()).toContainText(release.title);
      }
      await page.screenshot({ path: info.outputPath(`visual-novel-edition-${locale}.png`), fullPage: true });
      expectClean(found);
    } finally {
      await page.close();
    }
  });
}
}
