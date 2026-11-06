import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const filterable = ['wikibase-item', 'time', 'quantity'];

type Decision = {
  status?: string;
  term?: string;
  on?: string;
  reason?: string;
  sources?: string[];
};

const bangumi = () =>
  Bun.YAML.parse(readFileSync(new URL('../sources/bangumi.yaml', import.meta.url), 'utf8')) as {
    vocabulary: Decision[];
    files: { id: string; fields: { id: string; mapping: Decision }[] }[];
    infobox: { id: string; fields: { id: string; mapping: Decision }[] }[];
    enumerations: { id: string; values: { id: string | number; mapping: Decision }[] }[];
  };

const vndb = () =>
  Bun.YAML.parse(readFileSync(new URL('../sources/vndb.yaml', import.meta.url), 'utf8')) as {
    tables: {
      name: string;
      columns: {
        name: string;
        qualifies?: string;
        values?: { value: string; term?: string; mapping?: string; status?: string; reason?: string }[];
      }[];
    }[];
  };

function expectBundled(mapping: Decision, term: string, on: string) {
  expect(mapping).toMatchObject({ status: 'existing', term, on });
  const type = bundledRelease.types[on];
  expect(type).toBeDefined();
  expect(term === on || type!.properties.includes(term)).toBe(true);
}

function expectOmitted(mapping: Decision) {
  expect(mapping.status).toBe('omitted');
  expect(mapping.term).toBeUndefined();
  expect(mapping.reason?.trim().length).toBeGreaterThan(15);
}

test('series are catalogue profiles that members join by an ordered statement', () => {
  const { types, properties } = bundledRelease;
  const series = types['wd:Q7725310'];
  const bookSeries = types['schema:BookSeries'];
  expect(series).toMatchObject({
    bases: ['schema:CreativeWorkSeries', 'schema:CreativeWork', 'schema:Thing'],
  });
  expect(series!.facets).toEqual(expect.arrayContaining(['schema:genre', 'schema:keywords']));
  expect(series!.facets.length).toBeLessThanOrEqual(16);
  expect(bookSeries).toMatchObject({
    mappings: ['wd:Q277759'],
    bases: ['schema:CreativeWorkSeries', 'schema:CreativeWork', 'schema:Thing'],
  });
  expect(bookSeries!.facets).toEqual(expect.arrayContaining(['schema:genre', 'schema:keywords', 'schema:startDate']));
  expect(bookSeries!.facets.length).toBeLessThanOrEqual(16);
  expect(bookSeries!.bases).not.toContain('wd:Q7725310');
  expect(types['wd:Q196600']).toBeUndefined();
  for (const facet of [...series!.facets, ...bookSeries!.facets])
    expect(filterable).toContain(properties[facet]!.datatype);
  expect(properties['wdt:P179']).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: true,
    qualifiers: ['schema:position'],
    targets: ['schema:CreativeWorkSeries'],
  });
  for (const type of ['schema:Book', 'bf:Instance']) expect(types[type]!.properties).toContain('wdt:P179');
  expect(bookSeries!.properties).toEqual(
    expect.arrayContaining([
      'schema:abstract',
      'schema:alternateName',
      'schema:contributor',
      'schema:datePublished',
      'schema:endDate',
      'schema:genre',
      'schema:keywords',
      'schema:name',
      'schema:publisher',
      'schema:startDate',
      'wdt:P1433',
      'wdt:P2635',
      'wdt:P5732',
      'wdt:P973',
    ]),
  );
  expect(properties['wdt:P2635']).toMatchObject({
    datatype: 'quantity',
    minimum: 0,
    maximum: 10_000_000,
    units: ['http://www.wikidata.org/entity/Q1238720', 'http://www.wikidata.org/entity/Q1980247'],
  });
  expect(properties['schema:alternateName']).toMatchObject({ datatype: 'monolingualtext', multivalued: true });
  expect(properties['schema:startDate']).toMatchObject({ datatype: 'time', mappings: ['wd:P580'] });
  expect(properties['schema:endDate']).toMatchObject({ datatype: 'time', mappings: ['wd:P582'] });
  expect(properties['wdt:P1433']).toMatchObject({ datatype: 'wikibase-item', mappings: ['wd:P1433'] });
  expect(properties['wdt:P973']).toMatchObject({ datatype: 'url', mappings: ['wd:P973'] });
});

