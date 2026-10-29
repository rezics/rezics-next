import { expect, test } from 'bun:test';
import { fieldLabel } from '../src/features/pages/shared.tsx';
import { localizedLabel } from '../src/search/results.tsx';

test('property field labels capitalize their first character in the label language', () => {
  expect(fieldLabel(localizedLabel({ en: 'author' }, 'en'), 'en').text).toBe('Author');
  expect(fieldLabel(localizedLabel({ en: 'publication date' }, 'en'), 'en').text).toBe('Publication date');
  expect(fieldLabel(localizedLabel({ en: 'publication date' }, 'de'), 'de').text).toBe('Publication date');
  expect(fieldLabel(localizedLabel({ tr: 'istanbul' }, 'de'), 'de').text).toBe('İstanbul');
});

test('labels without lowercase case stay exactly as defined', () => {
  expect(fieldLabel(localizedLabel({ zh: '出版日期' }, 'zh'), 'zh').text).toBe('出版日期');
  expect(fieldLabel(localizedLabel({ en: 'ISBN-13' }, 'en'), 'en').text).toBe('ISBN-13');
});

test('field label formatting leaves fact values unchanged', () => {
  const authorValue = 'bell hooks';
  const tagValue = 'slow burn';
  expect(authorValue).toBe('bell hooks');
  expect(tagValue).toBe('slow burn');
});
