import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { assertReleaseCorrection, assertReleasePairing, checkedRelease, InvalidRelease, releaseChanged,
  type ReleaseRecord } from '../src/modules/release/schema.ts';
import { contentLanguages, InvalidContentLanguages } from '../src/modules/release/languages.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const base = (over: Partial<ReleaseRecord> = {}): ReleaseRecord => checkedRelease({
  profile: 'release-v1', expectedHead: null, actingSubject: id(), id: id(),
  kind: 'formal', status: 'official', contentLanguages: ['zh-Hant'], isTranslation: false,
  originalLanguages: [], titleLanguage: 'zh-Hant', tracklistLanguage: null,
  title: { value: '紅樓夢', language: 'zh-Hant' }, editionStatement: null, publisher: null,
  publicationYear: 1791, isbn13: null, originalUrl: null, fixedRelease: null, coverage: null, evidence: null,
  ...over,
}, id());

test('content languages stay a list: empty, zxx, und and mul stay distinct', () => {
  expect(contentLanguages([])).toEqual([]);
  expect(contentLanguages(['zh-hant', 'zh-Hans'])).toEqual(['zh-Hans', 'zh-Hant']);
  expect(contentLanguages(['zxx'])).toEqual(['zxx']);
  expect(() => contentLanguages(['mul'])).toThrow(InvalidContentLanguages);
  expect(() => contentLanguages(['und'])).toThrow(InvalidContentLanguages);
  expect(() => contentLanguages(['zxx', 'en'])).toThrow(InvalidContentLanguages);
  expect(() => contentLanguages(['en', 'en'])).toThrow(InvalidContentLanguages);
});

test('virtual status never claims publication, and a closed release does not gain a translation', () => {
  expect(() => assertReleasePairing('virtual', 'official')).toThrow(InvalidRelease);
  expect(() => assertReleasePairing('formal', 'virtual')).toThrow(InvalidRelease);
  expect(() => assertReleasePairing('virtual', 'virtual')).not.toThrow();
  const printed = base();
  const translated = { ...printed, isTranslation: true, originalLanguages: ['zh'], contentLanguages: ['en'],
    evidence: id(), expectedHead: id() };
  expect(() => assertReleaseCorrection(printed, translated)).toThrow(/later translation/);
  const added = { ...printed, contentLanguages: ['zh-Hant', 'en'], evidence: id(), expectedHead: id() };
  expect(() => assertReleaseCorrection(printed, added)).toThrow(/cannot gain languages/);
  const corrected = { ...printed, title: { value: '紅樓夢', language: 'zh-Hant' }, publisher: '萃文書屋',
    evidence: id(), expectedHead: id() };
  expect(releaseChanged(printed, corrected)).toBe(true);
  expect(() => assertReleaseCorrection(printed, corrected)).not.toThrow();
  const virtual = base({ kind: 'virtual', status: 'virtual', coverage: { scope: 'chapters 1-20', complete: false },
    contentLanguages: ['zh'] });
  const grown = { ...virtual, contentLanguages: ['zh', 'en'], expectedHead: id() };
  expect(() => assertReleaseCorrection(virtual, grown)).not.toThrow();
});

test('an unofficial release is its own record and is not merged into the official one', () => {
  const official = base();
  const unofficial = base({ status: 'unofficial', id: id() });
  expect(official.id).not.toBe(unofficial.id);
  expect(unofficial.status).toBe('unofficial');
});
