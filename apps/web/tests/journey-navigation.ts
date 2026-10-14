import type { Page } from '@playwright/test';

/** Host network changes and a pending canonical redirect can interrupt Chromium's document load. */
export async function visitJourney(page: Page, path: string) {
  for (let attempt = 0; ; attempt++) {
    try { await page.goto(path); return; }
    catch (error) {
      if (attempt === 2 || !(error instanceof Error)
        || !/net::ERR_NETWORK_CHANGED|net::ERR_ABORTED|another navigation to "chrome-error:\/\//.test(error.message)) throw error;
      await page.waitForTimeout(1000);
    }
  }
}
