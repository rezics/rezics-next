import { afterEach, type TestContext } from 'vitest';
import { commands } from 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    captureStoryScreenshot: (exportName: string) => Promise<void>;
  }
}

/** A dialog caught mid-fade reads as a defect and differs between runs. Let running animations and
 * transitions end before the capture, for at most a second; an endless one (a spinner) keeps running. */
async function settleAnimations(limitMs = 1_000): Promise<void> {
  const finite = document.getAnimations().filter(animation =>
    animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity);
  await Promise.race([
    Promise.allSettled(finite.map(animation => animation.finished)),
    new Promise(resolve => setTimeout(resolve, limitMs)),
  ]);
  await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
}

afterEach(async (context: TestContext) => {
  // addon-vitest's composed story retains the CSF export name even with a custom display name.
  const story = (context as TestContext & { story?: { storyName: string } }).story;
  if (!story) return;
  try {
    await settleAnimations();
    await commands.captureStoryScreenshot(story.storyName);
  } catch (error) {
    // RPC/provider errors are optional evidence failures too, never assertion failures.
    console.warn(`Warning: story screenshot ${story.storyName}: ${String(error).replaceAll(/[\r\n]+/g, ' ')}`);
  }
});
