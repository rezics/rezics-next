import { expect, test } from 'bun:test';
import { pickLanguage, pickText } from '../src/index.ts';

test('locale tag casing preserves the intended script and authored key', () => {
  expect(pickText({ 'zh-HANS': '简体', 'zh-hant': '繁體' }, 'ZH-hANT')).toEqual({ text: '繁體', lang: 'zh-hant' });
  expect(pickText({ 'zh-HANT': 'uppercase', 'zh-hant': 'lowercase' }, 'zh-Hant')).toEqual({
    text: 'uppercase',
    lang: 'zh-HANT',
  });
  expect(pickLanguage(['zh-hant', 'zh-HANT'], 'zh-Hant')).toBe('zh-HANT');
  expect(pickText({ en: 'English', 'ja-jpan': '日本語' }, 'fr', 'JA-Jpan')).toEqual({
    text: '日本語',
    lang: 'ja-jpan',
  });
});
