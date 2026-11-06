import { expect, test } from 'bun:test';
import { releaseDigest } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { facetProperties } from '@rezics/filter';
import { cataloguePageMetadata } from '../../src/presentation/catalogue-page-metadata/index.ts';

test('released CreativeWork descendants carry only their current bounded tag and relation definitions', () => {
  for (const type of ['wd:Q689445', 'schema:VideoGame', 'schema:Movie', 'schema:TVSeries']) {
    const page = cataloguePageMetadata(bundledRelease, bundledDigest, type);
    expect(page).toMatchObject({ state: 'released', type, digest: bundledDigest });
    expect(page?.definitions?.types[type]).toBeDefined();
    // CreativeWork is a released ancestry base, not a type in the bundled catalogue.
    expect(bundledRelease.types[type]?.bases).toContain('schema:CreativeWork');
    expect(page?.definitions?.types['schema:CreativeWork']).toBeUndefined();
    expect(page?.definitions?.types[type]?.facets).toEqual(bundledRelease.types[type]?.facets);
    for (const property of facetProperties(bundledRelease, [type]))
      expect(page?.definitions?.properties).toHaveProperty(property);
    for (const qualifier of bundledRelease.properties['schema:genre']?.qualifiers ?? [])
      expect(page?.definitions?.properties).toHaveProperty(qualifier);
    expect(page?.directions?.every((entry) => entry.release === bundledDigest)).toBe(true);
    expect(Object.keys(page?.definitions?.types ?? {}).length).toBeLessThan(Object.keys(bundledRelease.types).length);
    expect(Object.keys(page?.definitions?.properties ?? {}).length).toBeLessThan(
      Object.keys(bundledRelease.properties).length,
    );
  }
});

test('released Recipe and SoftwareApplication join catalogue page metadata without CreativeWork ancestry', () => {
  for (const type of ['schema:Recipe', 'schema:SoftwareApplication'] as const) {
    const page = cataloguePageMetadata(bundledRelease, bundledDigest, type);
    expect(page).toMatchObject({ state: 'released', type, digest: bundledDigest });
    expect(page?.definitions?.types[type]).toBeDefined();
    expect(bundledRelease.types[type]?.bases).not.toContain('schema:CreativeWork');
    expect(page?.definitions?.types['schema:CreativeWork']).toBeUndefined();
    expect(page?.directions?.every((entry) => entry.release === bundledDigest)).toBe(true);
  }
  const recipe = cataloguePageMetadata(bundledRelease, bundledDigest, 'schema:Recipe');
  for (const property of [
    'schema:cookTime',
    'schema:suitableForDiet',
    'schema:recipeIngredient',
    'schema:recipeInstructions',
  ])
    expect(recipe?.definitions?.properties).toHaveProperty(property);
});

test('released inheritance admits descendants while an unrelated type remains outside catalogue metadata', () => {
  const release = {
    ...bundledRelease,
    types: {
      ...bundledRelease.types,
      'ex:GameDescendant': {
        ...bundledRelease.types['schema:VideoGame']!,
        bases: ['schema:VideoGame'],
      },
      'ex:Unrelated': {
        ...bundledRelease.types['schema:Place']!,
        bases: ['schema:Thing'],
      },
    },
  };
  const digest = releaseDigest(release);
  const descendant = cataloguePageMetadata(release, digest, 'ex:GameDescendant');
  expect(descendant).toMatchObject({ state: 'released', type: 'ex:GameDescendant', digest });
  expect(descendant?.definitions?.types['schema:VideoGame']).toBeDefined();
  expect(cataloguePageMetadata(release, bundledDigest, 'ex:Unrelated')).toBeUndefined();
});
