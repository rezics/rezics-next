import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

// A fresh QA stack has no active discovery generation, and may or may not
// have a standing rating question depending on which specs ran first. Earlier
// browser cases may create Works, making a built generation out of date.

const preparedOrListed = /This list is being prepared|Nothing here yet|Couldn’t load/;

test('discover shows shelves by meaning, scope only when chosen, and says honestly when lists are not ready', async ({ page }) => {
  await page.goto('/en/discover');
  await expect(page.getByRole('heading', { level: 1, name: 'Discover' })).toBeVisible();
  const community = page.getByRole('navigation', { name: 'Whose picks' });
  await expect(community.getByRole('link', { name: 'Everyone' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('main')).toContainText(preparedOrListed);
  // The model's words stay out of a reader's page.
  await expect(page.locator('main')).not.toContainText(/Global|Realm|Context/);

  await page.getByRole('navigation', { name: 'Kind of work' }).getByRole('link', { name: 'Recipes' }).click();
  await expect(page).toHaveURL(/\/en\/discover\?type=recipe$/);
  await expect(page.getByRole('region', { name: 'Recipes to try' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recently added' })).toHaveCount(0);

  await community.getByRole('link', { name: 'Your ratings' }).click();
  await expect(page).toHaveURL(/\/en\/discover\?scope=mine&type=recipe$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Your ratings' })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Ratings aren’t open here yet|Sign in to see works you rated/);
});

test('Mine asks a signed-out reader to sign in; bad links and unknown communities are named', async ({ page }) => {
  const context = randomUUID();
  await page.goto(`/en/discover?scope=mine&context=${context}`);
  await expect(page.getByRole('region', { name: 'Works you rated' })).toContainText('Sign in to see works you rated');
  await expect(page.getByRole('link', { name: 'Sign in', exact: true }).first())
    .toHaveAttribute('href', `/auth/start?next=${encodeURIComponent(`/en/discover?scope=mine&context=${context}`)}`);

  await page.goto(`/en/discover?scope=realm&realm=${randomUUID()}`);
  await expect(page.getByRole('heading', { name: 'This community isn’t public or doesn’t exist' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse everything' })).toHaveAttribute('href', '/en/discover');

  await page.goto('/en/discover?type=podcast');
  await expect(page.getByRole('heading', { name: 'This link doesn’t lead anywhere' })).toBeVisible();
});

test('discover fits a phone without horizontal overflow, in English and Chinese, light and dark', async ({ page, context }, info) => {
  for (const [locale, heading] of [['en', 'Discover'], ['zh-Hans', '发现']] as const) {
    for (const theme of ['light', 'dark'] as const) {
      await context.addCookies([{ name: 'rezics_theme', value: theme, url: new URL('/', info.project.use.baseURL).toString() }]);
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await page.goto(`/${locale}/discover`);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        expect(overflow, `${locale} ${theme} ${viewport.width}`).toBe(false);
        await page.screenshot({ path: info.outputPath(`discover-${locale}-${theme}-${viewport.width}.png`), fullPage: true });
      }
    }
  }
});
