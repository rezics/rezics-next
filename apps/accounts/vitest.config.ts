import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

export default defineConfig({
  // Each concurrent story file holds a headless Chromium renderer (~0.8 GB); cap per-run
  // concurrency as the web config does. STORYBOOK_MAX_WORKERS raises it on a quiet host.
  test: { maxWorkers: Number(process.env.STORYBOOK_MAX_WORKERS) || 6, projects: [{
    plugins: [storybookTest({ configDir: fileURLToPath(new URL('.storybook', import.meta.url)) })],
    test: { name: 'storybook', browser: { enabled: true, headless: true,
      // Stories assert states, not transitions: with reduced motion (which Rezics
      // UI honours) a field error or dialog is complete when it appears.
      provider: playwright({ contextOptions: { reducedMotion: 'reduce' } }), instances: [{ browser: 'chromium' }] } },
  }] },
});
