import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

// Credits, characters, series membership, genres and keywords. A type may omit
// one of these only when its facet list is already at the per-type limit.
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

const facetLimit = 16;

// A release, edition or episode points at its work with one of these properties.
const workLinks = ['schema:exampleOfWork', 'schema:isPartOf', 'schema:partOfSeason'];

test('every launch work type registers its credits, characters, series, genres and keywords as facets', () => {
  const omissions: string[] = [];
  for (const [key, type] of Object.entries(bundledRelease.types)) {
    if (!type.bases.includes('schema:CreativeWork')) continue;
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
    if (type.facets.length !== facetLimit) omissions.push(`${key} (${type.facets.length}): ${missing.join(', ')}`);
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
