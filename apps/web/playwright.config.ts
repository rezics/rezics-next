import { defineConfig, devices } from '@playwright/test';

function e2eBaseURL(): string {
  const configured = process.env.REZICS_WEB_E2E_BASE_URL;
  if (configured) return configured;
  if (process.env.REZICS_QA_RUN_ID) throw new Error('REZICS_WEB_E2E_BASE_URL is required for a QA browser run');
  return 'http://127.0.0.1:3003';
}

export default defineConfig({
  testDir: './tests',
  testMatch: '*.e2e.ts',
  outputDir: '../../.temp/playwright/results',
  use: { ...devices['Desktop Chrome'], baseURL: e2eBaseURL() },
  reporter: 'list',
  workers: 1,
});
