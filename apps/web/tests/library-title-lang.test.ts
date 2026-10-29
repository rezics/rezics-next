import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { pageText } from '../src/features/pages/shared';
import { libraryLabel, subjectOf } from '../src/library/reads';
import { LibraryTitle } from '../src/library/title';

test("library pages keep the label's language from the kernel response and no longer reduce it to a plain string", () => {
  const label = { value: '日本語の題名', language: 'ja' };
  expect(libraryLabel(label, 'subject-id')).toEqual(label);
  expect(subjectOf({ id: 'subject-id', type: 'book', label })).toMatchObject({ label });
});

test("a library tile whose subject label comes in a language other than the page's renders the title with that lang attribute", () => {
  expect(
    renderToStaticMarkup(
      createElement(LibraryTitle, { label: { value: '日本語の題名', language: 'ja' }, locale: 'zh-Hans' }),
    ),
  ).toBe('<span lang="ja">日本語の題名</span>');
});

test('every library tile takes its title from the same display-title function as home and search', () => {
  const label = { value: '日本語の題名', language: 'ja' };
  const library = renderToStaticMarkup(createElement(LibraryTitle, { label, locale: 'zh-Hans' }));
  const homeAndSearch = pageText({ ja: label.value }, 'zh-Hans');
  expect(library).toBe(`<span lang="${homeAndSearch.lang}">${homeAndSearch.text}</span>`);
});
