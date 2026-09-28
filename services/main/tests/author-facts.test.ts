import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorFactsWithSource, parseSourceDate, projectOpenLibraryAuthorFacts }
  from '../src/modules/source/author-facts.ts';
import { projectOpenLibraryAuthor } from '../src/modules/source/author-name.ts';
import type { FixtureLock } from '../../../scripts/fixtures/pull.ts';

const root = resolve(import.meta.dir, '../../..');
const lock = JSON.parse(readFileSync(`${root}/tests/fixtures/fixtures.lock.json`, 'utf8')) as FixtureLock;
/** A locked Open Library author record, as the seed acquires it. */
function record(id: string): unknown {
  const entry = lock.entries.find(item => item.id === `author-${id}`);
  if (!entry) throw new Error(`No locked record for ${id}`);
  return JSON.parse(readFileSync(`${root}/${entry.seed}`, 'utf8'));
}

test('source dates keep their text and give parts only for plainly stated calendar days', () => {
  expect(parseSourceDate('December 16, 1775')).toEqual({ text: 'December 16, 1775', year: 1775, month: 12, day: 16,
    approximate: false });
  expect(parseSourceDate('21 April 1816')).toMatchObject({ year: 1816, month: 4, day: 21 });
  expect(parseSourceDate('1859-05-22')).toMatchObject({ year: 1859, month: 5, day: 22 });
  expect(parseSourceDate('Sept. 3, 1901')).toMatchObject({ year: 1901, month: 9, day: 3 });
  expect(parseSourceDate('March 1790')).toMatchObject({ year: 1790, month: 3, day: null });
  expect(parseSourceDate('1640')).toMatchObject({ year: 1640, month: null, day: null, approximate: false });
  expect(parseSourceDate('approximately 1717')).toMatchObject({ year: 1717, approximate: true });
  expect(parseSourceDate('ca. 1582.')).toEqual({ text: 'ca. 1582.', year: 1582, month: null, day: null,
    approximate: true });
  for (const text of ['February 30, 1800', '1800-13-01', 'Spring 1800', '18th century', '0', 'Mayday 5, 1900',
    'in Steventon, 1775']) {
    expect(parseSourceDate(text)).toEqual({ text, year: null, month: null, day: null, approximate: false });
  }
  // Leap days exist only in leap years, early years included.
  expect(parseSourceDate('1600-02-29').day).toBe(29);
  expect(parseSourceDate('1700-02-29').day).toBeNull();
});

test('author facts project dates, a fuller name and six onward identifiers from the locked records, and nothing else', () => {
  const austen = record('OL21594A');
  expect(projectOpenLibraryAuthor('/authors/OL21594A', austen).displayName).toBe('Jane Austen');
  const facts = projectOpenLibraryAuthorFacts(austen);
  expect(facts).toEqual({
    birthDate: { text: 'December 16, 1775', year: 1775, month: 12, day: 16, approximate: false },
    deathDate: { text: 'July 18, 1817', year: 1817, month: 7, day: 18, approximate: false },
    fullerName: null,
    identifiers: [
      { scheme: 'project_gutenberg', value: '68', url: 'https://www.gutenberg.org/ebooks/author/68' },
      { scheme: 'librivox', value: '155', url: 'https://librivox.org/author/155' },
      { scheme: 'wikidata', value: 'Q36322', url: 'https://www.wikidata.org/wiki/Q36322' },
      { scheme: 'lc_naf', value: 'n79032879', url: 'https://id.loc.gov/authorities/names/n79032879.html' },
      { scheme: 'viaf', value: '102333412', url: 'https://viaf.org/viaf/102333412' },
      { scheme: 'isni', value: '000000012283635X', url: 'https://isni.org/isni/000000012283635X' },
    ],
  });
  // Bio, photos, links, alternate names and commercial IDs never leave the capture.
  const serialized = JSON.stringify(facts);
  for (const excluded of ['English writer', '15214274', 'janeausten.ac.uk', 'Ao si ting', 'B000APWOKO', '1265']) {
    expect(serialized).not.toContain(excluded);
  }
  expect(projectOpenLibraryAuthorFacts(record('OL22098A')).fullerName).toBe('Charles Lutwidge Dodgson');
  expect(projectOpenLibraryAuthorFacts(record('OL161167A')).birthDate).toMatchObject({ year: 1859, month: 5, day: 22 });
  expect(projectOpenLibraryAuthorFacts(record('OL15030763A'))).toEqual({
    birthDate: { text: 'approximately 1717', year: 1717, month: null, day: null, approximate: true },
    deathDate: { text: '1763', year: 1763, month: null, day: null, approximate: false },
    fullerName: null, identifiers: [] });
  expect(projectOpenLibraryAuthorFacts(record('OL15669783A')))
    .toEqual({ birthDate: null, deathDate: null, fullerName: null, identifiers: [] });
});

test('a malformed fact is left out without hiding the others', () => {
  expect(projectOpenLibraryAuthorFacts({ birth_date: 1775, death_date: 'July 18, 1817', fuller_name: 'x'.repeat(201),
    remote_ids: { wikidata: 'Q36322 ', viaf: '102333412', isni: '1234', lc_naf: ['n79032879'],
      project_gutenberg: 68 } })).toEqual({ birthDate: null,
    deathDate: { text: 'July 18, 1817', year: 1817, month: 7, day: 18, approximate: false }, fullerName: null,
    identifiers: [{ scheme: 'viaf', value: '102333412', url: 'https://viaf.org/viaf/102333412' }] });
  expect(projectOpenLibraryAuthorFacts({ birth_date: 'line\nbreak', death_date: ' ', remote_ids: ['Q1'] }))
    .toEqual({ birthDate: null, deathDate: null, fullerName: null, identifiers: [] });
  expect(projectOpenLibraryAuthorFacts(null)).toEqual({ birthDate: null, deathDate: null, fullerName: null,
    identifiers: [] });
});

test('each fact carries the name provenance pointed at its own field', () => {
  const nameSource = { record: 'r', observation: 'o', revision: 'v', sourceRevision: 'open-library-revision:77',
    digest: 'd', url: 'https://openlibrary.org/authors/OL21594A.json', fetchedAt: '2026-09-28T02:06:30.948Z',
    basis: 'facts' as const, field: '/name' as const };
  const facts = authorFactsWithSource(projectOpenLibraryAuthorFacts(record('OL22098A')), nameSource);
  expect(facts.birthDate?.source).toEqual({ ...nameSource, field: '/birth_date' });
  expect(facts.deathDate?.source.field).toBe('/death_date');
  expect(facts.fullerName).toEqual({ value: 'Charles Lutwidge Dodgson', source: { ...nameSource, field: '/fuller_name' } });
  expect(facts.identifiers.map(item => item.source.field)).toEqual(['/remote_ids/project_gutenberg',
    '/remote_ids/librivox', '/remote_ids/wikidata', '/remote_ids/viaf', '/remote_ids/isni']);
});
