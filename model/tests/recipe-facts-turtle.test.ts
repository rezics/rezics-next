import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { shapeSchemas } from '../../packages/model/src/generated/schemas.ts';
import { recipeFactsProfile } from '../definitions/recipe-facts-v1.ts';

const profile = 'https://rezics.com/definition/recipe-facts-v1';
const quantity = { '@id': 'urn:recipe:amount', 'rdf:type': ['https://schema.org/QuantitativeValue'],
  'rv:definitionProfile': [profile] };
const rational = (value: string) => ({ '@value': value, '@type': 'http://www.w3.org/2002/07/owl#rational' });
const check = (role: 'quantity' | 'servings', fields: Record<string, unknown>) =>
  Value.Check(shapeSchemas[`${profile}/${role}-shape`], { ...quantity, ...fields });

test('Recipe SHACL admits exact scalar, paired range and unknown quantities without conflating them', () => {
  expect(check('quantity', { 'schema:value': [rational('1/3')] })).toBe(true);
  expect(check('quantity', { 'schema:minValue': [1], 'schema:maxValue': [rational('4/3')] })).toBe(true);
  expect(check('quantity', { 'schema:unitText': ['pinch'] })).toBe(true);
  for (const fields of [{ 'schema:value': ['1/3'] }, { 'schema:value': [rational('1/0')] },
    { 'schema:minValue': [1] }, { 'schema:maxValue': [2] },
    { 'schema:value': [1], 'schema:minValue': [1], 'schema:maxValue': [2] }]) {
    expect(check('quantity', fields)).toBe(false);
  }
});

test('the serving denominator is positive and has explicit whole-recipe coverage', () => {
  const serving = { 'schema:propertyID': ['https://schema.org/numberOfItems'],
    'schema:unitText': ['servings'], 'rv:basis': ['https://rezics.com/vocab/WholeRecipe'],
    'rv:coverage': ['https://rezics.com/vocab/Partial'], 'prov:wasGeneratedBy': ['urn:recipe:activity'] };
  expect(check('servings', { ...serving, 'schema:value': [2] })).toBe(true);
  expect(check('servings', { ...serving, 'schema:value': [rational('1/2')] })).toBe(true);
  expect(check('servings', { ...serving, 'schema:value': [0] })).toBe(false);
  expect(check('servings', { 'schema:value': [2] })).toBe(false);
  expect(recipeFactsProfile.shapes.find(shape => shape.iri.endsWith('/ingredient-shape'))?.properties
    .some(property => property.path === 'schema:requiredQuantity')).toBe(true);
});
