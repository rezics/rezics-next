import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { pickResultAliases } from '../src/search/result-aliases';
import { ResultList } from '../src/search/results';

const byLanguage = (entries: readonly [string, string[]][]) => Object.fromEntries(entries);

test('search aliases follow shared language fallback across insertion order, script, case and empty preferred values', () => {
  const jaFirst = byLanguage([
    ['ja', ['こころ']],
    ['zh-Hans', ['心']],
  ]);
  const hansFirst = byLanguage([
    ['zh-Hans', ['心']],
    ['ja', ['こころ']],
  ]);
  expect(pickResultAliases(jaFirst, 'zh-Hant')).toEqual({ language: 'zh-Hans', aliases: ['心'] });
  expect(pickResultAliases(hansFirst, 'zh-Hant')).toEqual({ language: 'zh-Hans', aliases: ['心'] });
  expect(
    pickResultAliases(
      byLanguage([
        ['ZH-HANS', ['心']],
        ['ja', ['こころ']],
      ]),
      'zh-Hant',
    ),
  ).toEqual({
    language: 'ZH-HANS',
    aliases: ['心'],
  });
  expect(
    pickResultAliases(
      byLanguage([
        ['zh-Hant', []],
        ['zh-Hans', ['心']],
      ]),
      'zh-Hant',
    ),
  ).toEqual({
    language: 'zh-Hans',
    aliases: ['心'],
  });
  expect(
    pickResultAliases(
      byLanguage([
        ['zh-Hant', []],
        ['ja', ['こころ']],
      ]),
      'zh-Hant',
    ),
  ).toEqual({
    language: 'ja',
    aliases: ['こころ'],
  });
});

test('the chosen alias language keeps native order, the three-name cap and lang/dir', () => {
  const html = renderToStaticMarkup(
    createElement(ResultList, {
      hits: [
        {
          id: '00000000-0000-4000-8000-000000000111',
          type: 'schema:Book',
          labels: { en: 'Kokoro' },
          aliases: {
            ja: ['こころ', '心', 'こゝろ', '第四'],
            'zh-Hans': ['心', '心灵', '心灵第三', '第四个别名'],
          },
        },
      ],
      locale: 'zh-Hant',
      hitTypes: {},
      yearProperties: [],
    }),
  );
  expect(html).toMatch(/data-slot="search-result-aliases"[^>]*lang="zh-Hans"[^>]*dir="auto"/);
  expect(html).toContain('心 · 心灵 · 心灵第三');
  expect(html).not.toContain('第四个别名');
  expect(html).not.toContain('こころ');
});
