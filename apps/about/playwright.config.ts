import { defineConfig, devices } from '@playwright/test';

// Journeys run against the built site served by its own Worker (wrangler dev) with a
// throwaway local D1 under .temp: `task about:e2e` builds first, then Playwright starts it.
const port = Number(process.env.ABOUT_E2E_PORT ?? 4322);
const state = '../../.temp/about-e2e-state';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['*.e2e.ts'],
  outputDir: '../../.temp/playwright/about-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${port}` },
  reporter: 'list',
  workers: 4,
  webServer: {
    command: `sh -c "rm -rf ${state} && ../../node_modules/.bin/wrangler d1 migrations apply DB --local --persist-to ${state} && exec ../../node_modules/.bin/wrangler dev --ip 127.0.0.1 --port ${port} --persist-to ${state}"`,
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}/en/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
