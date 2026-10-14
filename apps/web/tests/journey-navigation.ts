import type { Page } from '@playwright/test';

/** Host network changes and a pending canonical redirect can interrupt Chromium's document load. */
export async function visitJourney(page: Page, path: string) {
  return navigateJourney(page, path, false);
}

export async function reloadJourney(page: Page, path = page.url()) {
  return navigateJourney(page, path, true);
}

async function navigateJourney(page: Page, path: string, reload: boolean) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = reload && attempt === 0 ? await page.reload() : await page.goto(path);
      if ((response !== null && response.status() !== 503) || attempt === 2) return;
      const seconds = Number(response?.headers()['retry-after']);
      console.log(`[journey navigation] ${response?.url() ?? page.url()}: ${response?.status() ?? 'no document response'}; retry ${attempt + 1}`);
      await page.waitForTimeout(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : 1000);
    }
    catch (error) {
      if (attempt === 2 || !(error instanceof Error)
        || !/net::ERR_NETWORK_CHANGED|net::ERR_ABORTED|another navigation to "chrome-error:\/\//.test(error.message)) throw error;
      await page.waitForTimeout(1000);
    }
  }
}
