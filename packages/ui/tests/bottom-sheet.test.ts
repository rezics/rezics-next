import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8');

test('BottomSheet centralizes the handle, title row, localized Done close and safe-area scrolling body', () => {
  const source = read('src/components/bottom-sheet.tsx');
  expect(source).toContain('showSwipeHandle');
  expect(source).toContain('DrawerTitle');
  expect(source).toContain('DrawerClose');
  expect(source).toContain('min-h-11');
  expect(source).toContain('max-h-[85dvh]');
  expect(source).toContain('overflow-y-auto');
  expect(source).toContain('env(safe-area-inset-bottom)');
  expect(source).toContain('closeLabel');
  for (const locale of ['de', 'en', 'es', 'fr', 'ja', 'ko']) expect(source).toContain(`${locale}:`);
  expect(source).toContain("'zh-Hans':");
  expect(source).toContain("'zh-Hant':");
});

test('BottomSheet stories cover short, long and Back-slot content in English and Japanese, light and dark', () => {
  const story = read('src/components/bottom-sheet.stories.tsx');
  for (const name of [
    'ShortEnglish',
    'ShortEnglishDark',
    'ShortJapanese',
    'ShortJapaneseDark',
    'TallEnglish',
    'TallEnglishDark',
    'TallJapanese',
    'TallJapaneseDark',
    'BackEnglish',
    'BackEnglishDark',
    'BackJapanese',
    'BackJapaneseDark',
  ])
    expect(story).toContain(name);
  expect(story).toContain("defaultViewport: 'phone'");
});
