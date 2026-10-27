import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';
import { validateRelease } from '../src/index.ts';

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const { types, properties } = bundledRelease;
const creditQualifiers = ['schema:position', 'wdt:P1932', 'wdt:P3831', 'wdt:P518'];

test('every bundled item property declares how it reads in both directions', () => {
  expect(validateRelease(bundledRelease)).toEqual([]);
  for (const property of Object.values(properties)) {
    if (property.datatype !== 'wikibase-item') continue;
    expect(property.relation).toBeDefined();
    const relation = property.relation!;
    if (relation.inverse && relation.inverse !== 'none') {
      expect(properties[relation.inverse]).toBeUndefined();
      expect(Object.keys(relation.inverseLabels ?? {}).sort()).toEqual(locales);
      for (const label of Object.values(relation.inverseLabels ?? {})) expect(label.trim().length).toBeGreaterThan(0);
    }
    if (relation.group === 'credit') {
      expect(property.qualifiers).toEqual(expect.arrayContaining(creditQualifiers));
      expect(relation.order).toBe('position');
      expect(relation.filter).toEqual(['wdt:P3831', 'wdt:P518']);
    }
  }
  const canonical = {
    'wdt:P155': ['wdt:P156', 'order', 'date'],
    'wdt:P144': ['wdt:P4969', 'derivation', 'name'],
    'schema:exampleOfWork': ['schema:workExample', 'derivation', 'date'],
    'rezics:spinOffOf': ['wdt:P2512', 'derivation', 'name'],
    'wdt:P8646': ['rezics:expansion', 'derivation', 'name'],
    'wdt:P361': ['wdt:P527', 'membership', 'name'],
    'schema:isPartOf': ['schema:hasPart', 'membership', 'name'],
    'wdt:P179': ['rezics:seriesMember', 'membership', 'position'],
    'wdt:P1433': ['rezics:publicationContains', 'membership', 'name'],
  };
  for (const [term, [inverse, group, order]] of Object.entries(canonical)) {
    expect(properties[term]?.relation).toMatchObject({ inverse, group, order });
    expect(properties[inverse!]).toBeUndefined();
    for (const type of Object.values(types)) expect(type.properties).not.toContain(inverse);
  }
  for (const term of [
    'wdt:P155',
    'wdt:P144',
    'schema:exampleOfWork',
    'wdt:P361',
    'schema:isPartOf',
    'wdt:P179',
    'wdt:P1433',
  ])
    expect(properties[term]?.relation?.acyclic).toBe(true);
  expect(properties['wdt:P1889']?.relation).toMatchObject({ symmetric: true, group: 'world' });
  expect(properties['schema:character']?.relation).toMatchObject({
    group: 'appearance',
    order: 'name',
    filter: ['wdt:P3831', 'wdt:P518'],
  });
});

test('bundled types declare the documented cover frame ratios', () => {
  const ratios: Record<string, string[]> = {
    '3:4': [
      'wd:Q2620972',
      'schema:Book',
      'bf:Instance',
      'schema:ComicSeries',
      'schema:PublicationVolume',
      'schema:TVSeries',
      'schema:TVSeason',
      'schema:Episode',
      'schema:Movie',
      'schema:BookSeries',
      'wd:Q7725310',
      'schema:VideoGame',
      'wd:Q689445',
      'wd:Q209163',
      'wd:Q20631656',
      'wd:Q95074',
      'schema:Person',
    ],
    '1:1': [
      'wd:Q2095',
      'schema:MusicAlbum',
      'schema:Organization',
      'schema:SoftwareApplication',
      'skos:Concept',
      'skos:ConceptScheme',
    ],
    '4:3': ['schema:Recipe'],
  };
  expect(Object.values(ratios).flat().sort()).toEqual(Object.keys(types).sort());
  for (const [ratio, terms] of Object.entries(ratios)) {
    for (const term of terms) expect(types[term]?.coverRatio).toBe(ratio);
  }
});

test('a work names its representative edition for each language', () => {
  const representative = properties['rezics:representativeEdition'];
  expect(representative).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: true,
    qualifiers: ['schema:inLanguage'],
    relation: { inverse: 'none', group: 'derivation' },
  });
  const editions = Object.entries(types)
    .filter(([, type]) => type.properties.includes('schema:exampleOfWork'))
    .map(([term]) => term)
    .sort();
  expect(editions).toEqual(['bf:Instance', 'wd:Q20631656']);
  expect(representative?.targets).toEqual(editions);
  expect(Object.keys(representative?.labels ?? {}).sort()).toEqual(locales);
  for (const term of [
    'schema:Book',
    'schema:TVSeries',
    'schema:Movie',
    'schema:ComicSeries',
    'schema:VideoGame',
    'wd:Q689445',
    'schema:MusicAlbum',
  ])
    expect(types[term]?.properties).toContain('rezics:representativeEdition');
});

test('credit properties are admitted on episodes and releases', () => {
  const credits = Object.entries(properties).filter(([, property]) => property.relation?.group === 'credit');
  expect(credits.map(([term]) => term)).toEqual(expect.arrayContaining(['schema:director', 'wdt:P58', 'wdt:P725']));
  const holders = [
    'schema:Episode',
    ...Object.keys(types).filter((term) => types[term]!.properties.includes('schema:exampleOfWork')),
  ];
  for (const holder of holders) {
    for (const [term, property] of credits) {
      expect(types[holder]?.properties).toContain(term);
      expect(property.qualifiers).toEqual(expect.arrayContaining(creditQualifiers));
      if (term === 'wdt:P725') expect(property.qualifiers).toContain('wdt:P453');
    }
  }
});

test('story arcs are creative-work subjects held as ordered part ranges', () => {
  expect(types['wd:Q2620972']).toMatchObject({
    iri: 'http://www.wikidata.org/entity/Q2620972',
    bases: ['schema:CreativeWork', 'schema:Thing'],
    coverRatio: '3:4',
  });
  expect(properties['rezics:storyArc']).toMatchObject({
    datatype: 'wikibase-item',
    targets: ['wd:Q2620972'],
    multivalued: true,
    qualifiers: ['rezics:firstPart', 'rezics:lastPart', 'schema:position'],
    relation: {
      inverse: 'rezics:storyArcOf',
      inverseLabels: { en: 'Story arc of' },
      group: 'membership',
      order: 'position',
      acyclic: true,
    },
  });
  for (const type of Object.values(types)) {
    if (type.bases.includes('schema:CreativeWork')) expect(type.properties).toContain('rezics:storyArc');
  }
  for (const term of ['rezics:firstPart', 'rezics:lastPart']) {
    expect(properties[term]?.datatype).toBe('string');
    expect(properties[term]?.value).toEqual({ type: 'string', minLength: 1, maxLength: 1500 });
  }
  expect(properties['wdt:P518']).toMatchObject({ datatype: 'wikibase-item', targets: ['wd:Q2620972'] });
});
