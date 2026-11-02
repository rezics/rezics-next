import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { HeaderSearchView } from '../src/search/header-search/header-search';
import { initialHeaderSearchState, reduceHeaderSearchState } from '../src/search/header-search/state';
import type { SearchScope } from '../src/search/header-search/types';

const present = (locale: 'en' | 'zh-Hans', suggestions: 'error' | 'unavailable') => {
  const scope: SearchScope = {
    kind: 'Collection', id: 'reading', name: 'Reading list', searchAction: `/${locale}/collections/reading/search`,
  };
  const state = reduceHeaderSearchState(
    reduceHeaderSearchState(initialHeaderSearchState(scope, 'draft'), { type: 'open-phone' }),
    { type: 'suggestions', state: suggestions },
  );
  return createElement(HeaderSearchView, { id: locale, state, locale, keyboardShortcut: true, region: null, onRetry() {} });
};

test('header messages follow each presenter's locale when locales coexist', async () => {
  const previousLocale = getLocale();
  try {
    await setLocale('ja', { reload: false });
    const markup = renderToStaticMarkup(createElement('div', null, present('en', 'error'), present('zh-Hans', 'unavailable')));
    for (const pair of [
      ['aria-label="Search subjects"', 'aria-label="搜索条目"'],
      ['aria-label="Close search"', 'aria-label="关闭搜索"'],
      ['aria-label="Remove Reading list scope"', 'aria-label="移除 Reading list 范围"'],
      ['placeholder="Search in Reading list"', 'placeholder="在 Reading list 中搜索"'],
      ['title="Filters are not available on this page."', 'title="此页面暂不提供筛选。"'],
      ['Filters', '筛选条件'],
      ['aria-label="Search"', 'aria-label="搜索"'],
      ['aria-label="Suggestions"', 'aria-label="搜索建议"'],
      ['Suggestions could not be loaded.', '暂时无法提供搜索建议。'],
      ['Try again', '重试'],
      ['Ctrl+K or Command+K to search. Esc closes and keeps your draft.', '按 Ctrl+K 或 Command+K 搜索；按 Esc 关闭并保留草稿。'],
    ] as const)
      for (const text of pair) expect(markup).toContain(text);
  } finally {
    await setLocale(previousLocale, { reload: false });
  }
});
