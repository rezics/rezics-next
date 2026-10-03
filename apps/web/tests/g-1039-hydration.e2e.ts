import { expect, test } from '@playwright/test';
import { browseMessages } from '../features/discover/browse-messages.ts';

for (const locale of ['en', 'zh-Hant'] as const) {
  for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
    test(`G1039: ${locale} ${viewport.width} Discover click straddles hydration`, async ({ page }) => {
      await page.setViewportSize(viewport);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = 0;
      await page.route('**/*', async (route) => {
        if (route.request().resourceType() === 'script') { held++; await gate; }
        await route.continue();
      });
      try {
        await page.goto(`/${locale}/discover`, { waitUntil: 'commit' });
        const t = browseMessages[locale];
        const works = page.getByRole('navigation', { name: t.type, exact: true })
          .getByRole('link', { name: t.works, exact: true });
        await expect(works).toHaveAttribute('href', `/${locale}/discover?tab=works`);
        await expect.poll(() => held).toBeGreaterThan(0);
        await works.hover();
        await page.mouse.down();
        release();
        // A React event prop on the anchor proves this boundary has hydrated.
        await expect.poll(() => works.evaluate((node) => Object.keys(node)
          .some((key) => key.startsWith('__reactProps$')))).toBe(true);
        // Let passive effects run before releasing the same physical gesture.
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await page.mouse.up();
        await expect(page).toHaveURL(new RegExp(`/${locale}/discover\\?tab=works$`));
        await expect(works).toHaveAttribute('aria-current', 'page');
        // A click immediately after the first hydrated navigation also works.
        const sites = page.getByRole('navigation', { name: t.type, exact: true })
          .getByRole('link', { name: t.sites, exact: true });
        await sites.click();
        await expect(page).toHaveURL(new RegExp(`/${locale}/discover\\?tab=sites$`));
        await expect(sites).toHaveAttribute('aria-current', 'page');
      } finally { release(); }
    });
  }
}
