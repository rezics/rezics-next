import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs, readLockedFixture, type FixtureLock } from '../../../scripts/fixtures/pull.ts';
import {
  openLibrary,
  openLibraryLibrarySlice,
  prideEditionSet,
} from '../../fixtures/sources/open-library.ts';
import {
  wikidata,
  wikidataAuthors,
  wikidataAuthorsSource,
  type WikidataFact,
} from '../../fixtures/sources/wikidata.ts';

const root = resolve(import.meta.dir, '../../..');
const lock = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/fixtures.lock.json'), 'utf8'),
) as FixtureLock;

test('fixture lock entries have a reuse basis and immutable, content-addressed seeds', () => {
  expect(lock.version).toBe(1);
  const seen = new Set<string>();
  for (const entry of lock.entries) {
    const key = `${entry.source}/${entry.id}`;
    expect(seen.has(key)).toBe(false);
    seen.add(key);
    expect(entry.requestUrl).toStartWith('https://');
    expect(entry.requestUrls?.[0] ?? entry.requestUrl).toBe(entry.requestUrl);
    expect(entry.requestUrls?.every((url) => url.startsWith('https://')) ?? true).toBe(true);
    expect(entry.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.reuseBasis.trim().length).toBeGreaterThan(0);
    const seedDirectory =
      entry.source === 'gutenberg'
        ? 'tests/fixtures/gutenberg'
        : `tests/fixtures/seeds/${entry.source}`;
    expect(entry.seed).toBe(`${seedDirectory}/${entry.sha256}.json`);
    expect(basename(entry.seed)).toBe(`${entry.sha256}.json`);
    const bytes = readFileSync(join(root, entry.seed));
    expect(bytes.length).toBe(entry.size);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
  }
  expect(parseArgs(['--offline'])).toEqual({ updateLock: false, offline: true });
});

test('the Pride and Prejudice edition slice covers its six chosen distinctions', () => {
  expect(prideEditionSet).toHaveLength(6);
  const editions = new Map(
    prideEditionSet.map(({ purpose, edition }) => [
      purpose,
      readLockedFixture(root, 'open-library', `edition-${edition}`) as {
        key: string;
        title: string;
        edition_name?: string;
        physical_format?: string;
        publishers?: string[];
        languages?: { key: string }[];
        works?: { key: string }[];
      },
    ]),
  );
  for (const { edition } of prideEditionSet) {
    const record = editions.get(prideEditionSet.find((item) => item.edition === edition)!.purpose)!;
    expect(record.key).toBe(`/books/${edition}`);
    expect(record.works?.map((work) => work.key)).toContain('/works/OL66554W');
  }

  const translation = editions.get('translation')!;
  expect(translation.languages?.some(({ key }) => key !== '/languages/eng')).toBe(true);

  const publisherEditions = [editions.get('publisher-dell')!, editions.get('publisher-cambridge')!];
  expect(
    new Set(publisherEditions.flatMap((record) => record.publishers ?? [])).size,
  ).toBeGreaterThan(1);

  const annotated = editions.get('annotated')!;
  expect(`${annotated.title} ${annotated.edition_name ?? ''}`).toMatch(/annotated|revised/i);
  expect(editions.get('ebook')!.physical_format).toMatch(/e-?book/i);
  expect(editions.get('audiobook')!.physical_format?.toLowerCase()).toContain('audio');
});

test('the fixed Open Library library slice is one 250-record work and edition seed', () => {
  const entry = lock.entries.find(
    (item) => item.source === 'open-library' && item.id === openLibraryLibrarySlice.id,
  )!;
  expect(entry.recordCount).toBe(openLibraryLibrarySlice.recordCount);
  expect(entry.requestUrls).toHaveLength(openLibraryLibrarySlice.recordCount);
  expect(new Set(entry.requestUrls).size).toBe(openLibraryLibrarySlice.recordCount);
  expect(
    openLibrary.requests.find((request) => request.id === openLibraryLibrarySlice.id)?.records,
  ).toHaveLength(openLibraryLibrarySlice.recordCount);

  const slice = readLockedFixture(root, 'open-library', openLibraryLibrarySlice.id) as {
    id: string;
    recordCount: number;
    records: { id: string; record: { key: string } }[];
  };
  expect(slice.id).toBe(openLibraryLibrarySlice.id);
  expect(slice.recordCount).toBe(openLibraryLibrarySlice.recordCount);
  expect(slice.records).toHaveLength(openLibraryLibrarySlice.recordCount);
  expect(slice.records.filter(({ id }) => id.startsWith('work-'))).toHaveLength(125);
  expect(slice.records.filter(({ id }) => id.startsWith('edition-'))).toHaveLength(125);
  expect(new Set(slice.records.map(({ id }) => id)).size).toBe(slice.records.length);
  expect(JSON.stringify(slice)).not.toMatch(/covers\.openlibrary\.org|data:image/i);
});

test('Wikidata author pins match their English labels and keep only ids, revisions and selected labels', () => {
  expect(wikidata.requests.find((request) => request.id === 'Q42')).toBeDefined();
  expect(wikidataAuthorsSource.requests).toHaveLength(wikidataAuthors.length);
  for (const author of wikidataAuthors) {
    const fact = readLockedFixture(root, 'wikidata', author.id) as WikidataFact;
    expect(fact.id).toBe(author.id);
    expect(fact.revision).toBeGreaterThan(0);
    expect(Object.keys(fact)).toEqual(['id', 'revision', 'labels']);
    for (const [language, value] of Object.entries(author.labels)) {
      expect(fact.labels.find((label) => label.language === language)?.value).toBe(value);
    }
    expect(fact.labels.every((label) => ['en', 'ja', 'zh'].includes(label.language))).toBe(true);
    expect(
      fact.labels.every((label) => Object.keys(label).sort().join(',') === 'language,value'),
    ).toBe(true);
  }
  expect(openLibrary.reuseBasis).toContain('CC0');
  expect(wikidata.reuseBasis).toContain('CC0');
  expect(
    lock.entries
      .filter((entry) => entry.source === 'open-library')
      .every((entry) => entry.reuseBasis === openLibrary.reuseBasis),
  ).toBe(true);
  expect(
    lock.entries.find((entry) => entry.source === 'wikidata' && entry.id === 'Q42')?.reuseBasis,
  ).toBe(wikidata.reuseBasis);
  expect(
    lock.entries
      .filter((entry) => entry.source === 'wikidata' && entry.id !== 'Q42')
      .every((entry) => entry.reuseBasis === wikidataAuthorsSource.reuseBasis),
  ).toBe(true);
});

test('Wikidata normalization rejects an id whose English label does not match the pinned author', () => {
  const author = wikidataAuthors[0]!;
  expect(() =>
    wikidata.normalize(
      {
        entities: {
          [author.id]: {
            id: author.id,
            lastrevid: 1,
            labels: { en: { language: 'en', value: 'A different author' } },
          },
        },
      },
      author.id,
    ),
  ).toThrow(`not labelled ${author.labels.en} (en)`);
});
