import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

test('book works and editions register their browse and reverse-lookup facets', () => {
  const { types } = bundledRelease;
  expect(types['schema:Book']!.facets).toEqual(
    expect.arrayContaining(['schema:author', 'schema:genre', 'schema:keywords', 'wdt:P179', 'schema:datePublished']),
  );
  expect(types['schema:Book']!.facets.length).toBeLessThanOrEqual(16);
  expect(types['bf:Instance']!.facets).toEqual(
    expect.arrayContaining([
      'schema:exampleOfWork',
      'schema:author',
      'schema:translator',
      'schema:publisher',
      'schema:datePublished',
      'schema:numberOfPages',
    ]),
  );
  expect(types['bf:Instance']!.facets.length).toBeLessThanOrEqual(16);
});

test('recipes register their browse and reverse-lookup facets', () => {
  expect(bundledRelease.types['schema:Recipe']!.facets).toEqual(
    expect.arrayContaining([
      'schema:author',
      'schema:keywords',
      'schema:datePublished',
      'schema:cookTime',
      'schema:recipeYield',
    ]),
  );
  expect(bundledRelease.types['schema:Recipe']!.facets.length).toBeLessThanOrEqual(16);
});
