import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];

test('imported records cite their key, revision and last modification', () => {
  const { types, properties } = bundledRelease;
  expect(properties['schema:version']).toMatchObject({ datatype: 'string', multivalued: false });
  expect(properties['schema:dateModified']).toMatchObject({
    datatype: 'time',
    multivalued: false,
    mappings: ['wd:P5017'],
  });
  expect(properties['wdt:P648']).toMatchObject({ datatype: 'external-id' });
  for (const [id, type] of Object.entries(types))
    expect({
      id,
      attached: type.properties.filter((p) => p === 'schema:version' || p === 'schema:dateModified'),
    }).toEqual({ id, attached: [] });
  for (const id of ['schema:version', 'schema:dateModified'])
    expect(Object.keys(properties[id]!.labels).sort()).toEqual(locales);
});
