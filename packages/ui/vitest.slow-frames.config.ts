import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

const [storybook] = base.test?.projects ?? [];
if (typeof storybook !== 'object' || storybook === null || !('test' in storybook)) {
  throw new Error('vitest.config.ts must define the storybook project first');
}

// The same stories under delayed animation frames. Only the setup file and the test timeout differ.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: [
      {
        ...storybook,
        test: {
          ...storybook.test,
          setupFiles: [fileURLToPath(new URL('./src/test/slow-frames.ts', import.meta.url))],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
