import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { captureStoryScreenshot, storyScreenshotPath } from './story-screenshots.ts';

const root = resolve(import.meta.dir, '../..');
const temporary = join(root, '.temp');
const directories: string[] = [];

function directory(): string {
  mkdirSync(temporary, { recursive: true });
  const path = mkdtempSync(join(temporary, 'story-screenshots-'));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('screenshot paths preserve source file and exact export identity across workspaces', () => {
  for (const file of [
    'apps/web/features/auth/consent-recovery.stories.tsx',
    'apps/accounts/features/shell/user-avatar.stories.tsx',
    'packages/ui/src/components/badge.stories.tsx',
  ]) {
    const expected = join(file.replaceAll('/', '-'), 'ChinesePhone.png');
    expect(storyScreenshotPath(root, file, 'ChinesePhone')).toBe(expected);
    expect(storyScreenshotPath(root, resolve(root, file), 'ChinesePhone')).toBe(expected);
    expect(storyScreenshotPath(root, file.replaceAll('/', '\\'), 'ChinesePhone')).toBe(expected);
  }
  expect(storyScreenshotPath(root, 'apps/web/example.stories.tsx', '$Story_2'))
    .toBe(join('apps-web-example.stories.tsx', '$Story_2.png'));
});

test('screenshot paths reject source and export traversal', () => {
  expect(() => storyScreenshotPath(root, '../outside.stories.tsx', 'Default')).toThrow('inside the checkout');
  for (const name of ['../Default', 'A/B', '..', 'Display title']) {
    expect(() => storyScreenshotPath(root, 'apps/web/example.stories.tsx', name)).toThrow('export name');
  }
});

test('capture writes only the viewport and overwrites the same story path on another run', async () => {
  const screenshots = directory();
  const file = 'apps/web/example.stories.tsx';
  const warnings: string[] = [];
  let captures = 0;
  const page = { screenshot: async (options?: Parameters<import('playwright').Page['screenshot']>[0]) => {
    expect(options).toMatchObject({ type: 'png', fullPage: false, scale: 'css' });
    writeFileSync(options!.path!, `capture ${++captures}`);
    return Buffer.from('png');
  } };
  for (let run = 1; run <= 2; run++) {
    await captureStoryScreenshot(screenshots, root, { testPath: resolve(root, file), page }, 'Mobile', line => warnings.push(line));
    expect(readFileSync(join(screenshots, storyScreenshotPath(root, file, 'Mobile')), 'utf8')).toBe(`capture ${run}`);
  }
  expect(warnings).toEqual([]);
});

test('browser, filesystem and missing-context capture failures warn without rejecting', async () => {
  const screenshots = directory();
  const warnings: string[] = [];
  const page = { screenshot: async () => { throw new Error('browser closed\nwhile capturing'); } };
  const warn = (line: string) => warnings.push(line);
  await captureStoryScreenshot(screenshots, root, { testPath: 'apps/web/example.stories.tsx', page }, 'Default', warn);
  const blockedDirectory = join(screenshots, 'file');
  writeFileSync(blockedDirectory, 'not a directory');
  await captureStoryScreenshot(blockedDirectory, root, { testPath: 'apps/web/example.stories.tsx', page }, 'Default', warn);
  await captureStoryScreenshot(screenshots, root, { page }, 'Default', warn);
  expect(warnings).toHaveLength(3);
  expect(warnings.every(line => line.startsWith('Warning: story screenshot Default: ') && !line.includes('\n'))).toBe(true);
  expect(warnings[0]).toContain('browser closed while capturing');
  expect(warnings[2]).toContain('no file path');
});
