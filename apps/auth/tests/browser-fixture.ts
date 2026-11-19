import { expect } from 'bun:test';
import type { Locator, Page } from 'playwright';

export async function navigateToHydratedAuthPage(page: Page, url: string): Promise<void> {
  // A cold Vite client can still be fetching modules when the document commits.
  const response = await page.goto(url, { waitUntil: 'commit' });
  expect(response?.status(), 'the documented dev server serves the page').toBe(200);
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

export function inputByLabel(page: Page, label: string): Locator {
  return page.getByLabel(label, { exact: true }).and(page.locator('input'));
}
