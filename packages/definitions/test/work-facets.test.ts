import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

// Credits, characters, series membership, genres and keywords used to browse launch works.
const reverseLookupFacets = [
  'schema:author',
  'schema:illustrator',
  'schema:director',
  'schema:musicBy',
  'schema:producer',
  'schema:productionCompany',
  'wdt:P58',
  'wdt:P178',
  'wdt:P725',
  'schema:publisher',
  'schema:translator',
  'schema:contributor',
  'schema:character',
  'wdt:P179',
  'schema:genre',
  'schema:keywords',
];

// These records describe files, published music editions and individual recordings.
const relatedRecordFacets: Record<string, string[]> = {
  'schema:MediaObject': [],
  'schema:MusicRelease': [
    'schema:releaseOf',
    'schema:datePublished',
    'wdt:P437',
    'schema:recordLabel',
    'schema:inLanguage',
  ],
  'schema:MusicRecording': ['schema:byArtist', 'schema:datePublished', 'schema:duration', 'schema:inLanguage'],
};

// A release, edition or episode points at its work with one of these properties.
const workLinks = ['schema:exampleOfWork', 'schema:isPartOf', 'schema:partOfSeason'];

test('every launch work type registers its credits, characters, series, genres and keywords as facets', () => {
  const omissions: string[] = [];
  for (const [key, type] of Object.entries(bundledRelease.types)) {
    if (!type.bases.includes('schema:CreativeWork')) continue;
    if (relatedRecordFacets[key]) {
      expect(type.facets, key).toEqual(relatedRecordFacets[key]!);
      continue;
    }
    const missing = reverseLookupFacets.filter((property) => {
      // An edition's genre, keywords and series belong to its work. Readers reach the edition through exampleOfWork.
      if (
        key === 'bf:Instance' &&
        (property === 'schema:genre' || property === 'schema:keywords' || property === 'wdt:P179')
      )
        return false;
      return type.properties.includes(property) && !type.facets.includes(property);
    });
    if (missing.length === 0) continue;
    // Game retained its sixteen browse facets when the comparative Work facet was added.
    const browseFacets = type.facets.filter((facet) => facet !== 'rezics:stylisticallyComparableTo');
    if (browseFacets.length !== 16) omissions.push(`${key} (${type.facets.length}): ${missing.join(', ')}`);
  }
  expect(omissions).toEqual([]);
});

test('release, edition and episode types register the link to their work as a facet', () => {
  const releaseTypes = ['bf:Instance', 'schema:Episode', 'wd:Q20631656'];
  for (const key of releaseTypes) expect(bundledRelease.types[key]).toBeDefined();

  const omissions: string[] = [];
  for (const [key, type] of Object.entries(bundledRelease.types)) {
    const links = workLinks.filter((property) => type.properties.includes(property));
    if (releaseTypes.includes(key)) expect(links.length).toBeGreaterThan(0);
    const missing = links.filter((property) => !type.facets.includes(property));
    if (missing.length > 0) omissions.push(`${key}: ${missing.join(', ')}`);
  }
  expect(omissions).toEqual([]);
});
