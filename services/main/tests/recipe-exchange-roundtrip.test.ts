import { expect, spyOn, test } from 'bun:test';
import { exportRecipe } from '../src/modules/recipe/export.ts';
import { MAX_RECIPE_FILE_BYTES, parseRecipeFile } from '../src/modules/recipe/file-intake.ts';
import { checkOccurrenceRecord, type OccurrenceRecord } from '../src/modules/structure/format.ts';
import { withRecipeImportFixture } from './recipe-import-recovery.test.ts';

const id = (value: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const structure = id(1);
const base = (
  value: number,
  role: OccurrenceRecord['role'],
  parent = structure,
): OccurrenceRecord => ({
  occurrence: id(value),
  parent,
  role,
  state: 'active',
  labels: [],
  introducedBy: id(2),
  segmentKey: 'a',
  orderKey: String(value).padStart(6, '0'),
});
const ingredient = (
  value: number,
  text: string,
  language = 'en',
  quantity?: {
    amount: { numerator: number; denominator: number };
    amountUpper?: { numerator: number; denominator: number };
    amountLexical: string;
    unitText: string;
  },
): OccurrenceRecord => ({
  ...base(value, 'ingredient'),
  qualifier: {
    type: 'ingredient-line',
    originalText: { value: text, language },
    ...quantity,
    optional: false,
    scaling: 'linear',
    substituteFor: [],
    parseStatus: quantity ? 'partial' : 'unparsed',
  },
});
const step = (
  value: number,
  text: string,
  language = 'en',
  parent = structure,
): OccurrenceRecord => ({
  ...base(value, 'step', parent),
  qualifier: {
    type: 'recipe-step',
    instructionText: { value: text, language },
    usesIngredient: [],
    media: [],
    scaling: 'linear',
  },
});
const section = (
  value: number,
  label: string,
  language = 'en',
  parent = structure,
): OccurrenceRecord => ({
  ...base(value, 'group', parent),
  labels: [{ value: label, language }],
});

interface InstructionMeaning {
  kind: 'step' | 'section';
  text: { value: string; language: string } | undefined;
  children?: InstructionMeaning[];
}

/** Occurrence identities and receipt digests change; text, quantities, parents and order must survive. */
function meaning(records: readonly OccurrenceRecord[], root: string) {
  const active = records.filter((record) => record.state === 'active');
  const instructions = (parent: string): InstructionMeaning[] =>
    active
      .filter((record) => record.parent === parent)
      .flatMap((record): InstructionMeaning[] => {
        if (record.role === 'group')
          return [
            { kind: 'section', text: record.labels[0], children: instructions(record.occurrence) },
          ];
        if (record.qualifier?.type === 'recipe-step')
          return [{ kind: 'step', text: record.qualifier.instructionText }];
        return [];
      });
  return {
    ingredients: active.flatMap((record) =>
      record.qualifier?.type === 'ingredient-line'
        ? [
            {
              text: record.qualifier.originalText,
              amount: record.qualifier.amount,
              amountUpper: record.qualifier.amountUpper,
              amountLexical: record.qualifier.amountLexical,
              unit: record.qualifier.unit,
              unitText: record.qualifier.unitText,
            },
          ]
        : [],
    ),
    instructions: instructions(root),
  };
}

async function roundTrip(records: OccurrenceRecord[]) {
  for (const record of records) checkOccurrenceRecord(record, 'recipe-composition');
  const exported = exportRecipe(records, structure);
  // Exercise the exact downloadable Recipe bytes, not a hand-written approximation of export.
  const accepted = parseRecipeFile(
    Buffer.from(JSON.stringify(exported.recipe)),
    'application/ld+json',
  );
  expect(accepted.preview.ingredients.length + accepted.preview.steps.length).toBeGreaterThan(0);
  await withRecipeImportFixture(async (fixture) => {
    const response = await fixture.importFile(exported.recipe);
    expect(response.status).toBe(201);
    expect(meaning(fixture.records, fixture.structure)).toEqual(meaning(records, structure));
  });
}

test('A2: exported ingredient quantities and their original lines survive committed file import', async () => {
  await roundTrip([
    ingredient(10, '200 g butter', 'en', {
      amount: { numerator: 200, denominator: 1 },
      amountLexical: '200',
      unitText: 'g',
    }),
    ingredient(11, '1½ to 2 cups flour', 'en', {
      amount: { numerator: 3, denominator: 2 },
      amountUpper: { numerator: 2, denominator: 1 },
      amountLexical: '1½ to 2',
      unitText: 'cups',
    }),
    step(12, 'Mix gently.'),
  ]);
});

test('A2: mixed ingredient, section and step languages survive committed file import', async () => {
  await roundTrip([
    ingredient(10, 'Salt to taste'),
    ingredient(11, '盐少许', 'zh'),
    ingredient(12, 'زعفران', 'ar'),
    section(20, 'Préparation', 'fr'),
    step(21, 'Mélanger doucement.', 'fr', id(20)),
    step(22, '冷却后食用。', 'zh'),
  ]);
});

test('A2: nested instruction sections retain their parents after committed file import', async () => {
  await roundTrip([
    section(10, 'Dough'),
    section(11, 'Filling', 'en', id(10)),
    step(12, 'Fold in the filling.', 'en', id(11)),
    step(13, 'Rest the dough.', 'en', id(10)),
  ]);
});

test('A2: root steps and sections retain one interleaved instruction order after file import', async () => {
  await roundTrip([
    step(10, 'Preheat.'),
    section(11, 'Mix'),
    step(12, 'Cool.'),
    section(13, 'Finish'),
    step(14, 'Serve.'),
    step(15, 'Whisk.', 'en', id(11)),
    step(16, 'Decorate.', 'en', id(13)),
  ]);
});

function intakeWithoutNetwork(recipe: unknown) {
  const preventNetwork = Object.assign(
    async () => {
      throw new Error('Recipe identifiers must never trigger network resolution');
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const network = spyOn(globalThis, 'fetch').mockImplementation(preventNetwork);
  try {
    return parseRecipeFile(Buffer.from(JSON.stringify(recipe)), 'application/ld+json');
  } finally {
    const requests = network.mock.calls.length;
    network.mockRestore();
    expect(requests).toBe(0);
  }
}

test('A4: native unit IRIs emitted by export are inert identifiers accepted without network access', () => {
  const nativeUnit = id(90);
  const record = ingredient(10, '200 g butter', 'en', {
    amount: { numerator: 200, denominator: 1 },
    amountLexical: '200',
    unitText: 'g',
  });
  if (record.qualifier?.type !== 'ingredient-line')
    throw new Error('Ingredient fixture is invalid');
  record.qualifier.unit = nativeUnit;
  const accepted = intakeWithoutNetwork(exportRecipe([record], structure).recipe);
  expect(accepted.preview.ingredients[0]?.qualifier.unit).toBe(nativeUnit);
});

test('A4: native source occurrence identifiers emitted by export are accepted without resolution', () => {
  const original = step(10, 'Stir.');
  original.sourceKey = `${id(90)}#/recipeInstructions/0`;
  const exported = exportRecipe([original], structure);
  const accepted = intakeWithoutNetwork(exported.recipe);
  expect(
    accepted.preview.steps.map((item) => ({ text: item.text, language: item.language })),
  ).toEqual([{ text: 'Stir.', language: 'en' }]);
});

test('A4: exactly 128 exported occurrences remain importable', () => {
  const records = Array.from({ length: 128 }, (_, index) =>
    ingredient(index + 10, `Ingredient ${index}`),
  );
  const exported = exportRecipe(records, structure);
  expect(
    parseRecipeFile(Buffer.from(JSON.stringify(exported.recipe)), 'application/ld+json').preview
      .ingredients,
  ).toHaveLength(128);
});

test('A4: a 129-occurrence export declares a typed not-importable outcome', () => {
  const records = Array.from({ length: 129 }, (_, index) =>
    ingredient(index + 10, `Ingredient ${index}`),
  );
  const exported = exportRecipe(records, structure);
  expect(exported.recipe.recipeIngredient).toHaveLength(129);
  expect(() =>
    parseRecipeFile(Buffer.from(JSON.stringify(exported.recipe)), 'application/ld+json'),
  ).toThrow();
  // Keep a readable export, but give clients a discriminant and machine-readable reason before download.
  expect(exported).toMatchObject({
    importability: { status: 'not-importable', reason: expect.any(String) },
  });
});

test('A4: export below the file byte limit remains importable', () => {
  const records = Array.from({ length: 64 }, (_, index) => step(index + 10, 'x'.repeat(4000)));
  const exported = exportRecipe(records, structure);
  const bytes = Buffer.from(JSON.stringify(exported.recipe));
  expect(bytes.byteLength).toBeLessThanOrEqual(MAX_RECIPE_FILE_BYTES);
  expect(parseRecipeFile(bytes, 'application/ld+json').preview.steps).toHaveLength(64);
});

test('A4: an export above 256 KiB declares a typed not-importable outcome even below 128 occurrences', () => {
  const records = Array.from({ length: 66 }, (_, index) => step(index + 10, 'x'.repeat(4000)));
  const exported = exportRecipe(records, structure);
  const bytes = Buffer.from(JSON.stringify(exported.recipe));
  expect(bytes.byteLength).toBeGreaterThan(MAX_RECIPE_FILE_BYTES);
  expect(records.length).toBeLessThan(128);
  expect(() => parseRecipeFile(bytes, 'application/ld+json')).toThrow();
  expect(exported).toMatchObject({
    importability: { status: 'not-importable', reason: expect.any(String) },
  });
});
