import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bundledRelease, bundledSources } from '../src/bundled.ts';

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];

// Bangumi's book browser, in sidebar order: https://bangumi.tv/book/browser
// Category and series select the subject type. The remaining item and time filters are
// public tags (source, audience, region, progress), genre, then publication year.
const mangaFacets = ['schema:keywords', 'schema:genre', 'schema:datePublished'];

type Decision = {
  status?: string;
  term?: string;
  on?: string;
  reason?: string;
  profile?: Decision;
  value?: Decision;
};

const inventory = () =>
  Bun.YAML.parse(readFileSync(new URL('../sources/bangumi.yaml', import.meta.url), 'utf8')) as {
    files: { id: string; fields: { id: string; mapping: Decision }[] }[];
    infobox: { id: string; fields: { id: string | number; mapping: Decision }[] }[];
    enumerations: { id: string; values: { id: string | number; mapping: Decision }[] }[];
    vocabulary: Decision[];
  };

function proposed(mapping: Decision | undefined, path: string, found: string[]) {
  if (!mapping) return;
  if (mapping.status === 'proposed') found.push(path);
  if (mapping.status === 'existing') {
    const type = bundledRelease.types[mapping.on ?? ''];
    expect(type, path).toBeDefined();
    expect(mapping.term === mapping.on || type!.properties.includes(mapping.term ?? ''), path).toBe(true);
  }
  if (mapping.status === 'omitted') expect((mapping.reason ?? '').trim().length, path).toBeGreaterThan(15);
  proposed(mapping.profile, `${path}/profile`, found);
  proposed(mapping.value, `${path}/value`, found);
}

test('a manga work and its volumes are catalogue profiles', () => {
  const { types, properties } = bundledRelease;
  const work = types['schema:ComicSeries'];
  const volume = types['schema:PublicationVolume'];
  expect(work).toMatchObject({ mappings: ['wd:Q21198342'] });
  expect(work!.facets).toEqual(expect.arrayContaining(mangaFacets));
  expect(work!.facets.length).toBeLessThanOrEqual(16);
  expect(volume).toMatchObject({ mappings: ['wd:Q1238720'] });
  expect(volume!.facets).toEqual(expect.arrayContaining(mangaFacets));
  expect(volume!.facets.length).toBeLessThanOrEqual(16);
  expect(work!.bases).not.toContain('schema:BookSeries');
  expect(volume!.bases).not.toContain('schema:BookSeries');
  expect(work!.bases).toEqual(['schema:CreativeWorkSeries', 'schema:CreativeWork', 'schema:Thing']);
  expect(work!.properties).toEqual(
    expect.arrayContaining([
      'schema:abstract',
      'schema:author',
      'schema:character',
      'schema:contributor',
      'schema:datePublished',
      'schema:genre',
      'schema:illustrator',
      'schema:inLanguage',
      'schema:keywords',
      'schema:name',
      'schema:publisher',
      'wdt:P1433',
      'wdt:P179',
      'wdt:P2635',
      'wdt:P5732',
    ]),
  );
  expect(volume!.properties).toEqual(
    expect.arrayContaining([
      'schema:author',
      'schema:character',
      'schema:datePublished',
      'schema:genre',
      'schema:illustrator',
      'schema:isbn',
      'schema:keywords',
      'schema:numberOfPages',
      'schema:publisher',
      'wdt:P179',
      'wdt:P5732',
    ]),
  );
  expect(properties['wdt:P179']).toMatchObject({
    targets: ['schema:CreativeWorkSeries'],
    qualifiers: ['schema:position'],
  });
  expect(work!.bases).toEqual(expect.arrayContaining(['schema:CreativeWorkSeries', 'schema:CreativeWork']));
  expect(volume!.bases).toContain('schema:CreativeWork');
  expect(properties['wdt:P1433']).toMatchObject({
    datatype: 'wikibase-item',
    mappings: ['wd:P1433'],
  });
  expect(work!.properties).toContain('wdt:P2635');
  expect(properties['wdt:P2635']!.units).toEqual([
    'http://www.wikidata.org/entity/Q1238720',
    'http://www.wikidata.org/entity/Q1980247',
  ]);
  expect(properties['schema:author']!.qualifiers).toEqual(
    expect.arrayContaining(['schema:position', 'wdt:P1932', 'wdt:P3831']),
  );
  expect(properties['schema:illustrator']!.qualifiers).toEqual(
    expect.arrayContaining(['schema:position', 'wdt:P1932', 'wdt:P3831']),
  );
  // A new creative-work subclass would widen edition-of. These profiles reuse the shared terms
  // without joining that range, and they are not the book work or edition.
  expect(properties['schema:exampleOfWork']!.targets).not.toContain('schema:ComicSeries');
  expect(properties['schema:exampleOfWork']!.targets).not.toContain('schema:PublicationVolume');
  expect(work!.properties).not.toContain('schema:isbn');
  expect(volume!.properties).not.toContain('wdt:P2635');
});

test('Bangumi book and manga fields are bundled or omitted with a reason', () => {
  const data = inventory();
  const found: string[] = [];
  const enumeration = (id: string) => data.enumerations.find((entry) => entry.id === id)!;
  const bookType = enumeration('subject.type').values.find((entry) => entry.id === 1)!;
  expect(bookType.mapping).toMatchObject({ status: 'existing', term: 'schema:Book', on: 'schema:Book' });
  proposed(bookType.mapping, 'subject.type/1', found);
  for (const entry of enumeration('subject.series').values)
    proposed(entry.mapping, `subject.series/${entry.id}`, found);
  const platforms = enumeration('platform.book').values;
  for (const entry of platforms) proposed(entry.mapping, `platform.book/${entry.id}`, found);
  const profile = (id: number) => platforms.find((entry) => entry.id === id)!.mapping.profile!;
  expect(profile(1001)).toMatchObject({ status: 'existing', term: 'schema:ComicSeries', on: 'schema:ComicSeries' });
  for (const id of [1002, 1003, 1004, 1005, 1006])
    expect(profile(id), `platform ${id}`).toMatchObject({ status: 'existing', term: 'schema:Book', on: 'schema:Book' });
  for (const template of ['Book', 'PhotoBook', 'Manga', 'Novel', 'BookSeries', 'doujinBook']) {
    const fields = data.infobox.find((entry) => entry.id === template)!.fields;
    for (const field of fields) proposed(field.mapping, `${template}/${field.id}`, found);
  }
  const bookSeries = data.vocabulary.find(
    (entry) => entry.term === 'schema:BookSeries' || entry.reason?.includes('book series'),
  );
  expect(bookSeries?.status).not.toBe('proposed');
  expect(found).toEqual([]);
});

test('manga terms carry labels in all eight UI locales', () => {
  const presentation = bundledSources().presentation;
  const tags = locales.filter((locale) => presentation[`manga/${locale}`]);
  expect(tags).toEqual(locales);
  for (const id of ['schema:ComicSeries', 'schema:PublicationVolume', 'schema:isPartOf', 'wdt:P1433', 'wdt:P2635']) {
    const term = bundledRelease.types[id] ?? bundledRelease.properties[id];
    expect(term, id).toBeDefined();
    expect(Object.keys(term!.labels).sort(), id).toEqual(locales);
    for (const label of Object.values(term!.labels)) expect(label.trim().length, id).toBeGreaterThan(0);
  }
});
