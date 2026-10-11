import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { BrowserCommand } from 'vitest/node';
import type { Page } from 'playwright';
import type {} from '@vitest/browser-playwright';

export const STORY_SCREENSHOTS_ENV = 'REZICS_STORY_SCREENSHOTS_DIR';

/** Export names, unlike display titles or story IDs, preserve the authored story identity. */
export function storyScreenshotPath(repositoryRoot: string, testFile: string, exportName: string): string {
  const root = resolve(repositoryRoot.replaceAll('\\', '/'));
  const file = relative(root, resolve(root, testFile.replaceAll('\\', '/'))).replaceAll('\\', '/');
  if (!file || file === '..' || file.startsWith('../') || isAbsolute(file)) {
    throw new Error('Story screenshot file must be inside the checkout');
  }
  if (!/^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u.test(exportName)) {
    throw new Error('Story screenshot requires a story export name');
  }
  return join(file.replaceAll('/', '-'), `${exportName}.png`);
}

/** Capture is evidence for human review; a filesystem or browser failure cannot fail the story. */
export async function captureStoryScreenshot(
  directory: string,
  repositoryRoot: string,
  context: { testPath?: string; page: Pick<Page, 'screenshot'> },
  exportName: string,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  try {
    if (!context.testPath) throw new Error('Story test has no file path');
    const path = join(directory, storyScreenshotPath(repositoryRoot, context.testPath, exportName));
    await mkdir(dirname(path), { recursive: true });
    // The provider page follows the story viewport. CSS pixels keep phone captures at 390 px
    // even if the browser context uses a higher device scale; never stitch the whole document.
    await context.page.screenshot({ path, type: 'png', fullPage: false, scale: 'css', timeout: 5_000 });
  } catch (error) {
    warn(`Warning: story screenshot ${exportName}: ${String(error).replaceAll(/[\r\n]+/g, ' ')}`);
  }
}

export function storyScreenshotCommand(directory: string, repositoryRoot: string): BrowserCommand<[string]> {
  return (context, exportName) => captureStoryScreenshot(directory, repositoryRoot, context, exportName);
}
