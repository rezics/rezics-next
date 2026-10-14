import { expect, test } from 'bun:test';
import { exportRecipe } from '../src/modules/recipe/export.ts';
import { parseRecipeFile, RecipeFileInvalid } from '../src/modules/recipe/file-intake.ts';
import { importRecipe, MAX_RECIPE_IMPORT_BYTES, MAX_RECIPE_IMPORT_OCCURRENCES,
  RecipeNotImportable, RecipeInstructionNotSupported, measureRecipeJSON,
  recipeSourceSupportCandidates } from '../src/modules/recipe/importer.ts';
import { RecipeUnitNotRegistered } from '../src/modules/recipe/display.ts';
import type { OccurrenceRecord } from '../src/modules/structure/format.ts';

const id = (index: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const structure = id(1);
const base = (index: number, parent: string, role: OccurrenceRecord['role']): OccurrenceRecord => ({
  occurrence: id(index), parent, role, state: 'active', labels: [], introducedBy: structure,
  sourceKey: `${id(99)}#/source/${index}`,
});
const step = (index: number, parent: string, text: string, language = 'ja'): OccurrenceRecord => ({
  ...base(index, parent, 'step'), qualifier: { type: 'recipe-step',
    instructionText: { value: text, language }, usesIngredient: [], media: [], scaling: 'linear' },
});
const group = (index: number, parent: string, label: string): OccurrenceRecord => ({
  ...base(index, parent, 'group'), labels: [{ value: label, language: 'ja' }],
});
type IngredientLine = Extract<NonNullable<OccurrenceRecord['qualifier']>, { type: 'ingredient-line' }>;
const line = (index: number, original: string, language = 'en',
  facts: Partial<IngredientLine> = {}): OccurrenceRecord & { qualifier: IngredientLine } => ({
  ...base(index, structure, 'ingredient'), qualifier: { type: 'ingredient-line',
    originalText: { value: original, language }, optional: false, scaling: 'linear',
    substituteFor: [], parseStatus: 'partial', ...facts },
});

test('serialized recipe intake preserves ingredient lines, quantities, units, flags and languages', () => {
  const records = [
    line(2, '200 g butter', 'en', { amount: { numerator: 200, denominator: 1 },
      amountLexical: '200', textParts: { amount: { start: 0, end: 3 }, unit: { start: 4, end: 5 }, name: { start: 6, end: 12 } },
      unit: 'https://qudt.org/vocab/unit/GM', unitText: 'g', parseStatus: 'parsed' }),
    line(3, '½–¾ l lait', 'fr', { amount: { numerator: 1, denominator: 2 },
      amountUpper: { numerator: 3, denominator: 4 }, amountLexical: '½–¾',
      textParts: { amount: { start: 0, end: 3 }, unit: { start: 4, end: 5 }, name: { start: 6, end: 10 } },
      unit: 'https://qudt.org/vocab/unit/L', unitText: 'l', optional: true }),
    line(4, '  1½ cups 小麦粉\t', 'ja', { amount: { numerator: 3, denominator: 2 },
      amountLexical: '1½', textParts: { amount: { start: 2, end: 4 }, unit: { start: 5, end: 9 }, name: { start: 10, end: 14 } }, unitText: 'cups' }),
    line(5, '香菜（可选）', 'zh', { optional: true, parseStatus: 'unparsed' }),
    line(6, ' a handful of herbs ', 'en', { parseStatus: 'unparsed' }),
    line(7, 'about half cup flour', 'en', { amount: { numerator: 1, denominator: 2 },
      amountLexical: 'about half', unitText: 'cup' }),
    line(8, '200 g butter', 'en', { optional: true, parseStatus: 'unparsed' }),
    line(9, '½ cup farine', 'fr', { amount: { numerator: 1, denominator: 3 },
      amountLexical: '½', textParts: { amount: { start: 0, end: 1 }, unit: { start: 2, end: 5 }, name: { start: 6, end: 12 } }, unitText: 'cup' }),
    line(10, 'une pincée de sel', 'fr', { amount: { numerator: 1, denominator: 8 } }),
    line(11, '200 g butter', 'en', { parseStatus: 'unparsed' }),
    line(12, 'water', 'en', { parseStatus: 'parsed' }),
    line(13, 'salt', 'en'),
    line(14, '200 g butter', 'en', { unitText: ' g ' }),
    line(15, 'salt', 'en', { unitText: '\t' }),
    line(16, ' \t', 'en', { parseStatus: 'unparsed' }),
  ];
  const { recipe, sourceObservations } = exportRecipe(records, structure);
  const imported = parseRecipeFile(Buffer.from(JSON.stringify(recipe)), 'application/ld+json').preview;
  expect(imported.ingredients.map(item => item.qualifier)).toEqual(records.map(record => record.qualifier));
  expect(recipe.recipeIngredient[0]).toMatchObject({ text: '200 g butter', value: '200',
    unitCode: 'https://qudt.org/vocab/unit/GM' });
  expect(recipe.recipeIngredient[0]).not.toHaveProperty('name');
  expect(sourceObservations).toEqual([id(99)]);
});

test('content adoption falsifier: unparsed wording has a residual and unsupported instruction forms report their pointer', () => {
  const records = [line(2, 'salt to taste', 'en', { parseStatus: 'unparsed' }),
    line(3, '⅓ cup tomato', 'en', { parseStatus: 'partial', amount: { numerator: 1, denominator: 3 } })];
  const exported = exportRecipe(records, structure);
  expect(exported.residuals).toEqual(records.map(record => ({
    sourceKey: record.sourceKey!, text: record.qualifier.originalText.value,
    parseStatus: record.qualifier.parseStatus, residual: null,
  })));
  expect(exported.sourceObservations).toEqual([id(99)]);
  const imported = parseRecipeFile(Buffer.from(JSON.stringify(exported.recipe)), 'application/ld+json');
  expect(imported.preview.ingredients.map(item => item.qualifier)).toEqual(records.map(record => record.qualifier));
  for (const unsupported of [{ '@type': 'VideoObject', name: 'Recording' },
    { '@type': 'CreativeWork', name: 'Referenced preparation' }, { unexpected: 'instruction' }]) {
    let refused: unknown;
    try {
      importRecipe({ recipeInstructions: ['Before.', { '@type': 'HowToSection', name: 'Method',
        itemListElement: ['Supported.', unsupported] }, 'After.'] }, 'source');
    } catch (error) { refused = error; }
    expect(refused).toBeInstanceOf(RecipeInstructionNotSupported);
    expect(refused).toMatchObject({ code: 'recipe_instruction_not_supported',
      sourcePointer: '/recipeInstructions/1/itemListElement/1' });
  }
});

test('normalized sections retain parents and one order with interleaved multilingual root steps', () => {
  const records = [step(2, structure, '予熱する。'), group(3, structure, '生地'),
    step(4, id(3), '混ぜる。'), group(5, id(3), '仕上げ'), step(6, id(5), '折り込む。'),
    step(7, id(3), '休ませる。'), step(8, structure, '焼く。'), group(9, structure, '空の節')];
  const { recipe } = exportRecipe(records, structure);
  const { source, preview } = parseRecipeFile(Buffer.from(JSON.stringify(recipe)), 'application/ld+json');
  const ordered: Array<{ order: number; kind: string; parent: number; text: string; index?: number }> = [
    ...preview.sections.map((item, index) => ({ order: item.order, kind: 'section',
      index, parent: item.parent, text: item.label })),
    ...preview.steps.map(item => ({ order: item.order, kind: 'step', parent: item.section, text: item.text })),
  ].sort((a, b) => a.order - b.order);
  expect(ordered).toEqual([
    { order: 0, kind: 'step', parent: -1, text: '予熱する。' },
    { order: 1, kind: 'section', index: 0, parent: -1, text: '生地' },
    { order: 2, kind: 'step', parent: 0, text: '混ぜる。' },
    { order: 3, kind: 'section', index: 1, parent: 0, text: '仕上げ' },
    { order: 4, kind: 'step', parent: 1, text: '折り込む。' },
    { order: 5, kind: 'step', parent: 0, text: '休ませる。' },
    { order: 6, kind: 'step', parent: -1, text: '焼く。' },
    { order: 7, kind: 'section', index: 2, parent: -1, text: '空の節' },
  ]);
  expect(preview.steps.every(item => item.language === 'ja')).toBe(true);
  expect(new Set([...preview.steps, ...preview.sections].map(item => item.sourceKey)).size).toBe(8);
  expect(recipeSourceSupportCandidates(source, preview).map(item => item.sourcePointer)).toEqual([
    '/recipeInstructions/0/text', '/recipeInstructions/1/itemListElement/0/text',
    '/recipeInstructions/1/itemListElement/1/itemListElement/0/text',
    '/recipeInstructions/1/itemListElement/2/text', '/recipeInstructions/2/text',
  ]);
});

test('normalization counts all occurrences exactly and distinguishes byte capacity from invalid input', () => {
  for (const count of [128, 129, 140]) {
    const source = { recipeIngredient: Array.from({ length: count - 2 }, () => 'salt'),
      recipeInstructions: [{ '@type': 'HowToSection', name: 'Finish', itemListElement: ['Serve.'] }] };
    if (count === MAX_RECIPE_IMPORT_OCCURRENCES) {
      expect(importRecipe(source, 'recipe').ingredients).toHaveLength(126);
      continue;
    }
    let error: unknown;
    try { importRecipe(source, 'recipe'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RecipeNotImportable);
    expect(error).toMatchObject({ code: 'recipe_not_importable', limit: 'occurrences',
      measured: count, allowed: MAX_RECIPE_IMPORT_OCCURRENCES });
  }
  const large = { recipeIngredient: ['salt'], metadata: '香'.repeat(MAX_RECIPE_IMPORT_BYTES) };
  let error: unknown;
  try { importRecipe(large, 'recipe'); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(RecipeNotImportable);
  expect(error).toMatchObject({ code: 'recipe_not_importable', limit: 'bytes',
    measured: Buffer.byteLength(JSON.stringify(large)), allowed: MAX_RECIPE_IMPORT_BYTES });
  expect(() => parseRecipeFile(Buffer.from(JSON.stringify({ '@type': 'Recipe',
    recipeIngredient: ['<b>salt</b>'] })), 'application/json')).toThrow(RecipeFileInvalid);
});

test('module normalization preserves sixteen section levels and rejects a seventeenth', () => {
  const source = (depth: number) => {
    let rows: unknown[] = [{ '@type': 'HowToStep', text: 'Serve.' }];
    for (let index = 0; index < depth; index++) rows = [{ '@type': 'HowToSection',
      name: `Layer ${index}`, itemListElement: rows }];
    return { recipeInstructions: rows };
  };
  const imported = importRecipe(source(16), id(99));
  expect(imported.sections).toHaveLength(16);
  expect(imported.sections.map(item => item.parent)).toEqual(Array.from({ length: 16 }, (_, index) => index - 1));
  expect(imported.steps[0]?.section).toBe(15);
  expect(imported.steps[0]?.order).toBe(16);
  expect([...imported.sections, ...imported.steps].every(item => item.sourceKey.length <= 200)).toBe(true);
  expect(() => importRecipe(source(17), 'recipe')).toThrow(RecipeNotImportable);
});

test('structured names stay verbatim with registered units through export then intake', () => {
  const unitCode = 'https://qudt.org/vocab/unit/GM';
  const imported = importRecipe({ recipeIngredient: [{ name: 'butter', value: '200', unitCode }] }, id(99));
  const qualifier = imported.ingredients[0]!.qualifier;
  expect(qualifier.originalText.value).toBe('butter');
  expect(qualifier.name).toBe('butter');
  const exported = exportRecipe([{ ...base(10, structure, 'ingredient'), qualifier }], structure);
  expect(parseRecipeFile(Buffer.from(JSON.stringify(exported.recipe)), 'application/ld+json')
    .preview.ingredients[0]?.qualifier).toEqual(qualifier);
  const unit = id(999999);
  const unknown = exportRecipe([line(11, 'butter', 'en', { unit })], structure);
  expect(unknown.importability).toEqual({ status: 'not-importable', code: 'recipe_unit_not_registered', unit });
  expect(() => parseRecipeFile(Buffer.from(JSON.stringify(unknown.recipe)), 'application/ld+json'))
    .toThrow(RecipeUnitNotRegistered);
  try { parseRecipeFile(Buffer.from(JSON.stringify(unknown.recipe)), 'application/ld+json'); }
  catch (error) {
    if (!(error instanceof RecipeUnitNotRegistered)) throw error;
    expect(unknown.importability).toEqual(error.importability);
  }
});

test('singleton instruction objects retain sections, children and exact support pointers at every level', () => {
  const recipe = { '@type': 'Recipe', recipeIngredient: ['salt'], recipeInstructions: {
    '@type': 'HowToSection', name: 'Prepare', itemListElement: {
      '@type': 'HowToSection', name: 'Mix', itemListElement: { '@type': 'HowToStep', text: 'Stir.' },
    },
  } };
  const { source, preview } = parseRecipeFile(Buffer.from(JSON.stringify(recipe)), 'application/json');
  expect(preview.sections.map(item => [item.label, item.parent, item.order])).toEqual([
    ['Prepare', -1, 0], ['Mix', 0, 1],
  ]);
  expect(preview.steps[0]).toMatchObject({ text: 'Stir.', section: 1, order: 2 });
  expect(recipeSourceSupportCandidates(source, preview).at(-1)?.sourcePointer)
    .toBe('/recipeInstructions/itemListElement/itemListElement/text');
  for (const unknown of [null, 42, {}, [['Stir.']], { '@type': 'VideoObject', text: 'Stir.' }]) {
    for (const recipeInstructions of [unknown, [unknown], { '@type': 'HowToSection', itemListElement: unknown }]) {
      expect(() => parseRecipeFile(Buffer.from(JSON.stringify({ ...recipe, recipeInstructions })), 'application/json'))
        .toThrow(RecipeInstructionNotSupported);
    }
  }
});

test('empty sections alone are importable occurrences and survive file exchange', () => {
  const exported = exportRecipe([group(10, structure, '仕上げ')], structure);
  expect(exported.importability).toEqual({ status: 'importable' });
  const imported = parseRecipeFile(Buffer.from(JSON.stringify(exported.recipe)), 'application/ld+json').preview;
  expect(imported.sections).toMatchObject([{ label: '仕上げ', parent: -1, order: 0 }]);
  expect(imported.steps).toHaveLength(0);
  expect(imported.ingredients).toHaveLength(0);
});

test('raw JSON depth and section depth remain independent admission limits', () => {
  const records = (depth: number) => [
    ...Array.from({ length: depth }, (_, index) => group(index + 10,
      index ? id(index + 9) : structure, `Layer ${index}`)),
    step(99, id(depth + 9), 'Serve.'),
  ];
  for (const depth of [14, 15, 16]) {
    const exported = exportRecipe(records(depth), structure);
    expect(measureRecipeJSON(exported.recipe).depth).toBe(depth * 2 + 3);
    if (depth >= 15) {
      expect(exported.importability).toEqual({ status: 'not-importable', code: 'recipe_not_importable',
        limit: 'depth', measured: depth * 2 + 3, allowed: 32 });
      expect(() => parseRecipeFile(Buffer.from(JSON.stringify(exported.recipe)), 'application/ld+json'))
        .toThrow(RecipeFileInvalid);
      continue;
    }
    expect(exported.importability).toEqual({ status: 'importable' });
    const preview = parseRecipeFile(Buffer.from(JSON.stringify(exported.recipe)), 'application/ld+json').preview;
    expect(preview.sections.map(item => item.parent))
      .toEqual(Array.from({ length: depth }, (_, index) => index - 1));
    expect(preview.steps[0]).toMatchObject({ section: depth - 1, order: depth, text: 'Serve.' });
  }
  let refusal: unknown;
  try { exportRecipe(records(17), structure); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(RecipeNotImportable);
  expect(refusal).toMatchObject({ code: 'recipe_not_importable', limit: 'section-depth', measured: 17, allowed: 16 });
  let metadata: unknown = 'safe';
  for (let index = 0; index < 33; index++) metadata = { nested: metadata };
  const hostile = { '@type': 'Recipe', recipeIngredient: ['salt'], metadata };
  expect(measureRecipeJSON(hostile).depth).toBeGreaterThan(32);
  expect(() => parseRecipeFile(Buffer.from(JSON.stringify(hostile)), 'application/json')).toThrow(RecipeFileInvalid);
});

test('export metadata and intake refusal carry the same structured importability value', () => {
  const importable = exportRecipe(Array.from({ length: 128 }, (_, index) => line(index + 10, 'salt')), structure);
  expect(importable.importability).toEqual({ status: 'importable' });
  for (const records of [
    Array.from({ length: 129 }, (_, index) => line(index + 10, 'salt')),
    Array.from({ length: 66 }, (_, index) => step(index + 10, structure, 'x'.repeat(4000))),
  ]) {
    const exported = exportRecipe(records, structure);
    const bytes = Buffer.from(JSON.stringify(exported.recipe));
    expect(exported.importability).toMatchObject({ status: 'not-importable', code: 'recipe_not_importable' });
    expect(exported.importability).not.toHaveProperty('reason');
    let error: unknown;
    try { parseRecipeFile(bytes, 'application/ld+json'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RecipeNotImportable);
    expect(exported.importability).toEqual((error as RecipeNotImportable).importability);
  }
});
