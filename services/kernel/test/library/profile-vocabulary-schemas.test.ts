import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { libraryStoredVocabularySchema, libraryVocabularyIdSchema } from '../../src/library/profile-schemas.ts';
test('Library vocabulary schemas carry data identifiers and preserve unknown historical output without fixed state unit or status enums', () => {
  for (const id of [
    'playing',
    'wishlist',
    'seed-tray.v2',
    'track',
    'licensed',
    'visual-novel.reading',
    'a' + 'x'.repeat(63),
  ])
    expect(Value.Check(libraryVocabularyIdSchema, id)).toBe(true);
  for (const id of ['', '1start', 'Playing', 'two words', 'a/b', 'a\n', 'a' + 'x'.repeat(64), 1, null, ['playing']])
    expect(Value.Check(libraryVocabularyIdSchema, id)).toBe(false);
  for (const value of ['planned', 'future:unknown/raw value', 'LEGACY_IMPORTED_STATE', 'unit-no-longer-declared'])
    expect(Value.Check(libraryStoredVocabularySchema, value)).toBe(true);
  for (const value of [1, null, {}, ['planned']]) expect(Value.Check(libraryStoredVocabularySchema, value)).toBe(false);
});
