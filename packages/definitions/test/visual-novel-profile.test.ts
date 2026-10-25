import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

const uiLocales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
const visualNovelTablePrefix = /^(?:vn|releases|producers)(?:_|$)/u;

test('a visual novel and its releases by platform and language are catalogue profiles', () => {
  const { types, properties } = bundledRelease;
  const visualNovel = types['wd:Q689445'];
  const release = types['bf:Instance'];

  expect(visualNovel?.properties).toEqual(
    expect.arrayContaining([
      'schema:alternateName',
      'schema:character',
      'schema:genre',
      'schema:inLanguage',
      'schema:keywords',
      'wdt:P179',
      'wdt:P3180',
    ]),
  );
  expect(release?.properties).toEqual(
    expect.arrayContaining([
      'schema:datePublished',
      'schema:developer',
      'schema:exampleOfWork',
      'schema:gamePlatform',
      'schema:inLanguage',
      'schema:publisher',
      'wdt:P2899',
      'wdt:P437',
    ]),
  );
  expect(properties['schema:exampleOfWork']).toMatchObject({
    datatype: 'wikibase-item',
    targets: expect.arrayContaining(['wd:Q689445']),
    qualifiers: expect.arrayContaining(['wdt:P3831']),
  });
  expect(properties['schema:gamePlatform']).toMatchObject({
    datatype: 'wikibase-item',
    multivalued: true,
    mappings: ['wd:P400'],
  });
  expect(properties['wdt:P2899']).toMatchObject({ datatype: 'quantity', units: ['http://www.wikidata.org/entity/Q577'] });
  expect(properties['wdt:P437']).toMatchObject({ datatype: 'wikibase-item', multivalued: true });
});

test('VNDB visual novel, release and producer fields are bundled or omitted with a reason', () => {
  const source = readFileSync(new URL('../sources/vndb.yaml', import.meta.url), 'utf8');
  const inventory = Bun.YAML.parse(source) as {
    tables: Array<{
      name: string;
      columns: Array<{ name: string; status: string; term?: string; on?: string; reason?: string }>;
    }>;
  };
  const tables = inventory.tables.filter(({ name }) => visualNovelTablePrefix.test(name));

  expect(tables.length).toBeGreaterThan(0);
  for (const table of tables) {
    for (const column of table.columns) {
      expect(column.status).not.toBe('proposed');
      if (column.status === 'existing') {
        expect(bundledRelease.properties[column.term!]).toBeDefined();
        expect(bundledRelease.types[column.on!]?.properties).toContain(column.term);
      } else {
        expect(column.status).toBe('omitted');
        expect(column.reason).toBeTruthy();
      }
    }
  }
});

test('visual novel terms carry labels in all eight UI locales', () => {
  const profileTerms = [
    'schema:alternateName',
    'schema:gamePlatform',
    'schema:publisher',
    'wdt:P2899',
    'wdt:P437',
  ];
  for (const key of profileTerms) {
    expect(bundledRelease.properties[key]?.labels).toBeDefined();
    expect(Object.keys(bundledRelease.properties[key]!.labels).sort()).toEqual(uiLocales);
  }
  expect(Object.keys(bundledRelease.types['wd:Q689445']!.labels).sort()).toEqual(uiLocales);
  expect(Object.keys(bundledRelease.types['bf:Instance']!.labels).sort()).toEqual(uiLocales);
});
