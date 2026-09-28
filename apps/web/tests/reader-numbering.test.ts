import { expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { chineseNumeral, numberedTitle, volumeName } from '../features/work-page/format.ts';
import { messages } from '../features/work-page/messages.ts';
import { chapterContext } from '../features/work-page/reader.tsx';

test('volumes are counted in Chinese numerals in Chinese and in digits elsewhere', () => {
  expect([1, 2, 10, 11, 20, 21, 99, 100, 105, 110, 1001, 2024].map(chineseNumeral))
    .toEqual(['一', '二', '十', '十一', '二十', '二十一', '九十九', '一百', '一百零五', '一百一十', '一千零一', '二千零二十四']);
  expect(volumeName(2, 'zh-Hans', materializeData(messages['zh-Hans'], { locale: 'zh-Hans' }))).toBe('第二卷');
  expect(volumeName(12, 'en', materializeData(messages.en, { locale: 'en' }))).toBe('Volume 12');
});

test('a title that says its own number is not numbered again', () => {
  for (const title of ['Chapter 24', 'Letter 3', 'CHAPTER XII', '1. A Scandal in Bohemia', '第三章 最后一班车',
    '第 45 章', '第一百零五回', '番外一 书店的猫']) expect(numberedTitle(title)).toBe(true);
  for (const title of ['The Last Train', '雨夜', 'Chapterhouse', '番外', null]) expect(numberedTitle(title)).toBe(false);
});

test('the reader header says "Volume 2 · Chapter 3", a part by its name, and extras unnumbered', () => {
  const en = materializeData(messages.en, { locale: 'en' });
  const zh = materializeData(messages['zh-Hans'], { locale: 'zh-Hans' });
  const volume = { occurrence: 'v', label: { value: 'After the Rain', language: 'en' }, division: 'volume' as const, number: 2 };
  expect(chapterContext({ parentPath: [volume], number: 3, label: { value: 'The Station', language: 'en' } }, 'en', en))
    .toEqual({ group: 'Volume 2', chapter: 'Chapter 3' });
  expect(chapterContext({ parentPath: [volume], number: 3, label: { value: 'The Station', language: 'en' } }, 'zh-Hans', zh))
    .toEqual({ group: '第二卷', chapter: '第3章' });
  expect(chapterContext({ parentPath: [{ ...volume, division: 'part', number: null, label: { value: 'Letters', language: 'en' } }],
    number: 2, label: { value: 'Letter 2', language: 'en' } }, 'en', en)).toEqual({ group: 'Letters', chapter: null });
  expect(chapterContext({ parentPath: [{ ...volume, division: 'extras', number: null, label: null }], number: null,
    label: { value: '书店的猫', language: 'zh-Hans' } }, 'zh-Hans', zh)).toEqual({ group: '番外', chapter: null });
  expect(chapterContext({ parentPath: [], number: 1, label: { value: 'Prologue', language: 'en' } }, 'en', en))
    .toEqual({ group: null, chapter: 'Chapter 1' });
});
