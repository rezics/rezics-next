import { afterEach, type TestContext } from 'vitest';
import { commands } from 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    captureStoryScreenshot: (exportName: string) => Promise<void>;
  }
}

afterEach(async (context: TestContext) => {
  // addon-vitest's composed story retains the CSF export name even with a custom display name.
  const story = (context as TestContext & { story?: { storyName: string } }).story;
  if (!story) return;
  try {
    await commands.captureStoryScreenshot(story.storyName);
  } catch (error) {
    // RPC/provider errors are optional evidence failures too, never assertion failures.
    console.warn(`Warning: story screenshot ${story.storyName}: ${String(error).replaceAll(/[\r\n]+/g, ' ')}`);
  }
});
