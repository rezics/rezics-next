import { expect, test } from '@playwright/test';
import { isUiLocale } from '../../i18n/define.ts';
import { messages } from '../../features/work-page/messages.ts';
import { bookSynopsis, bookTitle, prepareBook } from '../books-browser-fixture.ts';
import { expectClean, type Findings, pressByKeyboard } from '../g-743-matrix.ts';

export function registerBooksLanguageJourney() {
  for (const [locale, viewport] of [
    ['en', { width: 1440, height: 900 }],
    ['ja', { width: 390, height: 844 }],
  ] as const) {
    test(`books / Read non-UI languages (${locale}): a reader reopens the Swedish synopsis`, async ({ page }, info) => {
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(isUiLocale('sv')).toBe(false);
      const book = await prepareBook(page, locale);
      const findings: Findings = [];
      const t = messages[locale];
      await page.goto(book.href);
      for (const visit of ['first-read', 'reopened'] as const) {
        if (visit === 'reopened') await page.reload();
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        const title = page.getByRole('heading', { level: 1, name: bookTitle, exact: true });
        await expect(title).toBeVisible();
        await expect(title).toHaveAttribute('lang', 'sv');
        const about = page.getByRole('region', { name: t.about, exact: true });
        await expect(about).toBeVisible();
        await pressByKeyboard(page, about.getByRole('button', { name: t.showMore, exact: true }), findings, 'Read full Swedish synopsis');
        await expect(about.getByRole('button', { name: t.showLess, exact: true })).toBeVisible();
        const text = about.locator('[lang="sv"]');
        await expect(text).toHaveText(bookSynopsis);
        await expect(text).toHaveAttribute('dir', 'ltr');
        await page.screenshot({ path: info.outputPath(`swedish-${visit}-${locale}.png`), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      expectClean(findings);
    });
  }
}
