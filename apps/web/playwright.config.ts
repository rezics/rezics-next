import { defineConfig, devices } from '@playwright/test';

function e2eBaseURL(): string {
  const configured = process.env.REZICS_WEB_E2E_BASE_URL;
  if (configured) return configured;
  if (process.env.REZICS_QA_RUN_ID) throw new Error('REZICS_WEB_E2E_BASE_URL is required for a QA browser run');
  return 'http://127.0.0.1:3003';
}

// The launch journeys (G-743) also run on phones: Chromium with Android emulation and WebKit with iPhone emulation.
// They are opt-in so the rest of the e2e files keep running once, on Desktop Chrome:
//   REZICS_E2E_PROJECTS=desktop-chrome,chromium-mobile,webkit-mobile   (or `all`)
// WebKit is not installed by default; on a host without it, `PLAYWRIGHT_BROWSERS_PATH` names a directory that
// holds `playwright install webkit` (docs/development/launch-accessibility.md).
const journeys = /g-743-[\w-]+\.e2e\.ts$/;
const available = {
  'desktop-chrome': { use: devices['Desktop Chrome'] },
  'chromium-mobile': { use: devices['Pixel 7'], testMatch: journeys },
  'webkit-mobile': { use: devices['iPhone 15'], testMatch: journeys },
};
const requested = process.env.REZICS_E2E_PROJECTS?.trim() || 'desktop-chrome';
const chosen = requested === 'all' ? Object.keys(available) : requested.split(',').map(name => name.trim());
for (const name of chosen) if (!(name in available)) throw new Error(`Unknown REZICS_E2E_PROJECTS entry: ${name}`);

export default defineConfig({
  testDir: './tests',
  testMatch: '*.e2e.ts',
  grep: process.env.REZICS_E2E_GREP ? new RegExp(process.env.REZICS_E2E_GREP) : undefined,
  outputDir: '../../.temp/playwright/results',
  use: { baseURL: e2eBaseURL() },
  projects: chosen.map(name => ({ name, ...available[name as keyof typeof available] })),
  reporter: 'list',
  workers: 1,
});
