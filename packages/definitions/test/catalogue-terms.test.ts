import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];

test('titles, same-as links and Wikidata targets have catalogue terms', () => {
  const { types, properties } = bundledRelease;
  expect(properties['schema:name']).toMatchObject({ datatype: 'monolingualtext', multivalued: true });
  expect(properties['schema:sameAs']).toMatchObject({ datatype: 'url', multivalued: true, mappings: ['wd:P2888'] });
  for (const [id, type] of Object.entries(types))
    expect({ id, properties: type.properties }).toEqual({
      id,
      properties: expect.arrayContaining(['schema:name', 'schema:sameAs']),
    });
  for (const id of ['schema:author', 'schema:translator', 'schema:exampleOfWork', 'schema:publisher'])
    expect({ id, qualifiers: properties[id]?.qualifiers }).toEqual({
      id,
      qualifiers: expect.arrayContaining(['schema:sameAs']),
    });
  for (const id of ['schema:name', 'schema:sameAs'])
    expect(Object.keys(properties[id]!.labels).sort()).toEqual(locales);
});
