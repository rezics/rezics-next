import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

export default defineConfig({
  // Each concurrent story file holds a headless Chromium renderer (~0.8 GB); several workers' runs at
  // once exhausted a 62 GB host. Cap per-run concurrency; STORYBOOK_MAX_WORKERS raises it on a quiet host.
  test: { maxWorkers: Number(process.env.STORYBOOK_MAX_WORKERS) || 6, projects: [{
    plugins: [storybookTest({ configDir: fileURLToPath(new URL('.storybook', import.meta.url)) })],
    // Interaction stories type and wait like a person; on a host shared with other stacks the 5 s default
    // failed whole stories that pass alone (Give Role With Impact took 5.08 s in a loaded QA run).
    test: { name: 'storybook', testTimeout: 15_000, browser: { enabled: true, headless: true,
      provider: playwright({}), instances: [{ browser: 'chromium' }] } },
  }] },
});
