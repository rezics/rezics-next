import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

test('an edition names its authors as Wikidata edition items do', () => {
  const { types } = bundledRelease;
  expect(types['bf:Instance']?.properties).toEqual(expect.arrayContaining(['schema:author', 'schema:translator']));
  expect(types['schema:Book']?.properties).toEqual(expect.arrayContaining(['schema:author']));
});
