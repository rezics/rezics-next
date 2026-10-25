import { expect, test } from 'bun:test';
import { validateRelease, valueSchema, type Release } from '../src/index.ts';

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
