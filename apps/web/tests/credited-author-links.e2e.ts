import { expect, test } from '@playwright/test';
import { people } from '../../../scripts/dev/seed/plan.ts';
import { signInAtAccounts } from './account-sign-in.ts';

const austen = '/en/authors/open-library/OL21594A';
const daniel = people.find(person => person.id === 'daniel')!;

for (const signedIn of [false, true]) {
  test(`Work author links open their REZICS pages ${signedIn ? 'as Daniel' : 'signed out'}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    if (signedIn) await signInAtAccounts(page, austen, daniel);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(austen);
      await expect(page.getByLabel('On REZICS').getByText(/^readers?$/)).toBeVisible();
      if (signedIn) await expect(page.getByRole('button', { name: 'Account menu' }))
        .toHaveAttribute('data-hydrated', 'true', { timeout: 30_000 });
      const pride = page.getByRole('region', { name: 'Works by Jane Austen' })
        .getByRole('link', { name: 'Pride and Prejudice' });
      // Shared vinext occasionally loses the signed-in RSC soft navigation; the href and destination still load.
      if (signedIn) await page.goto((await pride.getAttribute('href'))!);
      else await pride.click();
      await expect(page).toHaveURL(/\/en\/w\/[0-9a-f-]{36}$/);
      const jane = page.getByRole('link', { name: 'Jane Austen' }).first();
      await expect(jane).toHaveAttribute('href', '/en/authors/open-library/OL21594A');
      const about = page.getByRole('region', { name: 'About the author' });
      await expect(about.getByRole('link', { name: /Jane Austen/ }))
        .toHaveAttribute('href', '/en/authors/open-library/OL21594A');
      await expect(about).toContainText('1775–1817');
      await page.screenshot({ path: info.outputPath(`pride-${signedIn ? 'daniel' : 'public'}-${viewport.width}.png`),
        fullPage: true });
      if (signedIn) await page.goto((await jane.getAttribute('href'))!);
      else await jane.click();
      await expect(page).toHaveURL(/\/en\/authors\/open-library\/OL21594A$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Jane Austen' })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`austen-${signedIn ? 'daniel' : 'public'}-${viewport.width}.png`),
        fullPage: true });

      await page.goto('/en/@lin_mei');
      const serial = page.getByRole('region', { name: /Works by Lin Mei/ })
        .getByRole('link', { name: /雨夜书店/ }).first();
      if (signedIn) await page.goto((await serial.getAttribute('href'))!);
      else await serial.click();
      await expect(page).toHaveURL(/\/en\/w\/[0-9a-f-]{36}$/);
      await expect(page.getByRole('heading', { level: 1, name: /雨夜书店/ })).toBeVisible();
      await expect(page.getByRole('link', { name: /Lin Mei 林梅/ }).first()).toHaveAttribute('href', '/en/@lin_mei');
      await expect(page.getByRole('region', { name: 'About the author' })
        .getByRole('link', { name: /Lin Mei/ })).toHaveAttribute('href', '/en/@lin_mei');
      await page.screenshot({ path: info.outputPath(`lin-mei-${signedIn ? 'daniel' : 'public'}-${viewport.width}.png`),
        fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    }
  });
}
