import { expect, test } from 'bun:test';
import { checkedReleaseV2, resolvedReleaseV2,
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

test('G851: v2 API records retain entry state and retry identities with v3 graph storage', () => {
  const request = checkedReleaseV2(body, id(3));
  const record = resolvedReleaseV2(request, resolved);
  expect(record.profile).toBe('release-v2');
  expect(parseStoredRelease(JSON.stringify(record))).toEqual(record);
  expect(record.coverage).toEqual(request.coverage);
  expect(releaseDigest(request)).toBe(releaseDigest(record));
  expect(() => checkedReleaseV2({ ...body, profile: 'release-v3' }, id(3))).toThrow();
  expect(() => parseStoredRelease(JSON.stringify({ ...record, profile: 'release-v3' }))).toThrow();
  expect(() => assertReleaseCorrection(record, { ...record, expectedHead: id(8) })).not.toThrow();
  expect(() => assertReleaseCorrection(record, { ...record, expectedHead: id(8), publisher: 'Changed' }))
    .toThrow('evidence');
  expect(coverageEntry(id(8), id(4))).not.toBe(coverageEntry(id(9), id(4)));
  expect(coverageEntry(id(8), id(4))).not.toBe(coverageEntry(id(8), id(6)));
});

test('G851: one correction bounds the union of old and new entries; larger replacements can be split', () => {
  const rows = Array.from({ length: 65 }, (_, n) => ({ realization: id(100 + n), revision: id(200 + n),
    work: id(3), language: 'ja', kind: 'original' as const, status: 'official' as const }));
  const make = (entries: typeof rows) => resolvedReleaseV2(checkedReleaseV2({ ...body,
    kind: 'virtual', status: 'virtual', expectedHead: id(8), evidence: id(9),
    coverage: entries.map(row => ({ realization: row.realization, revision: row.revision, completeness: 'complete' })),
  }, id(3)), entries);
  const old = make(rows.slice(0, 64)), changed = make(rows.slice(1));
  expect(() => assertReleaseCorrection(old, changed)).toThrow('split the correction');
  const reduced = make(rows.slice(1, 64));
  expect(() => assertReleaseCorrection(old, reduced)).not.toThrow();
  expect(() => assertReleaseCorrection(reduced, changed)).not.toThrow();
});
