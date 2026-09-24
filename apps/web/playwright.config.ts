import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '*.e2e.ts',
  outputDir: '../../.temp/playwright/results',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3003' },
  reporter: 'list',
  workers: 1,
});
