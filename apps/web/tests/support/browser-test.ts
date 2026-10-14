import { test as base } from 'playwright/test';
import { protectJourneyBrowser } from './network-transport.ts';

export * from 'playwright/test';

export const test = base.extend({
  browser: [async ({ browser, browserName }, use) => {
    const origin = process.env.REZICS_WEB_E2E_BASE_URL ?? 'http://127.0.0.1:3003';
    const restore = browserName === 'chromium' ? protectJourneyBrowser(browser, new URL(origin).origin) : () => {};
    try { await use(browser); }
    finally { restore(); }
  }, { scope: 'worker' }],
});
