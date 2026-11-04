import { expect, test } from 'bun:test';
import { createReleasedRelationDirectionResolver } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '../src/bundled.ts';
import { releaseDigest, validateRelease } from '../src/index.ts';

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];

test('released character appearances and voice credits keep one original property and exact inverse metadata', () => {
  const character = bundledRelease.properties['schema:character']!;
  const voice = bundledRelease.properties['wdt:P725']!;
  expect(validateRelease(bundledRelease)).toEqual([]);
  expect(releaseDigest(bundledRelease)).toBe(bundledDigest);
  expect(character.relation?.inverse).toBe('rezics:appearsIn');
  expect(voice.relation?.inverse).toBe('rezics:voiceActorOf');
  expect(Object.keys(character.relation?.inverseLabels ?? {}).sort()).toEqual(locales.sort());
  expect(Object.keys(voice.relation?.inverseLabels ?? {}).sort()).toEqual(locales.sort());
  expect(character.qualifiers).toEqual(
    expect.arrayContaining(['wdt:P3831', 'wdt:P1932', 'rezics:spoilerLevel', 'wdt:P518', 'wdt:P3629']),
  );
  expect(voice.qualifiers).toEqual(expect.arrayContaining(['wdt:P3831', 'wdt:P1932', 'wdt:P453', 'wdt:P518']));
  expect(bundledRelease.properties['rezics:appearsIn']).toBeUndefined();
  expect(bundledRelease.properties['rezics:voiceActorOf']).toBeUndefined();

  const directions = createReleasedRelationDirectionResolver(bundledRelease, bundledDigest);
  expect(directions.resolve('schema:Person', 'wdt:P725', 'inverse')).toMatchObject({
    state: 'admitted',
    property: 'wdt:P725',
    direction: 'inverse',
    inverse: 'rezics:voiceActorOf',
    sourceTypes: Object.entries(bundledRelease.types)
      .filter(([, definition]) => definition.properties.includes('wdt:P725'))
      .map(([type]) => type)
      .sort(),
    targetTypes: [...(voice.targets ?? [])].sort(),
    release: bundledDigest,
    qualifiers: voice.qualifiers.map((id) => ({
      id,
      datatype: bundledRelease.properties[id]!.datatype,
      labels: bundledRelease.properties[id]!.labels,
    })),
  });
  expect(directions.resolve('wd:Q95074', 'schema:character', 'inverse')).toMatchObject({
    state: 'admitted',
    property: 'schema:character',
    direction: 'inverse',
    inverse: 'rezics:appearsIn',
    release: bundledDigest,
  });
  expect(directions.resolve('wd:Q95074', 'wdt:P725', 'inverse', { viaQualifier: 'wdt:P453' })).toMatchObject({
    state: 'admitted',
    property: 'wdt:P725',
    direction: 'inverse',
    viaQualifier: 'wdt:P453',
    release: bundledDigest,
  });
});
