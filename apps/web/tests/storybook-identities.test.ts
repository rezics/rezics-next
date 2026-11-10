import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCsf } from 'storybook/internal/csf-tools';

const root = resolve(import.meta.dir, '../../..');
const directories = ['apps/web/src/stories', 'apps/web/src/shell', 'apps/auth/src/stories', 'packages/ui/src'];
const viewportIdentity =
  /(?:^|[-\s/])(?:phone|desktop|mobile|tablet|narrow)(?:[-\s/]|$)|(?:^|-)(?:320|360|390|768|1280|1440)(?:-|$)/i;
const catalogues = directories.flatMap((directory) =>
  [...new Bun.Glob('**/*.stories.tsx').scanSync(resolve(root, directory))].map((relative) => {
    const file = `${directory}/${relative}`;
    const source = readFileSync(resolve(root, file), 'utf8');
    const csf = loadCsf(source, { fileName: file, makeTitle: (title) => title }).parse();
    return { file, source, csf };
  }),
);

test('every published outcome has a viewport-independent identity, including hidden aliases', () => {
  const ids = { web: new Set<string>(), ui: new Set<string>() };
  for (const { file, csf } of catalogues) {
    const catalogue = file.startsWith('packages/ui/') ? ids.ui : ids.web;
    for (const [key, story] of Object.entries(csf._stories)) {
      expect(`${story.id} ${story.name}`, file).not.toMatch(viewportIdentity);
      expect(key, file).not.toMatch(/Phone|Desktop|Mobile|Tablet|Narrow|(?:320|360|390|768|1280|1440)/);
      expect(catalogue.has(story.id), `${file}: ${story.id}`).toBe(false);
      catalogue.add(story.id);
    }
  }
  expect(ids.web.has('pages-library-collection-comparison--recovered-comparison')).toBe(true);
  expect(ids.web.has('pages-catalogue-book-and-book-series-work-editor--current-book')).toBe(true);
  expect(ids.web.has('pages-library-collection-comparison--phone-390')).toBe(false);
  expect(ids.ui.has('components-menu--plain-entries')).toBe(true);
});

test('canonical fixtures leave viewport and theme selection to the toolbar', () => {
  for (const { file, source } of catalogues) {
    // Includes multiline metadata and the shared objects used by story factories.
    expect(source, file).not.toMatch(/\bglobals\s*:\s*\{[^}]*\b(?:viewport|theme)\s*:/s);
    expect(source, file).not.toMatch(/\bdefaultViewport\s*:/);
  }
  for (const preview of ['apps/web/.storybook/preview.tsx', 'packages/ui/.storybook/preview.tsx']) {
    const source = readFileSync(resolve(root, preview), 'utf8');
    expect(source).toContain('initialGlobals:');
    expect(source).toContain('phone390:');
    expect(source).toContain('desktop1280:');
  }
});

test('semantic language, continuation and recovery outcomes retain separate canonical stories', () => {
  for (const [file, keys] of [
    [
      'writing-inspection',
      [
        'NewThreadRepairReturn',
        'NewThreadLongInspection',
        'ReplyRepairReturn',
        'ReplyLongInspection',
        'EditRepairReturn',
        'EditLongInspection',
      ],
    ],
    ['my-realms-continuation-interface', ['LongTextWithContinuation', 'LongTextLastPage']],
    ['realm-rules-authoring', ['LongMultilingualTraditionalChinese', 'LongMultilingualEnglish']],
    ['inbox-watch-triage', ['MixedWithPrevious', 'Mixed']],
    ['entitlements', ['LongTitles', 'LongTitlesContinuation']],
    ['library-selection-review', ['TraditionalChineseSelectionReview', 'JapaneseSelectionReview']],
  ] as const) {
    const fixture = catalogues.find((entry) => entry.file === `apps/web/src/stories/${file}.stories.tsx`)!;
    for (const key of keys) {
      expect(fixture.csf._stories[key], `${file}: ${key}`).toBeDefined();
      expect(fixture.csf._stories[key]!.tags ?? [], `${file}: ${key}`).not.toContain('!dev');
    }
  }
});
