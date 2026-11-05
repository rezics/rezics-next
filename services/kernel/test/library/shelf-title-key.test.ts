import { expect, test } from 'bun:test';
import { shelfTitleKey } from '../../src/library/shelf-title-key.ts';

test('uses Semantic language fallback and its deterministic name key', () => {
  const key = shelfTitleKey({ fr: 'Straße', en: 'Road' }, ['fr-CA', 'en'], 'en');
  expect(key.coverage).toBe('labelled');
  if (key.coverage !== 'labelled') throw new Error('Expected a disclosed title');
  expect(key.language).toBe('fr');
  expect(Buffer.from(key.bytes).toString('utf8')).toBe('strasse');
});

test('keeps missing and empty labels explicit instead of inventing a title', () => {
  expect(shelfTitleKey({}, ['en'])).toEqual({ coverage: 'missing', language: null, bytes: null });
  expect(shelfTitleKey({ en: '' }, ['en'])).toEqual({ coverage: 'missing', language: 'en', bytes: null });
});

test('bounds normalized keys to 256 codepoints', () => {
  const key = shelfTitleKey({ en: `${'A'.repeat(256)}z` }, ['en']);
  expect(key.coverage).toBe('labelled');
  if (key.coverage !== 'labelled') throw new Error('Expected a disclosed title');
  expect(key.bytes.byteLength).toBe(256);
});
