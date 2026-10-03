import { describe, expect, test } from 'bun:test';
import { accountRowName, contentPreferenceValue } from '../features/auth/account-menu-items.ts';
import { messages } from '../features/auth/messages.ts';
import { uiLocales } from '../i18n/define.ts';

describe('G-949 account menu current values', () => {
  test('the accessible name preserves the complete label and long value', () => {
    const value = '繁體中文, English, 日本語, 한국어, Deutsch, Français, Español';
    expect(accountRowName('Language', value)).toBe(`Language: ${value}`);
  });

  for (const locale of uiLocales) {
    test(`${locale}: an empty saved filter means all languages, with the saved spoiler policy`, () => {
      const t = messages[locale];
      expect(contentPreferenceValue({ contentLanguages: [], spoilerPolicy: 'hide-unread' }, locale, t))
        .toBe(`${t.allContentLanguages} · ${t.spoilersHidden}`);
      expect(contentPreferenceValue({ contentLanguages: [], spoilerPolicy: 'show' }, locale, t))
        .toBe(`${t.allContentLanguages} · ${t.spoilersShown}`);
    });
  }

  test('names follow the UI locale while saved language order and private tags are preserved', () => {
    const value = { contentLanguages: ['ja', 'en', 'x-rezics'], spoilerPolicy: 'show' as const };
    const names = new Intl.DisplayNames(['fr'], { type: 'language' });
    expect(contentPreferenceValue(value, 'fr', messages.fr))
      .toBe(`${names.of('ja')}, ${names.of('en')}, x-rezics · ${messages.fr.spoilersShown}`);
    expect(value.contentLanguages).toEqual(['ja', 'en', 'x-rezics']);
  });
});
