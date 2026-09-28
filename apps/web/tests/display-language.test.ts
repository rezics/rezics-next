import { expect, test } from 'bun:test';
import { contentLanguageCookie, displayLanguages, storedContentLanguages }
  from '../i18n/display-languages.ts';

test('Main language header follows explicit, profile, UI and browser order', () => {
  expect(displayLanguages({ pageUrl: 'https://rezics.test/zh-Hant/r?language=ja',
    content: ['de', 'zh-Hans'], browser: ['en-US', 'de'] }))
    .toEqual(['ja', 'de', 'zh-Hans', 'zh-Hant', 'en-US']);
  expect(displayLanguages({ pageUrl: '/de/r', browser: 'fr-CA,es;q=0.8' }))
    .toEqual(['de', 'fr-CA', 'es']);
  expect(storedContentLanguages(contentLanguageCookie(['zh-Hans', 'en'])))
    .toEqual(['zh-Hans', 'en']);
});
