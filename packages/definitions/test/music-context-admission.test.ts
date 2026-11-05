import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

const locales = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;
const types = [
  'schema:Place',
  'schema:MusicVenue',
  'schema:Event',
  'schema:MusicEvent',
  'schema:AdministrativeArea',
  'wd:Q34379',
];

test('released music-context identities retain distinct place, event, area and instrument grains', () => {
  expect(types.every((type) => !!bundledRelease.types[type])).toBe(true);
  expect(bundledRelease.types['schema:MusicVenue']?.bases).toContain('schema:Place');
  expect(bundledRelease.types['schema:MusicEvent']?.bases).toContain('schema:Event');
  expect(bundledRelease.types['schema:AdministrativeArea']?.bases).toContain('schema:Place');
  expect(bundledRelease.types['wd:Q34379']?.iri).toBe('http://www.wikidata.org/entity/Q34379');
  expect(bundledRelease.types['schema:MusicInstrument']).toBeUndefined();
  for (const id of types) {
    const definition = bundledRelease.types[id]!;
    for (const locale of locales) {
      expect(definition.labels[locale]?.trim().length).toBeGreaterThan(0);
      expect(definition.descriptions?.[locale]?.trim().length).toBeGreaterThan(10);
    }
  }
});

test('event properties preserve sourced time and constrain the exact instrument-qualified performer credit', () => {
  const { properties, types: releasedTypes } = bundledRelease;
  for (const id of ['schema:startDate', 'schema:endDate'] as const) {
    expect(properties[id]?.datatype).toBe('time');
    for (const locale of locales) {
      expect(properties[id]?.labels[locale]?.trim().length).toBeGreaterThan(0);
      expect(properties[id]?.descriptions?.[locale]?.trim().length).toBeGreaterThan(10);
    }
  }
  expect(releasedTypes['schema:MusicEvent']?.properties).toEqual(
    expect.arrayContaining(['schema:location', 'schema:startDate', 'schema:endDate', 'schema:performer']),
  );
  expect(properties['schema:containedInPlace']?.targets).toContain('schema:Place');
  expect(properties['schema:location']?.targets).toContain('schema:Place');
  expect(properties['schema:performer']?.targets).toEqual(['schema:Organization', 'schema:Person']);
  expect(properties['schema:performer']?.qualifiers).toEqual(
    expect.arrayContaining(['wdt:P1303', 'wdt:P1932', 'wdt:P3831']),
  );
  expect(properties['schema:performer']?.relation).toMatchObject({ slotKey: 'wdt:P1303', filter: 'wdt:P1303' });
  expect(properties['wdt:P1303']?.targets).toEqual(['wd:Q34379']);
  for (const id of ['schema:performer', 'wdt:P1303'] as const) {
    for (const locale of locales) {
      expect(properties[id]?.labels[locale]?.trim().length).toBeGreaterThan(0);
      expect(properties[id]?.descriptions?.[locale]?.trim().length).toBeGreaterThan(10);
    }
  }
});
