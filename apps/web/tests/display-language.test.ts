import { expect, test } from 'bun:test';
import { CONTENT_LANGUAGE_LIMIT, contentLanguageCookie, displayLanguageHeaders, displayLanguages,
  readerContentLanguages, storedContentLanguages } from '../i18n/display-languages.ts';

test('Main language header follows explicit, profile, UI and browser order', () => {
  expect(displayLanguages({ pageUrl: 'https://rezics.test/zh-Hant/r?language=ja',
    content: ['de', 'zh-Hans'], browser: ['en-US', 'de'] }))
    .toEqual(['ja', 'de', 'zh-Hans', 'zh-Hant', 'en-US']);
  expect(displayLanguages({ pageUrl: '/de/r', browser: 'fr-CA,es;q=0.8' }))
    .toEqual(['de', 'fr-CA', 'es']);
  expect(storedContentLanguages(contentLanguageCookie(['zh-Hans', 'en'])))
    .toEqual(['zh-Hans', 'en']);
  const many = Array.from({ length: CONTENT_LANGUAGE_LIMIT + 1 }, (_, index) => `x-l${index}`);
  expect(storedContentLanguages(contentLanguageCookie(many))).toEqual(many.slice(0, CONTENT_LANGUAGE_LIMIT));
});

test('a signed-in reader\'s display languages are Main\'s list, never the cookie', () => {
  const cookie = contentLanguageCookie(['de', 'fr']);
  expect(readerContentLanguages({ signedIn: true, profile: ['ja', 'ko', 'yue-Hant'], cookie }))
    .toEqual(['ja', 'ko', 'yue-Hant']);
  expect(readerContentLanguages({ signedIn: true, profile: [], cookie })).toEqual([]);
  expect(readerContentLanguages({ signedIn: false, profile: ['ja'], cookie })).toEqual(['de', 'fr']);
  expect(displayLanguageHeaders({ signedIn: true, profile: ['ja', 'ko', 'yue-Hant'], cookie,
    pageUrl: 'https://rezics.test/en', browser: 'en' })['x-rezics-display-languages'])
    .toBe('ja,ko,yue-Hant,en');
  expect(displayLanguageHeaders({ signedIn: false, profile: ['ja'], cookie: contentLanguageCookie(['zh-Hans', 'yue-Hant']),
    pageUrl: 'https://rezics.test/en', browser: 'fr' })['x-rezics-display-languages'])
    .toBe('zh-Hans,yue-Hant,en,fr');
});
