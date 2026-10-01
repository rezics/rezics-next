import { expect, test } from '@playwright/test';
import { uiLocales } from '../../src/i18n/locales.ts';
import { catalogs } from '../../src/i18n/messages/index.ts';
import { policies } from '../../src/legal/policies.ts';
import { axeViolations, formatViolations } from './axe.ts';

const viewports = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
} as const;

// The built site is a development build here, so every page carries the draft banner.
for (const [name, viewport] of Object.entries(viewports)) {
  test(`every policy renders in every locale at ${name} width, readable and accessible`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const problems: string[] = [];
    for (const locale of uiLocales) {
      for (const { slug } of policies) {
        const path = `/${locale}/legal/${slug}/`;
        await page.goto(path);
        const title = catalogs.legal[locale].names[slug];
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
        await expect(page.locator('[data-draft-banner]')).toBeVisible();
        await expect(page.locator('[data-english-governs]')).toHaveCount(locale === 'en' ? 0 : 1);
        await expect(page.locator('article h2').first()).toBeVisible();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (overflow > 0) problems.push(`${path}: ${overflow}px horizontal overflow`);
        const violations = await axeViolations(page);
        if (violations.length) problems.push(`${path}\n${formatViolations(violations)}`);
      }
    }
    expect(problems.join('\n')).toBe('');
  });
}

test('the footer lists every policy in the reader’s language and the links stay in the locale', async ({
  page,
}) => {
  for (const locale of ['en', 'ja'] as const) {
    await page.goto(`/${locale}/`);
    const nav = page.getByRole('navigation', { name: catalogs.legal[locale].heading });
    await expect(nav.getByRole('link')).toHaveCount(policies.length);
    await nav.getByRole('link', { name: catalogs.legal[locale].names.terms }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/legal/terms/$`));
  }
});

test('policies link to each other inside the current locale', async ({ page }) => {
  await page.goto('/de/legal/terms/');
  const hrefs = await page
    .locator('article a[href^="/"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) expect(href).toMatch(/^\/de\/legal\/[a-z-]+\/(#.*)?$/);
});
