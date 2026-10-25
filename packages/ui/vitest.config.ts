import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    maxWorkers: Number(process.env.STORYBOOK_MAX_WORKERS) || 4,
    projects: [
      {
        plugins: [storybookTest({ configDir: fileURLToPath(new URL('./.storybook', import.meta.url)) })],
        test: {
          name: 'storybook',
          testTimeout: 30_000,
          hookTimeout: 60_000,
          env: { VITEST_BROWSER_IFRAME_TIMEOUT: '180000' },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({ launchOptions: { args: ['--disable-dev-shm-usage'] } }),
            instances: [{ browser: 'chromium' }],
            context: { reducedMotion: 'reduce' },
          },
        },
      },
    ],
  },
});
