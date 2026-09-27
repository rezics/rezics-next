import { expect, test } from 'bun:test';
import { mainSearchMatches } from '../src/modules/work/selection-search.ts';
import { PublicQueryUnavailable } from '../src/modules/work/search-budget.ts';

test('G-277: language-neutral search preserves Main grain and its strongest match', () => {
  const en = { mainVersion: 'a', language: 'en', matchUnit: 'one', score: 1 };
  const zh = { mainVersion: 'a', language: 'zh-CN', matchUnit: 'two', score: 2 };
  const other = { mainVersion: 'b', language: 'en', matchUnit: 'three', score: 1 };
  expect(mainSearchMatches([en, other, zh])).toEqual([zh, other]);
  expect(mainSearchMatches([zh, en, other])).toEqual([zh, other]);
});

test('G-277: search grouping cannot hide two heads in one normalized language', () => {
  const first = { mainVersion: 'a', language: 'zh-CN', matchUnit: 'one', score: 1 };
  expect(() => mainSearchMatches([first, { ...first, language: 'zh-cn', matchUnit: 'two' }]))
    .toThrow(PublicQueryUnavailable);
});
