import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';
import { validateRelease } from '../src/index.ts';

const reviewedTypes = {
  'rezics:AnimeRelease': 'https://schema.org/CreativeWork',
  'schema:Book': 'https://schema.org/Book',
  'bf:Instance': 'https://schema.org/Book',
  'schema:VideoGame': 'https://schema.org/VideoGame',
  'wd:Q689445': 'https://schema.org/VideoGame',
  'wd:Q20631656': 'https://schema.org/CreativeWork',
  'wd:Q209163': 'https://schema.org/CreativeWork',
  'wd:Q2620972': 'https://schema.org/CreativeWork',
  'schema:TVSeries': 'https://schema.org/TVSeries',
  'schema:Movie': 'https://schema.org/Movie',
  'schema:TVSeason': 'https://schema.org/TVSeason',
  'schema:Episode': 'https://schema.org/Episode',
  'schema:ComicSeries': 'https://schema.org/ComicSeries',
  'schema:PublicationVolume': 'https://schema.org/PublicationVolume',
  'wd:Q95074': 'https://schema.org/Thing',
  'wd:Q2095': 'https://schema.org/Thing',
  'wd:Q7725310': 'https://schema.org/CreativeWorkSeries',
  'schema:BookSeries': 'https://schema.org/BookSeries',
  'schema:Person': 'https://schema.org/Person',
  'schema:Organization': 'https://schema.org/Organization',
  'schema:SoftwareApplication': 'https://schema.org/SoftwareApplication',
  'skos:Concept': 'https://schema.org/DefinedTerm',
  'skos:ConceptScheme': 'https://schema.org/DefinedTermSet',
  'schema:Recipe': 'https://schema.org/Recipe',
  'schema:MusicAlbum': 'https://schema.org/MusicAlbum',
} as const;

type NativeIdentity = readonly [iri: string, bases: readonly string[], mappings: readonly string[]];

const nativeIdentities: Record<string, NativeIdentity> = {
  'rezics:AnimeRelease': ['https://rezics.com/vocab/AnimeRelease', ['schema:CreativeWork', 'schema:Thing'], []],
  'schema:Episode': ['http://schema.org/Episode', ['schema:CreativeWork', 'schema:Thing'], ['wd:Q1983062']],
  'schema:Movie': ['http://schema.org/Movie', ['schema:CreativeWork', 'schema:Thing'], ['wd:Q11424']],
  'schema:TVSeason': ['http://schema.org/TVSeason', ['schema:CreativeWork', 'schema:Thing'], ['wd:Q3464665']],
  'schema:TVSeries': [
    'http://schema.org/TVSeries',
    ['schema:CreativeWorkSeries', 'schema:CreativeWork', 'schema:Thing'],
    ['wd:Q5398426'],
  ],
  'bf:Instance': [
    'http://id.loc.gov/ontologies/bibframe/Instance',
    ['schema:CreativeWork', 'schema:Thing'],
    ['wd:Q3331189'],
  ],
  'schema:Book': ['http://schema.org/Book', ['schema:CreativeWork', 'schema:Thing'], ['wd:Q47461344']],
  'wd:Q95074': ['http://www.wikidata.org/entity/Q95074', ['schema:Thing'], ['wd:Q95074']],
  'skos:Concept': ['http://www.w3.org/2004/02/skos/core#Concept', ['schema:Thing'], []],
  'skos:ConceptScheme': ['http://www.w3.org/2004/02/skos/core#ConceptScheme', ['schema:Thing'], []],
  'wd:Q2095': ['http://www.wikidata.org/entity/Q2095', ['schema:Thing'], []],
  'schema:Organization': ['http://schema.org/Organization', ['schema:Thing'], ['wd:Q43229']],
  'schema:Person': ['http://schema.org/Person', ['schema:Thing'], ['wd:Q5']],
  'schema:SoftwareApplication': ['http://schema.org/SoftwareApplication', ['schema:Thing'], ['wd:Q166142']],
  'wd:Q2620972': ['http://www.wikidata.org/entity/Q2620972', ['schema:CreativeWork', 'schema:Thing'], []],
  'schema:VideoGame': ['http://schema.org/VideoGame', ['schema:CreativeWork', 'schema:Thing'], ['wd:Q7889']],
  'wd:Q209163': ['http://www.wikidata.org/entity/Q209163', ['schema:CreativeWork', 'schema:Thing'], ['wd:Q209163']],
  'wd:Q20631656': ['http://www.wikidata.org/entity/Q20631656', [], []],
  'schema:PublicationVolume': [
    'http://schema.org/PublicationVolume',
    ['schema:CreativeWork', 'schema:Thing'],
    ['wd:Q1238720'],
  ],
  'schema:ComicSeries': [
    'http://schema.org/ComicSeries',
    ['schema:CreativeWorkSeries', 'schema:CreativeWork', 'schema:Thing'],
    ['wd:Q21198342'],
  ],
  'schema:Recipe': ['http://schema.org/Recipe', ['schema:Thing'], ['wd:Q219239']],
  'schema:BookSeries': [
    'http://schema.org/BookSeries',
    ['schema:CreativeWorkSeries', 'schema:CreativeWork', 'schema:Thing'],
    ['wd:Q277759'],
  ],
  'wd:Q7725310': [
    'http://www.wikidata.org/entity/Q7725310',
    ['schema:CreativeWorkSeries', 'schema:CreativeWork', 'schema:Thing'],
    [],
  ],
  'wd:Q689445': [
    'http://www.wikidata.org/entity/Q689445',
    ['schema:VideoGame', 'schema:CreativeWork', 'schema:Thing'],
    [],
  ],
  'schema:MusicAlbum': ['http://schema.org/MusicAlbum', ['schema:CreativeWork', 'schema:Thing'], ['wd:Q482994']],
};

