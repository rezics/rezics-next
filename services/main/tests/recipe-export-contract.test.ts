import { beforeAll, expect, test } from 'bun:test';
import { buildMainOpenApi } from '../../../scripts/api/generate.ts';
import { AnswerRecordValidator, type AnswerContract, type AnswerSample } from '../../../scripts/api/answer-record.ts';
import { answerContractDebtWitnesses } from '../../../tests/qa/support/answer-contract-debts.ts';
import { exportRecipe, RECIPE_EXPORT_OCCURRENCE_LIMIT } from '../src/modules/recipe/export.ts';
import { MAX_RECIPE_IMPORT_BYTES, MAX_RECIPE_IMPORT_OCCURRENCES, MAX_RECIPE_SECTION_DEPTH } from '../src/modules/recipe/importer.ts';
import type { OccurrenceRecord } from '../src/modules/structure/format.ts';

let validator: AnswerRecordValidator;
beforeAll(async () => {
  validator = new AnswerRecordValidator(JSON.parse(await buildMainOpenApi()) as AnswerContract);
}, 60_000);

const id = (index: number) => `https://rezics.com/id/00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const structure = id(1);
function ingredient(index: number): OccurrenceRecord {
  return { occurrence: id(index + 10), state: 'active', parent: structure, role: 'ingredient',
    labels: [], introducedBy: structure, sourceKey: `${id(2)}#ingredient-${index}`,
    qualifier: { type: 'ingredient-line', originalText: { value: '1½–2⅓ g flour', language: 'fr' },
      amount: { numerator: 3, denominator: 2 }, amountUpper: { numerator: 7, denominator: 3 },
      amountLexical: '1½–2⅓', name: 'flour',
      textParts: { amount: { start: 0, end: 5 }, unit: { start: 6, end: 7 }, name: { start: 8, end: 13 } },
      unit: 'https://qudt.org/vocab/unit/GM', unitText: 'g', optional: true,
      scaling: 'linear', substituteFor: [], parseStatus: 'partial', residual: `sha256:${'a'.repeat(64)}` } };
}
function step(index: number, parent = structure, text = `Step ${index}`): OccurrenceRecord {
  return { occurrence: id(index + 1000), state: 'active', parent, role: 'step', labels: [],
    introducedBy: structure, qualifier: { type: 'recipe-step', instructionText: { value: text, language: 'zh' },
      usesIngredient: [], media: [], scaling: 'linear' } };
}
function response(records: OccurrenceRecord[]) {
  return { profile: 'recipe-schema-org-export-v1', structure, revision: id(3),
    ...exportRecipe(records, structure),
    sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' },
    cost: { pages: 2, pagesRead: 3, occurrences: records.length } };
}
function violations(answer: unknown) {
  const sample: AnswerSample = { label: 'schema-org-export', operationId: 'getV1RecipesByIdExportsSchema-org',
    method: 'GET', path: `/v1/recipes/${structure.slice(-36)}/exports/schema-org`, status: 200,
    headers: { 'content-type': 'application/json' }, answer };
  return validator.responseViolations(sample);
}

test('the declared export answer accepts the retained exchange witness without contract debts', () => {
  expect(answerContractDebtWitnesses).toHaveLength(1);
  expect(validator.responseViolations(answerContractDebtWitnesses[0]!)).toEqual([]);
});

