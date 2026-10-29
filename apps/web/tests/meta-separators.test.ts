import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { MetaLine, metaText } from '@rezics/ui/meta-line';
import { Byline } from '../src/threads/byline';
import { ResultList } from '../src/search/results';

const root = join(import.meta.dir, '../../..');

test('MetaLine renders only non-empty items in order with one decorative separator between neighbours', () => {
  const markup = renderToStaticMarkup(
    createElement(MetaLine, { items: ['first', null, '', false, undefined, 'second', 'third'] }),
  );

  expect(markup).toBe(
    '<span><span>first</span><span> <span aria-hidden="true">·</span> second</span><span> <span aria-hidden="true">·</span> third</span></span>',
  );
  expect(renderToStaticMarkup(createElement(MetaLine, { items: [null, '', false, undefined] }))).toBe('<span></span>');
});

test('metaText joins string props with the same break-before separator spacing', () => {
  expect(metaText(['first', null, '', false, undefined, 'second', 'third'])).toBe('first · second · third');
});

test('visible middle-dot separators in source are centralized, with named content exceptions', () => {
  const exceptions: Record<string, string> = {
    'apps/web/src/threads/initials.ts': 'middle dot splits a name for initials',
    'apps/web/src/kernel/fake/search-facets.ts': 'fixture names contain a middle dot',
    'apps/web/src/kernel/recorded/subject.json': 'recorded fixture names contain a middle dot',
    'apps/web/src/kernel/recorded/subject-page.json': 'recorded fixture names contain a middle dot',
    'apps/web/src/kernel/recorded/search-typed.json': 'recorded fixture names contain a middle dot',
    'apps/web/src/paraglide/messages/subject_ratings_imported.js':
      'generated localization of the imported rating message',
    'apps/web/src/paraglide/messages/subject_ratings_imported.d.ts':
      'generated type documentation for the imported rating message',
    'apps/web/src/routes/subjects/$id_.$slug_.$view.tsx': 'document title separator',
    'apps/web/src/routes/subjects/$id_.$slug_.relations.tsx': 'document title separator',
    'apps/web/src/stories/home.stories.tsx': 'fixture story names',
    'apps/web/src/stories/moderation-decision.stories.tsx': 'fixture story names',
    'apps/web/src/stories/settings.stories.tsx': 'fixture story names',
    'packages/ui/src/components/meta-line.tsx': 'shared metadata separator implementation',
    'packages/ui/src/components/avatar-initials.tsx': 'middle dot splits a name for initials',
    'packages/ui/src/components/rating.tsx': 'localized importedLine default text',
  };
  const sourceRoots = ['apps/web/src', 'packages/ui/src'];
  const sources = sourceRoots.flatMap((directory) =>
    collect(join(root, directory)).filter((path) => /\.(?:[jt]sx?|json)$/.test(path)),
  );
  const violations: string[] = [];

  for (const path of sources) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('·')) continue;
    const name = relative(root, path);
    expect(exceptions[name], `${name} must document why its middle dot is not a metadata separator`).toBeTruthy();
    if (exceptions[name]) continue;
    violations.push(name);
  }
  expect(violations).toEqual([]);
});

test('at 390 px, wrapped thread and search metadata never leave a separator at line end', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const thread = renderToStaticMarkup(
      createElement(Byline, {
        author: { displayName: 'Mira Okabe', handle: 'mira', kind: 'person', state: 'active' } as never,
        createdAt: '2026-10-24T00:00:00.000Z',
        now: '2026-10-29T00:00:00.000Z',
        children: createElement('span', null, 'Edited'),
      }),
    );
    const search = renderToStaticMarkup(
      createElement(ResultList, {
        hits: [
          {
            id: 'subject-1',
            type: 'novel',
            labels: { en: 'A long title for a visual novel' },
            facts: {
              authors: [
                { kind: 'item', id: 'author-1', labels: { en: 'A very long author name that wraps at phone width' } },
                { kind: 'item', id: 'author-2', labels: { en: 'Another author name' } },
              ],
            },
          },
        ],
        locale: 'en',
        hitTypes: { novel: { en: 'Visual novel' } },
        yearProperties: [],
      }),
    );
    await page.setContent(
      `<main lang="en" style="width:358px;font:16px/24px Arial,sans-serif"><div id="thread" style="width:235px">${thread}</div><div id="search" style="width:235px;margin-top:24px">${search}</div></main>`,
    );
    for (const selector of ['#thread p > span', '#search li p'])
      expect(
        await page
          .locator(selector)
          .first()
          .evaluate((node) => node.getBoundingClientRect().height),
        `${selector} wraps`,
      ).toBeGreaterThan(24);
    for (const [selector, line] of await Promise.all(
      ['#thread', '#search'].map(async (selector) => [selector, page.locator(selector)] as const),
    )) {
      const separators = line.locator('span[aria-hidden="true"]').filter({ hasText: /^·$/u });
      for (let index = 0; index < (await separators.count()); index += 1) {
        const top = await separators.nth(index).evaluate((node) => node.getBoundingClientRect().top);
        const nextItem = separators.nth(index).locator('xpath=..');
        const followingText = await nextItem.evaluate((node) => {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let text = walker.nextNode() as Text | null;
          while (text && (text.parentElement?.closest('[aria-hidden="true"]') || !/\S/u.test(text.data)))
            text = walker.nextNode() as Text | null;
          if (!text) return null;
          const range = document.createRange();
          const offset = text.data.search(/\S/u);
          range.setStart(text, offset);
          range.setEnd(text, offset + 1);
          return range.getBoundingClientRect().top;
        });
        expect(followingText, `${selector} separator ${index} must stay with following metadata`).toBe(top);
      }
    }
  } finally {
    await browser.close();
  }
});

function collect(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collect(path) : [path];
  });
}
