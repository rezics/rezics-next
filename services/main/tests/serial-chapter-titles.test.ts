import { expect, test } from 'bun:test';
import { firstChapterHeading } from '../src/modules/work-contents/read.ts';

test('G-327 legacy chapter labels use only the first actual heading', () => {
  expect(firstChapterHeading({ body: '\n# 雨夜书店\n正文' })).toBe('雨夜书店');
  expect(firstChapterHeading({ body: '第一章 雨夜\n正文' })).toBe('第一章 雨夜');
  expect(firstChapterHeading({ body: 'Chapter 2: Arrival\nText' })).toBe('Chapter 2: Arrival');
  expect(firstChapterHeading({ body: 'A normal first paragraph\n# Later heading' })).toBeNull();
  expect(firstChapterHeading({ body: 'no heading' })).toBeNull();
  expect(firstChapterHeading({ body: null })).toBeNull();
});