test('a series carries its own Bangumi identifier, source-precision date and summary as shared terms', () => {
  const { properties, types } = bundledRelease;
  for (const term of ['wdt:P5732', 'schema:datePublished', 'schema:abstract']) {
    expect(types['schema:BookSeries']!.properties).toContain(term);
    expect(types['schema:Book']!.properties).toContain(term);
  }
  expect(properties['wdt:P5732']).toMatchObject({
    datatype: 'external-id',
    mappings: ['wd:P5732'],
    multivalued: false,
    value: { pattern: '^[1-9][0-9]*$' },
  });
  expect(properties['schema:datePublished']).toMatchObject({
    datatype: 'time',
    mappings: ['wd:P577'],
    value: { properties: { precision: { enum: [9, 10, 11] } } },
  });
  expect(properties['schema:abstract']).toMatchObject({
    datatype: 'document',
    multivalued: true,
    value: { required: ['language', 'document'] },
  });
});

test('VNDB and Bangumi series fields are bundled or omitted with a reason', () => {
  const data = bangumi();
  const cited = (page: string) => data.vocabulary.find((entry) => entry.sources?.includes(page));
  expectBundled(cited('https://schema.org/BookSeries')!, 'schema:BookSeries', 'schema:BookSeries');
  expectOmitted(cited('https://schema.org/CreativeWorkSeries')!);

  const subjectSeries = data.files
    .find((file) => file.id === 'subject')!
    .fields.find((field) => field.id === 'series')!;
  expectBundled(subjectSeries.mapping, 'schema:BookSeries', 'schema:BookSeries');
  const seriesFlag = data.enumerations
    .find((group) => group.id === 'subject.series')!
    .values.find((value) => String(value.id) === 'true')!;
  expectBundled(seriesFlag.mapping, 'schema:BookSeries', 'schema:BookSeries');

  const template = Object.fromEntries(
    data.infobox.find((entry) => entry.id === 'BookSeries')!.fields.map((field) => [field.id, field.mapping]),
  );
  expectBundled(template['中文名']!, 'schema:name', 'schema:BookSeries');
  expectBundled(template['别名']!, 'schema:alternateName', 'schema:BookSeries');
  expectBundled(template['出版社']!, 'schema:publisher', 'schema:BookSeries');
  expectBundled(template['连载杂志']!, 'wdt:P1433', 'schema:BookSeries');
  expectBundled(template['开始']!, 'schema:startDate', 'schema:BookSeries');
  expectBundled(template['结束']!, 'schema:endDate', 'schema:BookSeries');
  expectBundled(template['册数']!, 'wdt:P2635', 'schema:BookSeries');
  expectBundled(template['话数']!, 'wdt:P2635', 'schema:BookSeries');
  expectBundled(template['链接']!, 'wdt:P973', 'schema:BookSeries');
  expectOmitted(template['原作']!);
  expectOmitted(template['其他']!);

  const bookRelations = data.enumerations.find((group) => group.id === 'relation.1')!.values;
  const relation = (id: string) => bookRelations.find((value) => String(value.id) === id)!.mapping;
  expectBundled(relation('1002'), 'wdt:P179', 'schema:Book');
  expectOmitted(relation('1003'));

  const ser = vndb()
    .tables.find((table) => table.name === 'vn_relations')!
    .columns.find((column) => column.name === 'relation')!
    .values!.find((value) => value.value === 'ser')!;
  expect(ser).toMatchObject({ status: 'omitted', term: 'wdt:P361', mapping: 'wdt:P361' });
  expect(ser.reason?.trim().length).toBeGreaterThan(15);
});

test('series terms carry labels in all eight UI locales', () => {
  for (const key of [
    'wd:Q7725310',
    'schema:BookSeries',
    'schema:alternateName',
    'schema:startDate',
    'schema:endDate',
    'wdt:P2635',
    'wdt:P1433',
    'wdt:P5732',
    'schema:datePublished',
    'schema:abstract',
    'wdt:P973',
  ]) {
    const term = bundledRelease.types[key] ?? bundledRelease.properties[key];
    expect(term).toBeDefined();
    expect(Object.keys(term!.labels).sort()).toEqual(locales);
    for (const label of Object.values(term!.labels)) expect(label.trim().length).toBeGreaterThan(0);
  }
});
