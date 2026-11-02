import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ConditionLanguages,
  MAX_LANGUAGE_PREFERENCES,
  updateLanguagePreferences,
} from '../src/search/condition-languages';

test('ordered language preferences append, remove, reorder and clear without changing authored tags', () => {
  let languages = ['en-GB', 'zh-Hant-TW'];
  languages = updateLanguagePreferences(languages, { type: 'add', tag: 'fr' });
  languages = updateLanguagePreferences(languages, { type: 'move', index: 2, offset: -1 });
  expect(languages).toEqual(['en-GB', 'fr', 'zh-Hant-TW']);
  languages = updateLanguagePreferences(languages, { type: 'remove', index: 0 });
  expect(languages).toEqual(['fr', 'zh-Hant-TW']);
  expect(updateLanguagePreferences(languages, { type: 'clear' })).toEqual([]);

  const full = Array.from({ length: MAX_LANGUAGE_PREFERENCES }, (_value, index) => `en-x-pref${index}`);
  expect(updateLanguagePreferences(full, { type: 'add', tag: 'ja' })).toEqual(full);
});

test('the page-language default is explicit and every preference control stays disabled with the editor', () => {
  const html = renderToStaticMarkup(
    createElement(ConditionLanguages, {
      languages: ['en-GB', 'zh-Hant-TW'],
      locale: 'en',
      disabled: true,
      onChange() {},
    }),
  );
  const controls = html.match(/<(?:select|button)\b[^>]*>/g) ?? [];
  expect(html).toContain('Use page language');
  expect(html).toContain('en-GB');
  expect(controls.length).toBeGreaterThan(0);
  expect(controls.every((control) => /\sdisabled(?:=""|(?=\s|>))/.test(control))).toBe(true);
});