test('every bundled concrete type declares its reviewed schema.org serialization type', () => {
  expect(Object.keys(bundledRelease.types).sort()).toEqual(Object.keys(reviewedTypes).sort());
  for (const [key, iri] of Object.entries(reviewedTypes)) {
    expect(iri).toMatch(/^https:\/\/schema\.org\/[A-Za-z0-9_-]+$/u);
    expect(bundledRelease.types[key]!.schemaOrgType).toBe(iri);
  }
  expect(validateRelease(bundledRelease)).toEqual([]);
});

test('schema.org presentation types preserve native identities and mappings', () => {
  expect(Object.keys(bundledRelease.types).sort()).toEqual(Object.keys(nativeIdentities).sort());
  for (const [key, [iri, bases, mappings]] of Object.entries(nativeIdentities)) {
    const type = bundledRelease.types[key]!;
    expect({ iri: type.iri, bases: type.bases, mappings: type.mappings }).toEqual({
      iri,
      bases: [...bases],
      mappings: [...mappings],
    });
  }
  expect(bundledRelease.types['schema:Book']!.schemaOrgType).toBe('https://schema.org/Book');
  expect(bundledRelease.types['bf:Instance']!.schemaOrgType).toBe('https://schema.org/Book');
  expect(bundledRelease.types['wd:Q95074']!.schemaOrgType).toBe('https://schema.org/Thing');
  expect(bundledRelease.types['wd:Q2095']!.schemaOrgType).toBe('https://schema.org/Thing');
  for (const key of ['wd:Q20631656', 'wd:Q209163', 'wd:Q2620972'])
    expect(bundledRelease.types[key]!.schemaOrgType).toBe('https://schema.org/CreativeWork');
  expect(bundledRelease.types['skos:Concept']!.schemaOrgType).toBe('https://schema.org/DefinedTerm');
  expect(bundledRelease.types['skos:ConceptScheme']!.schemaOrgType).toBe('https://schema.org/DefinedTermSet');
});
