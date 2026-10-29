import type { Page } from 'playwright';

/** Open the signed-in account menu through its trigger in either responsive layout. */
export async function openAccountMenu(page: Page) {
  const menu = page.locator('#account-menu');
  if (!(await menu.isVisible())) await page.locator('#account-menu-button').click({ timeout: 120_000 });
  await menu.waitFor({ state: 'visible' });
  return menu;
}

/** Dismiss the menu and wait for its portal content to unmount. */
export async function closeAccountMenu(page: Page): Promise<void> {
  const menu = page.locator('#account-menu');
  if (await menu.count()) await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
}
