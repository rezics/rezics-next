import { expect, test } from 'bun:test';
import { communityNames } from './name-fields.ts';

test('community original language and optional translations stay distinct', () => {
  expect(communityNames('ja', '読書会', '本について話す', [
    { language: 'en', name: 'Reading club', description: '' },
    { language: 'zh-Hant', name: '讀書會', description: '一起讀書' },
  ])).toEqual({ name: { original: 'ja', labels: { ja: '読書会', en: 'Reading club', 'zh-Hant': '讀書會' } },
    description: { original: 'ja', labels: { ja: '本について話す', 'zh-Hant': '一起讀書' } } });
  expect(communityNames('zh-hans', '小说', '故事', [])?.name.original).toBe('zh-Hans');
  expect(communityNames('en', 'Readers', 'Books', [
    { language: 'EN', name: 'Duplicate', description: '' }])).toBeNull();
  expect(communityNames('invalid!', 'Readers', 'Books', [])).toBeNull();
});
