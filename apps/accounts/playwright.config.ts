import { defineConfig, devices } from '@playwright/test';

// Journeys run against a live Accounts app: `task dev -- --backend` in a
// worktree prints its URL; the main checkout serves it on 3004.
export default defineConfig({
  testDir: './tests',
  testMatch: '*.e2e.ts',
  outputDir: '../../.temp/playwright/accounts-results',
  timeout: 120_000,
  // Dev servers render on first request; allow them to compile a page.
  expect: { timeout: 20_000 },
  use: { ...devices['Desktop Chrome'], baseURL: process.env.ACCOUNTS_URL ?? 'http://127.0.0.1:3004' },
  reporter: 'list',
  workers: 1,
});
