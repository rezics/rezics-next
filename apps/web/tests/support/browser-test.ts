import { test as base } from 'playwright/test';
import { protectJourneyBrowser, stopJourneyRoutes } from './network-transport.ts';

export * from 'playwright/test';

export const test = base.extend<{ journeyRoutes: void }>({
  journeyRoutes: [async ({ context, browser }, use) => {
    // Drain Node HTTP callbacks before Playwright ends this test, including the
    // default fixture context and manually created second-device contexts.
    await use();
    await Promise.all([context, ...browser.contexts().filter(item => item !== context)]
      .map(stopJourneyRoutes));
  }, { auto: true }],
  browser: [async ({ browser }, use) => {
    const restore = protectJourneyBrowser(browser);
    try { await use(browser); }
    finally {
      await Promise.all(browser.contexts().map(stopJourneyRoutes));
      restore();
    }
  }, { scope: 'worker' }],
});
