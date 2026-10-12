import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { importRecipe, recipeSourceSupportCandidates } from '../src/modules/recipe/importer.ts';
import { scaleIngredients } from '../src/modules/recipe/operations.ts';
import type { OccurrenceRecord } from '../src/modules/structure/format.ts';

test('structured ingredients retain exact decimal behavior alongside Unicode fractions and ranges', () => {
  for (const [value, expected, upper] of [
    [1.5, { numerator: 3, denominator: 2 }, undefined],
    ['0.125', { numerator: 1, denominator: 8 }, undefined],
    ['0.000000000001', { numerator: 1, denominator: 1_000_000_000_000 }, undefined],
    ['0.0000000000001', undefined, undefined],
    ['1000000000000.0', undefined, undefined],
    ['1/2', { numerator: 1, denominator: 2 }, undefined],
    ['2 1/2', { numerator: 5, denominator: 2 }, undefined],
    ['  1½  ', { numerator: 3, denominator: 2 }, undefined],
    ['1⁄2', { numerator: 1, denominator: 2 }, undefined],
    ['½ to ¾', { numerator: 1, denominator: 2 }, { numerator: 3, denominator: 4 }],
    ['1 to 1/0', undefined, undefined],
  ] as const) {
    const [imported] = importRecipe({ recipeIngredient: [{ name: 'flour', value, unitText: 'cups' }] }, 'recipe').ingredients;
    expect(imported?.qualifier.amount).toEqual(expected);
    expect(imported?.qualifier.amountUpper).toEqual(upper);
    expect(imported?.qualifier.amountLexical).toBeUndefined();
    expect(imported?.qualifier.name).toBe('flour');
    expect(imported?.qualifier.unitText).toBe('cups');
    expect(imported?.qualifier.parseStatus).toBe(expected ? 'partial' : 'unparsed');
  }
});

test('imported Unicode range endpoints scale exactly through the existing ingredient operation', () => {
  const [imported] = importRecipe({ recipeIngredient: ['1½ to 2 cups flour'] }, 'recipe').ingredients;
  const record: OccurrenceRecord = {
    occurrence: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001', state: 'active',
    parent: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002', segmentKey: 'a',
    orderKey: 'a', role: 'ingredient', labels: [],
    introducedBy: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003',
    qualifier: imported!.qualifier,
  };
  const [scaled] = scaleIngredients([record], { numerator: 2n, denominator: 1n });
  expect(scaled?.amount).toEqual({ numerator: 3n, denominator: 1n });
  expect(scaled?.amountUpper).toEqual({ numerator: 4n, denominator: 1n });
  expect(scaled?.scaled).toBe(true);
});

test('fraction imports retain source support pointers, language, unit references and source digest', () => {
  const source = { inLanguage: 'fr', recipeIngredient: ['½ tasse farine', {
    name: 'beurre', value: '¾', unitCode: 'https://example.com/units/cup', inLanguage: 'fr',
  }] };
  const imported = importRecipe(source, 'recipe');
  expect(imported.residual).toBe(createHash('sha256').update(JSON.stringify(source)).digest('hex'));
  expect(imported.ingredients[0]?.qualifier.originalText).toEqual({ value: '½ tasse farine', language: 'fr' });
  expect(imported.ingredients[1]?.qualifier.unit).toBe('https://example.com/units/cup');
  expect(imported.ingredients[1]?.qualifier.unitText).toBeUndefined();
  expect(recipeSourceSupportCandidates(source, imported)).toEqual([{
    sourceKey: 'recipe#/recipeIngredient/0', sourceField: 'recipeIngredient',
    sourcePointer: '/recipeIngredient/0', slot: 'structure-occurrence-v1#qualifier.originalText.value',
  }, {
    sourceKey: 'recipe#/recipeIngredient/1', sourceField: 'recipeIngredient',
    sourcePointer: '/recipeIngredient/1/name', slot: 'structure-occurrence-v1#qualifier.originalText.value',
  }]);
});

test('structured ingredient names are retained verbatim without added or removed quantity text', () => {
  for (const [name, value, unitText] of [
    ['200 g butter', '200', 'g'], ['200g butter', 200, 'g'],
    ['1.5 cups cream', 1.5, 'cups'], ['½–¾ cup flour', '½–¾', 'cup'],
    ['1.50 cups cream', 1.5, 'cups'], ['1.50cups cream', '1.5', 'cups'],
  ] as const) {
    const imported = importRecipe({ recipeIngredient: [{ name, value, unitText }] }, 'recipe');
    expect(imported.ingredients[0]?.qualifier.originalText.value).toBe(name);
  }
  const foreign = importRecipe({ recipeIngredient: [{ name: 'butter', value: '200', unitText: 'g' }] }, 'recipe');
  expect(foreign.ingredients[0]?.qualifier.originalText.value).toBe('butter');
  expect(foreign.ingredients[0]?.qualifier.name).toBe('butter');
  const explicit = importRecipe({ recipeIngredient: [{ text: '  200 g butter\t',
    name: 'butter', value: '200', unitText: 'g' }] }, 'recipe');
  expect(explicit.ingredients[0]?.qualifier.originalText.value).toBe('  200 g butter\t');
});

test('structured endpoints remain separate from the verbatim name and reject descending ranges', () => {
  for (const [input, original, lower, upper] of [
    [{ name: '5 spice powder', value: '2', unitText: 'g' }, '5 spice powder', 2, undefined],
    [{ name: '½cup flour', value: '1/2', unitText: 'cup' }, '½cup flour', 0.5, undefined],
    [{ name: '1.5–2 cups cream', value: 1.5, maxValue: 2, unitText: 'cups' }, '1.5–2 cups cream', 1.5, 2],
    [{ name: '1.5–2 cups cream' }, '1.5–2 cups cream', undefined, undefined],
    [{ name: 'flour', value: 1, maxValue: 2, unitText: 'cups' }, 'flour', 1, 2],
    [{ name: 'flour', value: '2', maxValue: '1', unitText: 'cups' }, 'flour', undefined, undefined],
    [{ name: 'flour', value: 2, maxValue: 1, unitText: 'cups', parseStatus: 'parsed' }, 'flour', undefined, undefined],
    [{ name: 'flour', value: 1, maxValue: null, unitText: 'cups' }, 'flour', undefined, undefined],
    [{ name: 'flour', value: 1, maxValue: '1/0', unitText: 'cups' }, 'flour', undefined, undefined],
    [{ name: 'flour', value: '1/2', maxValue: '3/4', unitText: 'cup' }, 'flour', 0.5, 0.75],
  ] as const) {
    const qualifier = importRecipe({ recipeIngredient: [input] }, 'recipe').ingredients[0]!.qualifier;
    expect(qualifier.originalText.value).toBe(original);
    expect(qualifier.amount && qualifier.amount.numerator / qualifier.amount.denominator).toBe(lower);
    expect(qualifier.amountUpper && qualifier.amountUpper.numerator / qualifier.amountUpper.denominator).toBe(upper);
    expect(qualifier.parseStatus).toBe(lower === undefined ? 'unparsed' : 'partial');
  }
});
