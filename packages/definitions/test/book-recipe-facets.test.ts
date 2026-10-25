import { expect, test } from 'bun:test';
import { bundledRelease } from '../src/bundled.ts';

test('book works and editions register their browse and reverse-lookup facets', () => {
  const { types } = bundledRelease;
  expect(types['schema:Book']!.facets).toEqual([
    'schema:author',
    'schema:genre',
    'schema:keywords',
    'wdt:P179',
    'schema:datePublished',
  ]);
  expect(types['bf:Instance']!.facets).toEqual([
    'schema:exampleOfWork',
    'schema:author',
    'schema:translator',
    'schema:publisher',
    'schema:datePublished',
    'schema:numberOfPages',
  ]);
});

test('recipes register their browse and reverse-lookup facets', () => {
  expect(bundledRelease.types['schema:Recipe']!.facets).toEqual([
    'schema:author',
    'schema:keywords',
    'schema:datePublished',
    'schema:cookTime',
    'schema:recipeYield',
  ]);
});
