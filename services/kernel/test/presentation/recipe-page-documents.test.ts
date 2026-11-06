import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { recipePageDocuments, recipeTypeAdmitted } from '../../src/presentation/semantic-page.ts';

const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';

test('Recipe descendants admit instruction documents; other types keep the template plan', () => {
  expect(recipeTypeAdmitted(bundledRelease, 'schema:Recipe')).toBe(true);
  expect(recipeTypeAdmitted(bundledRelease, 'schema:Book')).toBe(false);
  expect(recipeTypeAdmitted(undefined, 'schema:Recipe')).toBe(false);
  const overlay = recipePageDocuments(null, bundledRelease, 'schema:Recipe', subject, [
    'schema:cookTime',
    'schema:recipeInstructions',
  ]);
  expect(overlay).toEqual({ kind: 'documents', id: subject, properties: ['schema:recipeInstructions'] });
  expect(
    recipePageDocuments(
      { kind: 'documents', id: subject, properties: ['schema:abstract'] },
      bundledRelease,
      'schema:Recipe',
      subject,
      ['schema:recipeInstructions'],
    ),
  ).toEqual({ kind: 'documents', id: subject, properties: ['schema:abstract', 'schema:recipeInstructions'] });
  expect(recipePageDocuments(null, bundledRelease, 'schema:Book', subject, ['schema:recipeInstructions'])).toBeNull();
  expect(recipePageDocuments(null, bundledRelease, 'schema:Recipe', subject, ['schema:cookTime'])).toBeNull();
});
