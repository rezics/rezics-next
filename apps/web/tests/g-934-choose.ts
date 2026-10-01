import type { Locator, Page } from '@playwright/test';

/** Opens a styled select inside `scope` and picks an option; its list is portalled, so options are found on the page. */
export async function chooseOption(scope: Locator | Page, page: Page, name: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
