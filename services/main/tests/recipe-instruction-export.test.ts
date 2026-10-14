import { expect, test } from 'bun:test';
import { exportRecipe } from '../src/modules/recipe/export.ts';
import type { RecipeInstruction } from '../src/modules/recipe/instructions.ts';
import type { OccurrenceRecord } from '../src/modules/structure/format.ts';

const structure = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const revision = '00000000-0000-4000-8000-000000000002';
const reference: RecipeInstruction['reference'] = { target: structure,
  selector: { grain: 'content', revision, variantId: `urn:rezics:variant:${revision}`, block: 'procedure' } };
const record: OccurrenceRecord = { occurrence: structure, state: 'active', parent: structure,
  role: 'instruction', target: structure, selection: { mode: 'fixed-revision', revision, selector: reference.selector },
  labels: [], introducedBy: structure };

test('procedure export retains empty sections and reports reference projection loss', () => {
  const instruction: RecipeInstruction = { occurrence: structure, reference, status: 'available',
    document: { version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content: [
      { type: 'extensionBlock', attrs: { id: 'procedure', definition: 'https://rezics.com/definition/procedure-v1',
        payload: { items: [{ id: 'empty', type: 'HowToSection', name: { value: 'Sauce', language: 'en' }, items: [] },
          { id: 'stir', type: 'HowToStep', document: { version: 'rezics-document-v1', profile: 'blocks',
            doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Stir.' },
              { type: 'extensionInline', attrs: { fallback: 'tomato', definition: 'https://rezics.com/definition/resource-reference-v1' } }] }] } } }] } } },
    ] } } };
  const exported = exportRecipe([record], structure, [instruction]);
  expect(exported.recipe.recipeInstructions).toEqual([
    { '@type': 'HowToSection', name: 'Sauce', inLanguage: 'en', itemListElement: [] },
    { '@type': 'HowToStep', text: 'Stir.tomato' },
  ]);
  expect(exported.losses).toEqual([{ occurrence: structure, code: 'instruction-form-unsupported',
    pointer: '/instructions/0/document' }, { occurrence: structure, code: 'reference-not-representable',
    pointer: '/instructions/0/document/doc/content/0/attrs/payload/items/1/document/doc/content/0/content/1' }]);
});

test('Schema.org projection reports occurrence links, preparation and held scaling policy', () => {
  const line: OccurrenceRecord = { ...record, role: 'ingredient', selection: undefined, target: undefined,
    qualifier: { type: 'ingredient-line', originalText: { value: 'a pinch of salt', language: 'en' },
      optional: false, parseStatus: 'partial', scaling: 'non-linear', substituteFor: [structure],
      preparation: { value: 'ground', language: 'en' } } };
  const exported = exportRecipe([line], structure);
  expect(exported.losses).toEqual([
    { occurrence: structure, code: 'reference-not-representable', pointer: '/occurrences/0/qualifier/substituteFor' },
    { occurrence: structure, code: 'measurement-not-representable', pointer: '/occurrences/0/qualifier/scaling' },
    { occurrence: structure, code: 'instruction-form-unsupported', pointer: '/occurrences/0/qualifier/preparation' },
  ]);
});

test('missing hydration and recordings are explicit unsupported forms, never silently successful projection', () => {
  expect(exportRecipe([record], structure).losses).toEqual([
    { occurrence: structure, code: 'instruction-form-unsupported', pointer: '/instructions/0/reference/selector' },
  ]);
});

test('Schema.org exchange reports every exact measure it cannot represent with its basis and coverage', () => {
  expect(exportRecipe([], structure, [], [{ kind: 'nutrient', nutrient: 'https://example.test/energy',
    value: { numerator: 1, denominator: 3 }, unitText: 'kcal', basis: 'per-serving', coverage: 'partial',
    provenance: 'computed' }]).losses).toEqual([{ occurrence: structure,
    code: 'measurement-not-representable', pointer: '/measures/0' }]);
});

test('plain-text Post Content is exported with its form loss rather than disappearing', () => {
  const exported = exportRecipe([record], structure, [{ occurrence: structure,
    reference: { target: structure, selector: { grain: 'content', revision, variantId: `urn:rezics:variant:${revision}` } },
    status: 'available', text: 'Simmer for five minutes.' }]);
  expect(exported.recipe.recipeInstructions).toEqual([{ '@type': 'HowToStep', text: 'Simmer for five minutes.' }]);
  expect(exported.losses[0]?.code).toBe('instruction-form-unsupported');
});
