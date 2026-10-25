import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

const language = 'schema:inLanguage';
const facetLimit = 16;

test('every type with a language registers it as a facet', () => {
  const omissions: string[] = [];
  for (const [key, type] of Object.entries(bundledRelease.types)) {
    if (
      type.properties.includes(language) &&
      !type.facets.includes(language) &&
      type.facets.length < facetLimit
    ) {
      omissions.push(`${key} (${type.facets.length})`);
    }
  }
  expect(omissions).toEqual([]);
});
