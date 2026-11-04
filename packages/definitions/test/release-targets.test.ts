import { expect, test } from 'bun:test';
import { bundledRelease, bundledSources } from '../src/bundled.ts';
import { compileCatalogue } from '../src/compile.ts';
import { RELEASE_LIMITS, validateRelease, valueSchema, type Release } from '../src/index.ts';
import { sourcesFor } from './support/library-profiles.ts';

const release = (targets: string[]): Release => ({
  format: 'https://rezics.com/definitions/release/1',
  catalogue: { id: 'https://example.test/catalogue', version: '1.0.0' },
  generator: { name: 'test', version: '1' },
  prefixes: { ex: 'https://example.test/' },
  types: {
    'ex:Leaf': {
      iri: 'https://example.test/Leaf',
      labels: { en: 'leaf' },
      mappings: [],
      bases: ['ex:Base'],
      properties: ['ex:related'],
      facets: [],
    },
    'ex:Other': {
      iri: 'https://example.test/Other',
      labels: { en: 'other' },
      mappings: [],
      bases: [],
      properties: [],
      facets: [],
    },
  },
  properties: {
    'ex:related': {
      iri: 'https://example.test/related',
      labels: { en: 'related item' },
      mappings: [],
      datatype: 'wikibase-item',
      multivalued: false,
      targets,
      qualifiers: [],
      value: valueSchema('wikibase-item'),
    },
  },
});

test('item targets may name a release type or a CURIE in a type bases list', () => {
  expect(validateRelease(release(['ex:Leaf']))).toEqual([]);
  expect(validateRelease(release(['ex:Base']))).toEqual([]);
});

test('an item target outside release types and type bases is refused at its target pointer', () => {
  expect(validateRelease(release(['ex:Missing']))).toEqual([
    { pointer: '/properties/ex:related/targets/0', code: 'invalid' },
  ]);
});

test('follows admits software-release targets without treating VideoGameRelease as CreativeWork', () => {
  expect(bundledRelease.types['wd:Q20631656']!.bases).toEqual([]);
  expect(bundledRelease.types['wd:Q20631656']!.properties).toEqual(
    expect.arrayContaining(['wdt:P155', 'schema:creativeWorkStatus', 'schema:exampleOfWork']),
  );
  expect(bundledRelease.properties['wdt:P155']!.targets).toEqual(['schema:CreativeWork', 'wd:Q20631656']);
  expect(bundledRelease.properties['wdt:P155']!.qualifiers).toEqual(['schema:sameAs']);
  expect(bundledRelease.properties['schema:exampleOfWork']!.qualifiers).toContain('wdt:P31');
  expect(bundledRelease.properties['schema:creativeWorkStatus']).toMatchObject({
    datatype: 'wikibase-item',
    targets: ['skos:Concept'],
  });
  for (const type of ['schema:VideoGame', 'wd:Q689445', 'wd:Q20631656', 'rezics:AnimeRelease', 'bf:Instance'])
    expect(bundledRelease.types[type]!.properties).toContain('schema:creativeWorkStatus');
  expect(bundledRelease.types['schema:Book']!.properties).not.toContain('schema:creativeWorkStatus');
});

test('admitted release status and follows expand at ten and one hundred manifests without new runtime branches', async () => {
  const baseline = await compileCatalogue(bundledSources());
  for (const count of [10, 100]) {
    const expanded = await compileCatalogue(sourcesFor(count, false));
    expect(validateRelease(expanded)).toEqual([]);
    expect(expanded.properties['wdt:P155']!.targets).toEqual(baseline.properties['wdt:P155']!.targets);
    expect(expanded.properties['schema:exampleOfWork']!.qualifiers).toEqual(
      baseline.properties['schema:exampleOfWork']!.qualifiers,
    );
    expect(expanded.types['wd:Q20631656']!.bases).toEqual([]);
    expect(Object.keys(expanded.types).length).toBeLessThanOrEqual(RELEASE_LIMITS.types);
    expect(Object.keys(expanded.properties).length).toBeLessThanOrEqual(RELEASE_LIMITS.properties);
  }
}, 120_000);
