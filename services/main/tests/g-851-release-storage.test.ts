import { expect, test } from 'bun:test';
import { checkedReleaseV2, checkedReleaseV3, resolvedReleaseV2, resolvedReleaseV3,
  parseStoredRelease, releaseDigest, assertReleaseCorrection } from '../src/modules/release/schema.ts';
import { coverageEntry } from '../src/modules/release/command.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const body = { profile: 'release-v2', id: id(1), actingSubject: id(2), expectedHead: null,
  kind: 'formal', status: 'official', title: { value: 'Bilingual release', language: 'en' },
  titleLanguage: null, tracklistLanguage: null, editionStatement: null, publisher: null,
  publicationYear: null, isbn13: null, originalUrl: null, fixedRelease: null, evidence: null,
  identifiers: [], platform: 'Windows', territory: 'US', coverage: [
    { realization: id(4), revision: id(5), completeness: 'complete' },
    { realization: id(6), revision: id(7), completeness: 'trial', portion: 'Opening' },
  ] };
const resolved = [
  { realization: id(4), revision: id(5), work: id(3), language: 'ja', kind: 'original' as const, status: 'official' as const },
  { realization: id(6), revision: id(7), work: id(3), language: 'en', kind: 'translation' as const, status: 'official' as const },
];

test('G851: v2 history and v3 requests preserve exact entry state and versioned retry identities', () => {
  const v2 = checkedReleaseV2(body, id(3));
  const v3 = checkedReleaseV3({ ...body, profile: 'release-v3' }, id(3));
  const old = resolvedReleaseV2(v2, resolved), modern = resolvedReleaseV3(v3, resolved);
  expect(parseStoredRelease(JSON.stringify(old))).toEqual(old);
  expect(parseStoredRelease(JSON.stringify(modern))).toEqual(modern);
  expect(modern.coverage).toEqual(old.coverage);
  expect(releaseDigest(v2)).toBe(releaseDigest(old));
  expect(releaseDigest(v3)).toBe(releaseDigest(modern));
  expect(releaseDigest(v3)).not.toBe(releaseDigest(v2));
  expect(() => assertReleaseCorrection(old, { ...modern, expectedHead: id(8) })).not.toThrow();
  expect(() => assertReleaseCorrection(old, { ...modern, expectedHead: id(8), publisher: 'Changed' }))
    .toThrow('evidence');
  expect(coverageEntry(id(8), id(4))).not.toBe(coverageEntry(id(9), id(4)));
  expect(coverageEntry(id(8), id(4))).not.toBe(coverageEntry(id(8), id(6)));
});
