import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { storyBrowser } from '../../scripts/qa/story-browser.ts';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { STORY_SCREENSHOTS_ENV, storyScreenshotCommand } from '../../scripts/qa/story-screenshots.ts';

const screenshotDirectory = process.env[STORY_SCREENSHOTS_ENV];
const screenshotSetup = screenshotDirectory ? {
  setupFiles: [fileURLToPath(new URL('.storybook/story-screenshots.setup.ts', import.meta.url))],
} : {};
const accessibilitySetup = fileURLToPath(new URL('../../scripts/qa/story-accessibility.setup.ts', import.meta.url));
const screenshotCommands = screenshotDirectory ? {
  commands: { captureStoryScreenshot: storyScreenshotCommand(screenshotDirectory, fileURLToPath(new URL('../..', import.meta.url))) },
} : {};

const storybookHeaders = fileURLToPath(new URL('.storybook/next-headers.ts', import.meta.url));
const storybookNet = fileURLToPath(new URL('.storybook/node-net.ts', import.meta.url));

export default defineConfig({
  // Each concurrent story file holds a headless Chromium renderer (~0.8 GB); several workers' runs at
  // once exhausted a 62 GB host. Cap per-run concurrency; STORYBOOK_MAX_WORKERS raises it on a quiet host.
  test: { maxWorkers: Number(process.env.STORYBOOK_MAX_WORKERS) || 6, projects: [{
    plugins: [storybookTest({ configDir: fileURLToPath(new URL('.storybook', import.meta.url)) })],
    // addon-vitest applies viteFinal to `{ root }` and does not load `.storybook/vite.config.ts`.
    // A story that imports a production reader otherwise receives Next's server `headers` bundle.
    resolve: { alias: [
      { find: /^next\/headers$/, replacement: storybookHeaders },
      { find: 'node:net', replacement: storybookNet },
    ] },
    // Interaction stories type and wait like a person; on a host shared with other stacks the 5 s default
    // failed whole stories that pass alone (Give Role With Impact took 5.08 s in a loaded QA run).
    test: { name: 'storybook', setupFiles: [accessibilitySetup, ...(screenshotSetup.setupFiles ?? [])], testTimeout: 15_000,
      // Vitest's iframe readiness timer is separate from testTimeout and browser.connectTimeout.
      // Cold transforms on a host running other QA stacks can exceed its 60 s default.
      env: { VITEST_BROWSER_IFRAME_TIMEOUT: '180000' },
      browser: { enabled: true, headless: true,
      ...screenshotCommands,
      provider: storyBrowser(), instances: [{ browser: 'chromium' }] } },
  }] },
});
