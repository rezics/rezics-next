import { expect, test } from 'bun:test';
import { manuscriptLength } from '../src/modules/studio/chapters.ts';

test('STUDIO: a chapter is measured as its writers count it: characters in Chinese and Japanese, words elsewhere', () => {
  expect(manuscriptLength({ body: '雨停在书店打烊前。\n林梅在门口发现一封没有地址的信。' }, 'zh-Hans'))
    .toEqual({ unit: 'characters', value: 25 });
  expect(manuscriptLength({ body: '第一章の本文' }, 'ja')).toEqual({ unit: 'characters', value: 6 });
  expect(manuscriptLength({ body: 'It was a truth, universally acknowledged.' }, 'en'))
    .toEqual({ unit: 'words', value: 6 });
  expect(manuscriptLength({ body: '안녕하세요 세계' }, 'ko')).toEqual({ unit: 'words', value: 2 });
  expect(manuscriptLength({ blocks: [] }, 'en')).toBeNull();
});
