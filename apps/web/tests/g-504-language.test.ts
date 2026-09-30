import { expect, test } from 'bun:test';
import { canonicalLanguage, direction, languageSatisfies, parseLanguage, selectDisplayName }
  from '@rezics/main/language';
import { contentLanguageCookie, displayLanguages, storedContentLanguages } from '../i18n/display-languages.ts';

test('G-504 the web imports the pure Main language contract and keeps source spellings', () => {
  expect(parseLanguage('AZ-aRaB')).toMatchObject({ originalTag: 'AZ-aRaB', tag: 'az-Arab', script: 'Arab' });
  expect(canonicalLanguage('X-Rezics')).toBe('x-rezics');
  expect(direction('az-Arab')).toBe('rtl');
  expect(direction('ku-Latn')).toBe('ltr');
  expect(languageSatisfies('zh-Hans', ['zh-Hant'])).toBe(false);
  expect(selectDisplayName({ original: 'zh-Hans', labels: { 'zh-Hans': '简体' } }, ['zh-Hant']))
    .toEqual({ value: '简体', language: 'zh-Hans', direction: 'ltr', basis: 'other-script' });
  const languages = ['AZ-aRaB', 'X-Rezics', 'und', 'zxx'];
  expect(storedContentLanguages(contentLanguageCookie(languages))).toEqual(languages);
  expect(displayLanguages({ content: languages, uiLocale: 'ja' }))
    .toEqual(['az-Arab', 'x-rezics', 'und', 'zxx', 'ja']);
});

test('G-504 browser preferences share quality, canonicalization and rejection with Main', () => {
  expect(displayLanguages({ uiLocale: 'ja', content: ['KU-latn', 'not a tag'],
    browser: 'fr;q=0,EN-us;q=0.5,AZ-aRaB;q=1,x-Rezics;q=0.8' }))
    .toEqual(['ku-Latn', 'ja', 'az-Arab', 'x-rezics', 'en-US']);
});
