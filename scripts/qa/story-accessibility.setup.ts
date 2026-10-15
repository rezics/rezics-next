import { afterEach, expect, type TestContext } from 'vitest';
import { page } from 'vitest/browser';
import { accessibilityViewports } from './accessibility.ts';
import { storyAccessibilityViolations } from './story-accessibility.ts';

/** Scan the final state of every story, including its completed interactions and open portals.
 * Story-local addon settings cannot turn off this launch gate. Keep the existing addon for its
 * interactive reports; this sweep also checks responsive states absent from the story's globals. */
afterEach(async (context: TestContext) => {
  const story = (context as TestContext & { story?: { id: string } }).story;
  if (!story || context.task.result?.state === 'fail') return;
  const root = document.documentElement;
  const classes = root.className;
  const colorScheme = root.style.colorScheme;
  const viewport = { width: innerWidth, height: innerHeight };
  const scroll = { x: scrollX, y: scrollY };
  const failures: string[] = [];
  // axe temporarily changes input styles to measure placeholders. Color transitions can make
  // that measurement read an intermediate color even after the theme itself has settled.
  const settled = document.createElement('style');
  settled.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }';
  document.head.append(settled);
  try {
    await document.fonts.ready;
    for (const theme of ['light', 'dark']) {
      root.classList.remove('light', 'dark');
      root.classList.add(theme);
      root.style.colorScheme = theme;
      for (const [size, dimensions] of Object.entries(accessibilityViewports)) {
        await page.viewport(dimensions.width, dimensions.height);
        // Interaction stories can end scrolled to their last control. A target half outside
        // the viewport is not an undersized control; audit the page from its normal opening.
        window.scrollTo(0, 0);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.race([
          Promise.allSettled(document.getAnimations().filter(animation =>
            animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)),
          new Promise(resolve => setTimeout(resolve, 1_000)),
        ]);
        // Match the addon's context: portals outside the canvas are part of the page too.
        const violations = await storyAccessibilityViolations({
          include: ['body'], exclude: ['#storybook-docs', '#storybook-highlights-root', '.sb-wrapper'],
        });
        for (const violation of violations) {
          failures.push(`${story.id} (${root.lang}, ${theme}, ${size}) ${violation.id} (${violation.impact}): ${violation.help}\n${
            violation.nodes.map(node => `  ${node.target.join(' ')}\n  ${node.html}\n  ${node.failureSummary ?? ''}`).join('\n')}`);
        }
      }
    }
  } finally {
    root.className = classes;
    root.style.colorScheme = colorScheme;
    await page.viewport(viewport.width, viewport.height);
    window.scrollTo(scroll.x, scroll.y);
    settled.remove();
  }
  expect(failures, failures.join('\n\n')).toEqual([]);
}, 60_000);
