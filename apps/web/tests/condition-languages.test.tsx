import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ConditionLanguages,
  MAX_LANGUAGE_PREFERENCES,
  updateLanguagePreferences,
} from '../src/search/condition-languages';
import { locales } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

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
  expect(updateLanguagePreferences(['en'], { type: 'add', tag: 'PT-br' })).toEqual(['en', 'pt-BR']);
  expect(updateLanguagePreferences(['en'], { type: 'add', tag: 'es-419' })).toEqual(['en', 'es-419']);
  expect(updateLanguagePreferences(['en'], { type: 'add', tag: 'x-private' })).toEqual(['en']);
  expect(updateLanguagePreferences(['en'], { type: 'add', tag: 'not a tag' })).toEqual(['en']);
});

test('display language names use all eight interface locales and keep the canonical tag visible', () => {
  for (const locale of locales) {
    const html = renderToStaticMarkup(
      createElement(ConditionLanguages, {
        languages: ['pt-BR', 'es-419'],
        locale,
        onChange() {},
      }),
    );
    const names = new Intl.DisplayNames([locale], { type: 'language' });
    expect(html).toContain(m.condition_languages_label({}, { locale }));
    expect(html).toContain(m.condition_languages_help({}, { locale }));
    expect(html).toContain(names.of('pt-BR')!);
    expect(html).toContain(names.of('es-419')!);
    expect(html).toContain('pt-BR');
    expect(html).toContain('es-419');
  }
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
  const controls = html.match(/<(?:input|select|button)\b[^>]*>/g) ?? [];
  expect(html).toContain('Use page language');
  expect(html).toContain('en-GB');
  expect(controls.length).toBeGreaterThan(0);
  expect(controls.every((control) => /\sdisabled(?:=""|(?=\s|>))/.test(control))).toBe(true);
});
