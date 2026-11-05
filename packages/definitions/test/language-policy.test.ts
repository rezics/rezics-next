import { expect, test } from 'bun:test';
import * as definitions from '../src/index.ts';
import * as browser from '../src/browser.ts';
import * as native from '../../../services/kernel/src/semantic/language.ts';

const policies = [definitions, browser, native];

test('the public and native compatibility entries share the bounded language policy', () => {
  const ranges = 'en;q=0.5, ja;q=1, fr;q=0.9, de;q=0.9';
  for (const policy of policies) expect(policy.languageRanges(ranges)).toEqual(['ja', 'fr', 'de', 'en']);

  const many = Array.from({ length: 20 }, (_, index) => `x-${index + 1}`).join(', ');
  for (const policy of policies) {
    expect(policy.languageRanges(many)).toHaveLength(16);
    expect(policy.languageRanges(many, 'ja')).toEqual(['ja', ...policy.languageRanges(many).slice(0, 15)]);
    expect(policy.languageRanges('en;q=0, *, ja;q=.8, fr;q=1.1, de;q=0.1234, zh')).toEqual(['zh']);
  }
});

test('label selection maximizes scripts, truncates extensions, and returns the stored tag', () => {
  const labels = { en: 'English', 'zh-Hans': '简体', 'zh-Hant': '繁體', 'JA-jp': '日本語' };
  const choices: [Record<string, string>, string[], string | undefined, { value: string; language: string }][] = [
    [labels, ['zh-TW'], undefined, { value: '繁體', language: 'zh-Hant' }],
    [labels, ['zh-CN'], undefined, { value: '简体', language: 'zh-Hans' }],
    [labels, ['ja-JP-x-private'], undefined, { value: '日本語', language: 'JA-jp' }],
    [{ de: 'Deutsch', ja: '日本語' }, ['ko'], 'fr', { value: 'Deutsch', language: 'de' }],
  ];
  for (const [candidateLabels, preferred, original, expected] of choices)
    for (const policy of policies) expect(policy.chooseLabel(candidateLabels, preferred, original)).toEqual(expected);
  for (const policy of policies) {
    expect(policy.chooseLabel({ 'i-klingon': 'Klingon' }, ['i-klingon'])).toEqual({
      value: 'Klingon',
      language: 'i-klingon',
    });
    expect(policy.chooseLabel({}, ['ja'])).toBeNull();
  }
});
