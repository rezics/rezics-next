import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./.storybook/cloudflare-workers.ts', import.meta.url)),
      '@tanstack/react-start': fileURLToPath(new URL('./.storybook/react-start.ts', import.meta.url)),
    },
  },
  test: {
    maxWorkers: Number(process.env.STORYBOOK_MAX_WORKERS) || 4,
    projects: [390, 1280].map((width) => ({
      plugins: [storybookTest({ configDir: fileURLToPath(new URL('./.storybook', import.meta.url)) })],
      test: {
        name: width === 390 ? 'storybook-phone' : 'storybook-desktop',
        testTimeout: 30_000,
        hookTimeout: 60_000,
        env: { VITEST_BROWSER_IFRAME_TIMEOUT: '180000' },
        browser: {
          enabled: true,
          headless: true,
          viewport: { width, height: width === 390 ? 844 : 900 },
          provider: playwright({ launchOptions: { args: ['--disable-dev-shm-usage'] } }),
          instances: [{ browser: 'chromium' }],
        },
      },
    })),
  },
});
