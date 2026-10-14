import { expect, type Locator, type Page } from '@playwright/test';
import { type Findings, pressByKeyboard } from '../g-743-matrix.ts';

/** Ark activates its highlighted item; moving DOM focus alone does not choose an option. */
export async function chooseByKeyboard(page: Page, control: Locator, option: Locator, found: Findings) {
  await expect(control).toBeVisible({ timeout: 30_000 });
  await pressByKeyboard(page, control, found, await control.getAttribute('aria-label') ?? 'Choice');
  await expect(option).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Home');
  for (let index = 0; index < 64; index++) {
    if (await option.getAttribute('data-highlighted') !== null) {
      await page.keyboard.press('Enter');
      return;
    }
    await page.keyboard.press('ArrowDown');
  }
  throw new Error('The choice is not reachable with the arrow keys');
}
