import { expect } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Locator, Page } from 'playwright';
import type { BookCatalogueType } from './book-catalogue-journey-fixture.ts';

export async function pageReady(page: Page, stageName: string): Promise<void> {
  page.setDefaultTimeout(45_000);
  try {
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  } catch (error) {
    const body = await page
      .locator('body')
      .innerText()
      .catch(() => 'body unavailable');
    throw new Error(`${stageName}: page did not hydrate at ${page.url()}; body=${body.slice(0, 500)}`, {
      cause: error,
    });
  }
}

export function exactType(address: string): string | null {
  return new URL(address).searchParams.get('type');
}

export function problemCode(body: unknown): string | undefined {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return;
    }
  }
  if (body === null || typeof body !== 'object' || !('code' in body)) return;
  return typeof body.code === 'string' && /^[a-z0-9_]{1,64}$/u.test(body.code) ? body.code : undefined;
}

export async function openNewTabFromLink(
  page: Page,
  link: Locator,
  label: string,
  onOpen?: (popup: Page) => void,
): Promise<Page> {
  const [opened] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  onOpen?.(opened);
  await opened.waitForLoadState('domcontentloaded');
  await pageReady(opened, label);
  return opened;
}

export async function assertShelfPage(page: Page, type: BookCatalogueType): Promise<void> {
  expect(new URL(page.url()).pathname).toBe('/en/library');
  expect(exactType(page.url())).toBe(type);
  await browserExpect(page.getByRole('main')).toBeVisible();
}