test('the real export contract preserves complete producer answers and readable capacity refusals', () => {
  const quantityFree = ingredient(2);
  quantityFree.qualifier = { type: 'ingredient-line', originalText: { value: 'salt to taste', language: 'en' },
    name: 'salt', optional: false, scaling: 'non-linear', substituteFor: [], parseStatus: 'unparsed' };
  const nameless = ingredient(3);
  nameless.qualifier = { type: 'ingredient-line', originalText: { value: '', language: 'ja' },
    optional: false, scaling: 'not-scalable', substituteFor: [], parseStatus: 'parsed' };
  const ordinary = response([ingredient(0), ingredient(1), quantityFree, nameless, step(0), step(1)]);
  expect(ordinary.importability).toEqual({ status: 'importable' });
  expect(ordinary.recipe.recipeIngredient[0]).toMatchObject({ value: '3/2', maxValue: '7/3',
    amountLexical: '1½–2⅓', optional: true, parseStatus: 'partial', inLanguage: 'fr' });
  expect(ordinary.recipe.recipeIngredient[0]).toEqual(ordinary.recipe.recipeIngredient[1]);
  expect(ordinary.recipe.recipeIngredient[2]).not.toHaveProperty('value');
  expect(ordinary.recipe.recipeIngredient[3]).not.toHaveProperty('name');
  expect(ordinary.recipe.recipeInstructions.map(item => item.text)).toEqual(['Step 0', 'Step 1']);
  expect(ordinary.sourceObservations).toEqual([id(2)]);
  expect(ordinary.residuals[0]).toMatchObject({ sourceKey: `${id(2)}#ingredient-0`, residual: `sha256:${'a'.repeat(64)}` });
  expect(violations(ordinary)).toEqual([]);

  const occurrences = response(Array.from({ length: MAX_RECIPE_IMPORT_OCCURRENCES + 1 }, (_, index) => ingredient(index)));
  expect(occurrences.importability).toEqual({ status: 'not-importable', code: 'recipe_not_importable',
    limit: 'occurrences', measured: 129, allowed: MAX_RECIPE_IMPORT_OCCURRENCES });
  const bytes = response(Array.from({ length: 80 }, (_, index) => step(index, structure, 'x'.repeat(4000))));
  expect(bytes.importability).toMatchObject({ status: 'not-importable', code: 'recipe_not_importable',
    limit: 'bytes', allowed: MAX_RECIPE_IMPORT_BYTES });
  const nested: OccurrenceRecord[] = [];
  let parent = structure;
  for (let index = 0; index < MAX_RECIPE_SECTION_DEPTH; index++) {
    const occurrence = id(index + 2000);
    nested.push({ occurrence, state: 'active', parent, role: 'group', labels: [{ value: `Section ${index}`, language: 'en' }],
      introducedBy: structure });
    parent = occurrence;
  }
  nested.push(step(0, parent));
  const depth = response(nested);
  expect(depth.importability).toMatchObject({ status: 'not-importable', code: 'recipe_not_importable', limit: 'depth' });
  const unsupported = ingredient(0);
  unsupported.qualifier = { ...unsupported.qualifier!, type: 'ingredient-line', unit: 'https://example.com/unit/cup' };
  const unit = response([unsupported]);
  expect(unit.importability).toEqual({ status: 'not-importable', code: 'recipe_unit_not_registered', unit: 'https://example.com/unit/cup' });
  for (const answer of [occurrences, bytes, depth, unit]) expect(violations(answer)).toEqual([]);
  expect(violations({ ...ordinary, importability: { status: 'not-importable', code: 'recipe_not_importable',
    limit: 'section-depth', measured: 17, allowed: MAX_RECIPE_SECTION_DEPTH } })).toEqual([]);
});

test('the export contract refuses malformed discriminants, lexical evidence, spans and unknown members', () => {
  const valid = response([ingredient(0), step(0)]);
  expect(violations(valid)).toEqual([]);
  for (const importability of [undefined, { status: 'maybe' }, { status: 'importable', code: 'recipe_not_importable' },
    { status: 'not-importable', code: 'invented', unit: 'g' },
    { status: 'not-importable', code: 'recipe_unit_not_registered' },
    { status: 'not-importable', code: 'recipe_not_importable', limit: 'occurrences', allowed: 128 },
    { status: 'not-importable', code: 'recipe_not_importable', limit: 'bytes', measured: 300000 },
    { status: 'not-importable', code: 'recipe_not_importable', limit: 'ingredients', measured: 129, allowed: 128 },
    { status: 'not-importable', code: 'recipe_not_importable', limit: 'depth', measured: -1, allowed: 32 },
    { status: 'not-importable', code: 'recipe_not_importable', limit: 'depth', measured: 33.5, allowed: 32 },
    { status: 'importable', invented: true }]) {
    expect(violations({ ...valid, importability }), JSON.stringify(importability)).not.toEqual([]);
  }
  const line = valid.recipe.recipeIngredient[0]!;
  for (const patch of [{ amountLexical: 1.5 }, { amountLexical: '' }, { amountLexical: 'x'.repeat(101) },
    { textParts: { amount: { start: 0, end: 2 } } },
    { textParts: { amount: { start: -1, end: 2 }, name: { start: 3, end: 5 } } },
    { textParts: { amount: { start: 0.5, end: 2 }, name: { start: 3, end: 5 } } },
    { textParts: { amount: { start: 0, end: 1001 }, name: { start: 3, end: 5 } } },
    { textParts: { amount: { start: 0, end: 2, invented: true }, name: { start: 3, end: 5 } } },
    { textParts: { amount: { start: 0, end: 2 }, name: { start: 3, end: 5 }, invented: true } },
    { parseStatus: 'guessed' }, { optional: 'yes' }, { text: null }, { maxValue: 2 }, { invented: true }]) {
    expect(violations({ ...valid, recipe: { ...valid.recipe, recipeIngredient: [{ ...line, ...patch }] } }),
      JSON.stringify(patch)).not.toEqual([]);
  }
  for (const answer of [{ ...valid, invented: true }, { ...valid, recipe: { ...valid.recipe, invented: true } },
    { ...valid, residuals: [{ ...valid.residuals[0], invented: true }] },
    { ...valid, sourcePosition: { ...valid.sourcePosition, invented: true } },
    { ...valid, cost: { ...valid.cost, invented: true } },
    { ...valid, recipe: { ...valid.recipe, recipeInstructions: [{ ...valid.recipe.recipeInstructions[0], invented: true }] } },
    { ...valid, recipe: { ...valid.recipe, recipeIngredient: Array(RECIPE_EXPORT_OCCURRENCE_LIMIT + 1).fill(line) } },
    { ...valid, recipe: { ...valid.recipe, recipeInstructions: Array(RECIPE_EXPORT_OCCURRENCE_LIMIT + 1).fill(valid.recipe.recipeInstructions[0]) } }]) {
    expect(violations(answer)).not.toEqual([]);
  }
});
