import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { storyBrowser } from '../../scripts/qa/story-browser.ts';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { STORY_SCREENSHOTS_ENV, storyScreenshotCommand } from '../../scripts/qa/story-screenshots.ts';

const screenshotDirectory = process.env[STORY_SCREENSHOTS_ENV];
const screenshotSetup = screenshotDirectory ? {
  setupFiles: [fileURLToPath(new URL('../web/.storybook/story-screenshots.setup.ts', import.meta.url))],
} : {};
const accessibilitySetup = fileURLToPath(new URL('../../scripts/qa/story-accessibility.setup.ts', import.meta.url));
const screenshotCommands = screenshotDirectory ? {
  commands: { captureStoryScreenshot: storyScreenshotCommand(screenshotDirectory, fileURLToPath(new URL('../..', import.meta.url))) },
} : {};

export default defineConfig({
  // Each concurrent story file holds a headless Chromium renderer (~0.8 GB); cap per-run
  // concurrency as the web config does. STORYBOOK_MAX_WORKERS raises it on a quiet host.
  test: { maxWorkers: Number(process.env.STORYBOOK_MAX_WORKERS) || 6, projects: [{
    plugins: [storybookTest({ configDir: fileURLToPath(new URL('.storybook', import.meta.url)) })],
    test: { name: 'storybook', setupFiles: [accessibilitySetup, ...(screenshotSetup.setupFiles ?? [])], browser: { enabled: true, headless: true,
      ...screenshotCommands,
      // Stories assert states, not transitions: with reduced motion (which Rezics
      // UI honours) a field error or dialog is complete when it appears.
      provider: storyBrowser({ contextOptions: { reducedMotion: 'reduce' } }), instances: [{ browser: 'chromium' }] } },
  }] },
});
