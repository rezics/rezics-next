import { expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript-6';
import * as display from '../src/modules/recipe/display.ts';
import { exportRecipe } from '../src/modules/recipe/export.ts';
import * as exchange from '../src/modules/recipe/export.ts';
import { parseRecipeFile } from '../src/modules/recipe/file-intake.ts';
import { importRecipe } from '../src/modules/recipe/importer.ts';
import { scaleIngredients } from '../src/modules/recipe/operations.ts';
import { checkOccurrenceQualifier, type OccurrenceRecord } from '../src/modules/structure/format.ts';
import { structureProfiles } from '../src/modules/recipe/structure-profile.ts';
import type { PlacementState } from '../src/modules/structure/graph.ts';
import { lit, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

type Amount = readonly [number, number];
interface IngredientCase {
  input: string | Record<string, unknown>;
  amount?: Amount;
  upper?: Amount;
  unit?: string;
  iri?: string;
  name?: string;
  lexical?: string;
  shown: string;
  doubled: string;
}
const corpus: readonly IngredientCase[] = [
  { input: '1.50 cups cream', amount: [3, 2], unit: 'cups', name: 'cream', lexical: '1.50', shown: '1 ½ cups cream', doubled: '3 cups cream' },
  { input: '200 克 牛奶', amount: [200, 1], unit: '克', name: '牛奶', lexical: '200', shown: '200 克 牛奶', doubled: '400 克 牛奶' },
  { input: '2 fluid ounces milk', amount: [2, 1], unit: 'fluid ounces', name: 'milk', lexical: '2', shown: '2 fluid ounces milk', doubled: '4 fluid ounces milk' },
  { input: { name: '2 fluid ounces milk', value: 2, unitText: 'fluid ounces' }, amount: [2, 1], unit: 'fluid ounces', name: '2 fluid ounces milk', shown: '2 fluid ounces 2 fluid ounces milk', doubled: '4 fluid ounces 2 fluid ounces milk' },
  { input: '7up soda', shown: '7up soda', doubled: '7up soda' },
  { input: '3M tape', shown: '3M tape', doubled: '3M tape' },
  { input: { name: '5 spice powder', value: '2', unitText: 'g' }, amount: [2, 1], unit: 'g', name: '5 spice powder', shown: '2 g 5 spice powder', doubled: '4 g 5 spice powder' },
  { input: { name: '½cup flour', value: '1/2', unitText: 'cup' }, amount: [1, 2], unit: 'cup', name: '½cup flour', shown: '½ cup ½cup flour', doubled: '1 cup ½cup flour' },
  { input: { name: '1.5–2 cups cream', value: 1.5, maxValue: 2, unitText: 'cups' }, amount: [3, 2], upper: [2, 1], unit: 'cups', name: '1.5–2 cups cream', shown: '1 ½–2 cups 1.5–2 cups cream', doubled: '3–4 cups 1.5–2 cups cream' },
  { input: { name: 'flour', value: 1, maxValue: 2, unitText: 'cups' }, amount: [1, 1], upper: [2, 1], unit: 'cups', name: 'flour', shown: '1–2 cups flour', doubled: '2–4 cups flour' },
  { input: { name: 'flour', value: '2', maxValue: '1', unitText: 'cups' }, unit: 'cups', name: 'flour', shown: 'flour', doubled: 'flour' },
  { input: { name: 'butter', value: '200', unitCode: 'https://qudt.org/vocab/unit/GM' }, amount: [200, 1], iri: 'https://qudt.org/vocab/unit/GM', name: 'butter', shown: '200 g butter', doubled: '400 g butter' },
  { input: { name: '200 g butter', value: 200, unitText: 'g' }, amount: [200, 1], unit: 'g', name: '200 g butter', shown: '200 g 200 g butter', doubled: '400 g 200 g butter' },
  { input: { name: '200g butter', value: 200, unitText: 'g' }, amount: [200, 1], unit: 'g', name: '200g butter', shown: '200 g 200g butter', doubled: '400 g 200g butter' },
  { input: '200g butter', shown: '200g butter', doubled: '200g butter' },
  { input: '½cup flour', shown: '½cup flour', doubled: '½cup flour' },
  { input: '½ cup flour', amount: [1, 2], unit: 'cup', name: 'flour', lexical: '½', shown: '½ cup flour', doubled: '1 cup flour' },
  { input: '⅓ cup flour', amount: [1, 3], unit: 'cup', name: 'flour', lexical: '⅓', shown: '⅓ cup flour', doubled: '⅔ cup flour' },
  { input: '¼ cup flour', amount: [1, 4], unit: 'cup', name: 'flour', lexical: '¼', shown: '¼ cup flour', doubled: '½ cup flour' },
  { input: '⅛ cup flour', amount: [1, 8], unit: 'cup', name: 'flour', lexical: '⅛', shown: '⅛ cup flour', doubled: '¼ cup flour' },
  { input: '1 1/2 cups flour', amount: [3, 2], unit: 'cups', name: 'flour', lexical: '1 1/2', shown: '1 ½ cups flour', doubled: '3 cups flour' },
  { input: '1⁄2 cup flour', amount: [1, 2], unit: 'cup', name: 'flour', lexical: '1⁄2', shown: '½ cup flour', doubled: '1 cup flour' },
  { input: '1½ cups flour', amount: [3, 2], unit: 'cups', name: 'flour', lexical: '1½', shown: '1 ½ cups flour', doubled: '3 cups flour' },
  { input: '½–¾ cup flour', amount: [1, 2], upper: [3, 4], unit: 'cup', name: 'flour', lexical: '½–¾', shown: '½–¾ cup flour', doubled: '1–1 ½ cups flour' },
  { input: '1½ to 2 cups flour', amount: [3, 2], upper: [2, 1], unit: 'cups', name: 'flour', lexical: '1½ to 2', shown: '1 ½–2 cups flour', doubled: '3–4 cups flour' },
  { input: '1.5–2 cups cream', amount: [3, 2], upper: [2, 1], unit: 'cups', name: 'cream', lexical: '1.5–2', shown: '1 ½–2 cups cream', doubled: '3–4 cups cream' },
  { input: '0.125 cup oil', amount: [1, 8], unit: 'cup', name: 'oil', lexical: '0.125', shown: '⅛ cup oil', doubled: '¼ cup oil' },
  { input: '2 千克 面粉', amount: [2, 1], unit: '千克', name: '面粉', lexical: '2', shown: '2 千克 面粉', doubled: '4 千克 面粉' },
  { input: '100 毫升 牛奶', amount: [100, 1], unit: '毫升', name: '牛奶', lexical: '100', shown: '100 毫升 牛奶', doubled: '200 毫升 牛奶' },
  { input: '1 升 牛奶', amount: [1, 1], unit: '升', name: '牛奶', lexical: '1', shown: '1 升 牛奶', doubled: '2 升 牛奶' },
  { input: '2 fl oz milk', amount: [2, 1], unit: 'fl oz', name: 'milk', lexical: '2', shown: '2 fl oz milk', doubled: '4 fl oz milk' },
  { input: '1 fluid ounce milk', amount: [1, 1], unit: 'fluid ounce', name: 'milk', lexical: '1', shown: '1 fluid ounce milk', doubled: '2 fluid ounces milk' },
  { input: 'salt to taste', shown: 'salt to taste', doubled: 'salt to taste' },
  { input: 'a handful of herbs', shown: 'a handful of herbs', doubled: 'a handful of herbs' },
  { input: '  salt to taste\t', shown: '  salt to taste\t', doubled: '  salt to taste\t' },
  { input: '3 to 2 cups flour', shown: '3 to 2 cups flour', doubled: '3 to 2 cups flour' },
  { input: '1/0 cup flour', shown: '1/0 cup flour', doubled: '1/0 cup flour' },
  { input: '200 克糖', amount: [200, 1], name: '克糖', lexical: '200', shown: '200 克糖', doubled: '400 克糖' },
  { input: '200 克́糖', amount: [200, 1], name: '克́糖', lexical: '200', shown: '200 克́糖', doubled: '400 克́糖' },
  { input: '2 fluid ouncesmilk', amount: [2, 1], name: 'fluid ouncesmilk', lexical: '2', shown: '2 fluid ouncesmilk', doubled: '4 fluid ouncesmilk' },
  { input: { name: '', value: 1, unitText: 'cup' }, amount: [1, 1], unit: 'cup', name: '', shown: '1 cup', doubled: '2 cups' },
  { input: '1 cup', amount: [1, 1], unit: 'cup', name: '', lexical: '1', shown: '1 cup', doubled: '2 cups' },
  { input: { name: '  cream\t', value: 1.5, unitText: 'cups' }, amount: [3, 2], unit: 'cups', name: '  cream\t', shown: '1 ½ cups   cream\t', doubled: '3 cups   cream\t' },
  { input: { name: '7up soda', value: 2, unitText: 'cups' }, amount: [2, 1], unit: 'cups', name: '7up soda', shown: '2 cups 7up soda', doubled: '4 cups 7up soda' },
  { input: { name: '3M tape', value: '3/4', unitText: 'G21' }, amount: [3, 4], unit: 'G21', name: '3M tape', shown: '¾ G21 3M tape', doubled: '1 ½ G21 3M tape' },
  { input: { name: 'butter', value: 2, unitCode: 'https://qudt.org/vocab/unit/OZ' }, amount: [2, 1], iri: 'https://qudt.org/vocab/unit/OZ', name: 'butter', shown: '2 oz butter', doubled: '4 oz butter' },
  { input: { name: 'flour', value: 2, maxValue: 1, unitText: 'cups' }, unit: 'cups', name: 'flour', shown: 'flour', doubled: 'flour' },
  { input: { name: '½–¾ cup flour', value: '½–¾', unitText: 'cup' }, amount: [1, 2], upper: [3, 4], unit: 'cup', name: '½–¾ cup flour', shown: '½–¾ cup ½–¾ cup flour', doubled: '1–1 ½ cups ½–¾ cup flour' },
  { input: { name: '1.50 cups cream', value: 1.5, unitText: 'cups' }, amount: [3, 2], unit: 'cups', name: '1.50 cups cream', shown: '1 ½ cups 1.50 cups cream', doubled: '3 cups 1.50 cups cream' },
  { input: { name: '1.50cups cream', value: '1.5', unitText: 'cups' }, amount: [3, 2], unit: 'cups', name: '1.50cups cream', shown: '1 ½ cups 1.50cups cream', doubled: '3 cups 1.50cups cream' },
];
const root = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const exact = (amount: Amount | undefined) => amount ? { numerator: amount[0], denominator: amount[1] } : undefined;

function assertCorpus() {
  for (const [index, row] of corpus.entries()) {
    const source = { recipeIngredient: [row.input] };
    const qualifier = importRecipe(source, root).ingredients[0]!.qualifier;
    expect(qualifier.amount, JSON.stringify(row.input)).toEqual(exact(row.amount));
    expect(qualifier.amountUpper).toEqual(exact(row.upper));
    expect(qualifier.unitText).toBe(row.unit);
    expect(qualifier.unit).toBe(row.iri);
    expect(qualifier.amountLexical).toBe(row.lexical);
    expect(display.ingredientName(qualifier)).toBe(row.name);
    if (qualifier.textParts) {
      if (row.lexical === undefined) throw new Error('A parsed corpus row must name its exact quantity substring');
      if (row.name === undefined) throw new Error('A parsed corpus row must record a food name');
      const { amount, name } = qualifier.textParts;
      expect(qualifier.originalText.value.slice(amount.start, amount.end)).toBe(row.lexical);
      expect(qualifier.originalText.value.slice(name.start, name.end)).toBe(row.name);
    }
    checkOccurrenceQualifier(qualifier);
    const record: OccurrenceRecord = { occurrence: root.replace(/001$/, String(index + 2).padStart(3, '0')),
      parent: root, state: 'active', role: 'ingredient', labels: [], introducedBy: root, qualifier };
    expect(scaleIngredients([record], { numerator: 1n, denominator: 1n })[0]?.line).toBe(row.shown);
    expect(scaleIngredients([record], { numerator: 2n, denominator: 1n })[0]?.line).toBe(row.doubled);
    const exported = exportRecipe([record], root);
    const bytes = Buffer.from(JSON.stringify(exported.recipe));
    const after = parseRecipeFile(bytes, 'application/ld+json').preview.ingredients[0]!.qualifier;
    expect(after).toEqual(qualifier);
  }
}

test('ingredient corpus preserves source names and quantity spans through display, doubling and exchange', () => {
  expect(corpus.length).toBeGreaterThanOrEqual(40);
  assertCorpus();
});

test('standard projection and legacy hydration retain text spans and empty structured names', async () => {
  const profile = structureProfiles[0]!;
  for (const input of ['200 克 牛奶', { name: '', value: 1, unitText: 'cup' }]) {
    const qualifier = importRecipe({ recipeIngredient: [input] }, root).ingredients[0]!.qualifier;
    const state: PlacementState = { occurrence: root, placement: root, active: true, parent: root,
      role: 'ingredient', introducedBy: root, qualifier };
    const projection = profile.projectQualifier!(state, root)!;
    if (qualifier.textParts) expect(projection.triples.some(triple =>
      triple.includes(JSON.stringify(qualifier.textParts).replaceAll('"', '\\"')))).toBe(true);
    if (qualifier.name !== undefined) expect(projection.triples.some(triple =>
      triple.includes(`<https://schema.org/name> ${lit(qualifier.name!)}`))).toBe(true);
    const facts: Record<string, string> = { type: `${RV}IngredientLine`, originalText: qualifier.originalText.value,
      amountNumerator: String(qualifier.amount!.numerator), amountDenominator: String(qualifier.amount!.denominator),
      unitText: qualifier.unitText!, optionality: `${RV}Required`, scaling: `${RV}LinearScaling`,
      parseStatus: `${RV}PartiallyParsed`,
      ...(qualifier.name !== undefined ? { ingredientName: qualifier.name } : {}),
      ...(qualifier.textParts ? { ingredientTextParts: JSON.stringify(qualifier.textParts), amountLexical: qualifier.amountLexical! } : {}),
    };
    const environment = { fuseki: { query: async () => ({ results: { bindings: Object.entries(facts).map(([key, value]) => ({
      p: { value: `${RV}${key}` }, o: { value, ...(key === 'originalText' ? { 'xml:lang': 'en' } : {}) },
    })) } }) } } as unknown as WorkActivationEnvironment;
    expect(await profile.hydrateQualifier!(environment, state)).toEqual(qualifier);
  }
});

type IngredientLine = Extract<NonNullable<OccurrenceRecord['qualifier']>, { type: 'ingredient-line' }>;
const storedLine = (qualifier: IngredientLine): OccurrenceRecord => ({ occurrence: root.replace(/001$/, '002'),
  parent: root, state: 'active', role: 'ingredient', labels: [], introducedBy: root, qualifier });

function assertIndependentFields() {
  const fields: readonly Partial<IngredientLine>[] = [
    { amountLexical: '200' },
    { amount: { numerator: 200, denominator: 1 }, amountUpper: { numerator: 300, denominator: 1 } },
    { unit: 'https://qudt.org/vocab/unit/GM' },
    { unitText: 'g' },
    { name: 'butter' },
    { textParts: { amount: { start: 0, end: 3 }, unit: { start: 4, end: 5 }, name: { start: 6, end: 12 } } },
  ];
  // Every subset proves absence of every other independent field, not just a full new qualifier.
  for (let mask = 0; mask < 2 ** fields.length; mask++) {
    const qualifier: IngredientLine = { type: 'ingredient-line', originalText: { value: '200 g butter', language: 'en' },
      optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'partial' };
    fields.forEach((field, index) => { if (mask & (1 << index)) Object.assign(qualifier, field); });
    checkOccurrenceQualifier(qualifier);
    const exported = exchange.exportRecipe([storedLine(qualifier)], root).recipe;
    expect(exported.recipeIngredient.find(item => typeof item !== 'string')?.amountLexical).toBe(qualifier.amountLexical);
    expect(parseRecipeFile(Buffer.from(JSON.stringify(exported)), 'application/ld+json').preview.ingredients[0]?.qualifier)
      .toEqual(qualifier);
    const doubled = scaleIngredients([storedLine(qualifier)], { numerator: 2n, denominator: 1n })[0]!;
    expect(doubled.sourceLexical).toBe(qualifier.amountLexical);
    expect(doubled.amount).toEqual(qualifier.amount ? { numerator: 400n, denominator: 1n } : undefined);
    expect(doubled.amountUpper).toEqual(qualifier.amountUpper ? { numerator: 600n, denominator: 1n } : undefined);
    expect(doubled.originalText).toBe(qualifier.originalText.value);
    expect(doubled.unitText).toBe(qualifier.unit || qualifier.unitText ? 'g' : undefined);
    if (qualifier.name === undefined && qualifier.textParts === undefined) {
      expect(doubled.line).toBe(qualifier.originalText.value);
      expect(doubled.alternateLine).toBeUndefined();
    }
  }
}

test('the qualifier field table survives every combination of independent field absence', assertIndependentFields);

test('the independent field table kills an exporter that gates lexical wording on spans', () => {
  assertIndependentFields();
  const actualExport = exchange.exportRecipe;
  const mutation = spyOn(exchange, 'exportRecipe').mockImplementation((records, structure) => {
    const result = actualExport(records, structure);
    for (const ingredient of result.recipe.recipeIngredient) {
      if (typeof ingredient !== 'string' && !ingredient.textParts) delete ingredient.amountLexical;
    }
    return result;
  });
  try { expect(assertIndependentFields).toThrow(); }
  finally { mutation.mockRestore(); }
});

test('a literal qualifier written by previous Main returns source and scaled facts separately', () => {
  // Generated by importRecipe({ recipeIngredient: ['200 g butter'] }, 'previous-main') from
  // Main 952e290702fc6718f15a4bfe574846b34015b917, before source spans were introduced.
  // This JSON is deliberately not rebuilt with the current importer or a new-shape factory.
  const qualifier = JSON.parse(`{
    "type": "ingredient-line",
    "originalText": { "value": "200 g butter", "language": "en" },
    "amountLexical": "200",
    "amount": { "numerator": 200, "denominator": 1 },
    "unitText": "g",
    "optional": false,
    "scaling": "linear",
    "substituteFor": [],
    "parseStatus": "partial"
  }`) as IngredientLine;
  const record = storedLine(qualifier);
  expect(scaleIngredients([record], { numerator: 1n, denominator: 1n })[0]?.line).toBe('200 g butter');
  expect(scaleIngredients([record], { numerator: 2n, denominator: 1n })[0]).toMatchObject({
    line: '200 g butter', originalText: '200 g butter', amount: { numerator: 400n, denominator: 1n }, unitText: 'g',
  });
  const recipe = exportRecipe([record], root).recipe;
  expect(recipe.recipeIngredient[0]).toMatchObject({ text: '200 g butter', amountLexical: '200', value: '200', unitText: 'g' });
  expect(recipe.recipeIngredient[0]).not.toHaveProperty('textParts');
  expect(parseRecipeFile(Buffer.from(JSON.stringify(recipe)), 'application/ld+json').preview.ingredients[0]?.qualifier)
    .toEqual(qualifier);
});

test('ingredient views keep quantity fields separate from source text in both supported shapes', () => {
  const cases: readonly { source: Record<string, unknown> & { text: string }; amount: Amount;
    unit: string; composed: string; doubled: string; name?: string }[] = [
    { source: { text: '1.50 cups cream', value: 1.5, amountLexical: '1.5', unitText: 'cups' },
      amount: [3, 2], unit: 'cups', composed: '1 ½ cups cream', doubled: '3 cups cream' },
    { source: { text: '200 克 牛奶', value: 200, amountLexical: '200', unitText: '克' },
      amount: [200, 1], unit: '克', composed: '200 克 牛奶', doubled: '400 克 牛奶' },
    { source: { text: 'butter', value: 200, unitCode: 'https://qudt.org/vocab/unit/GM' },
      amount: [200, 1], unit: 'g', name: 'butter', composed: '200 g butter', doubled: '400 g butter' },
    { source: { text: '100 毫升 牛奶', value: 100, unitText: '毫升' },
      amount: [100, 1], unit: '毫升', composed: '100 毫升 牛奶', doubled: '200 毫升 牛奶' },
    { source: { text: '2.0 cups cream', value: 2, amountLexical: '2', unitText: 'cups' },
      amount: [2, 1], unit: 'cups', composed: '2 cups cream', doubled: '4 cups cream' },
    { source: { text: '0.50 cup flour', value: 0.5, amountLexical: '0.5', unitText: 'cup' },
      amount: [1, 2], unit: 'cup', composed: '½ cup flour', doubled: '1 cup flour' },
    { source: { text: '7up soda', value: 2, amountLexical: '7', unitText: 'cups' },
      amount: [2, 1], unit: 'cups', name: '7up soda', composed: '2 cups 7up soda', doubled: '4 cups 7up soda' },
    { source: { text: '', value: 200, unitCode: 'https://qudt.org/vocab/unit/GM' },
      amount: [200, 1], unit: 'g', name: '', composed: '200 g', doubled: '400 g' },
    { source: { text: 'about half cup flour', value: '1/2', amountLexical: 'about half', unitText: 'cup' },
      amount: [1, 2], unit: 'cup', name: 'flour', composed: '½ cup flour', doubled: '1 cup flour' },
    { source: { text: 'butter', value: 200, unitCode: 'https://qudt.org/vocab/unit/GM', unitText: 'cups' },
      amount: [200, 1], unit: 'g', name: 'butter', composed: '200 g butter', doubled: '400 g butter' },
  ];
  for (const row of cases) {
    const sourceOnly = importRecipe({ recipeIngredient: [row.source] }, root).ingredients[0]!.qualifier;
    const parts = row.name === undefined
      ? importRecipe({ recipeIngredient: [row.source.text] }, root).ingredients[0]!.qualifier.textParts : undefined;
    const composed: IngredientLine = { ...sourceOnly,
      ...(row.name !== undefined ? { name: row.name } : { textParts: parts }) };
    expect(composed.name !== undefined || composed.textParts !== undefined).toBe(true);
    for (const [index, qualifier] of [sourceOnly, composed].entries()) {
      checkOccurrenceQualifier(qualifier);
      const record = storedLine(qualifier);
      const recipe = exportRecipe([record], root).recipe;
      const after = parseRecipeFile(Buffer.from(JSON.stringify(recipe)), 'application/ld+json').preview.ingredients[0]!.qualifier;
      expect(after).toEqual(qualifier);
      for (const factor of [1n, 2n]) {
        const view = scaleIngredients([record], { numerator: factor, denominator: 1n })[0]!;
        expect(view.originalText).toBe(row.source.text);
        expect(view.amount).toBeDefined();
        expect(view.amount!.numerator * BigInt(row.amount[1]))
          .toBe(BigInt(row.amount[0]) * factor * view.amount!.denominator);
        expect(view.unitText).toBe(row.unit);
        expect(view.sourceLexical).toBe(qualifier.amountLexical);
        expect(view.line).toBe(index === 0 ? row.source.text : factor === 1n ? row.composed : row.doubled);
        if (index === 0) expect(view.alternateLine).toBeUndefined();
        expect(scaleIngredients([storedLine(after)], { numerator: factor, denominator: 1n })[0]).toEqual(view);
      }
    }
  }
});

test('every amount, span, name and unit branch preserves source or composes only numeric facts', () => {
  const original = '  1 g salt to taste\t';
  const parsed = importRecipe({ recipeIngredient: [original] }, root).ingredients[0]!.qualifier;
  const units = [
    { fields: { unit: 'https://qudt.org/vocab/unit/GM', unitText: 'cups' }, label: 'g' },
    { fields: { unitText: 'g' }, label: 'g' },
    { fields: {}, label: undefined },
  ];
  let cells = 0;
  for (const quantity of [undefined, 0, 1]) {
    for (const withSpans of [false, true]) {
      for (const name of [undefined, 'salt', '']) {
        for (const unit of units) {
          cells++;
          const qualifier: IngredientLine = { type: 'ingredient-line', originalText: { value: original, language: 'en' },
            amountLexical: '1', optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'partial',
            ...(quantity !== undefined ? { amount: { numerator: quantity, denominator: 1 } } : {}),
            ...(withSpans ? { textParts: parsed.textParts } : {}),
            ...(name !== undefined ? { name } : {}), ...unit.fields };
          checkOccurrenceQualifier(qualifier);
          const stored = structuredClone(qualifier);
          const recipe = exportRecipe([storedLine(qualifier)], root).recipe;
          const after = parseRecipeFile(Buffer.from(JSON.stringify(recipe)), 'application/ld+json').preview.ingredients[0]!.qualifier;
          expect(after).toEqual(stored);
          for (const factor of [1n, 2n]) {
            const view = scaleIngredients([storedLine(qualifier)], { numerator: factor, denominator: 1n })[0]!;
            expect(view.originalText).toBe(original);
            expect(view.unitText).toBe(unit.label);
            expect(view.sourceLexical).toBe('1');
            expect(view.amount).toEqual(quantity !== undefined
              ? { numerator: BigInt(quantity) * factor, denominator: 1n } : undefined);
            expect(view.scaled).toBe(quantity !== undefined);
            if (quantity === undefined || (!withSpans && name === undefined)) {
              expect(view.line).toBe(original);
              expect(view.alternateLine).toBeUndefined();
              expect(view.alternateSystem).toBeUndefined();
              expect(view.hint).toBeUndefined();
            } else {
              // The explicit name wins over spans, including an explicit empty name.
              const food = name ?? 'salt to taste\t';
              const amount = String(BigInt(quantity) * factor);
              expect(view.line).toBe([amount, unit.label ?? '', food].filter(part => part.length > 0).join(' '));
            }
            expect(view.line.length).toBeGreaterThan(0);
            expect(scaleIngredients([storedLine(after)], { numerator: factor, denominator: 1n })[0]).toEqual(view);
          }
          // Reading never mutates or substitutes stored name/unit/source fields.
          expect(qualifier).toEqual(stored);
        }
      }
    }
  }
  expect(cells).toBe(54);
});

test('no numeric amount preserves retained wording for absent, supplied and empty food names', () => {
  for (const text of ['salt to taste', '  salt to taste\t', '200 克 牛奶']) {
    const parsed = importRecipe({ recipeIngredient: [text] }, root).ingredients[0]!.qualifier;
    for (const name of [undefined, 'salt', '']) {
      for (const textParts of [undefined, parsed.textParts]) {
        const qualifier: IngredientLine = { ...parsed, amount: undefined,
          ...(name !== undefined ? { name } : {}), textParts };
        checkOccurrenceQualifier(qualifier);
        const view = scaleIngredients([storedLine(qualifier)], { numerator: 2n, denominator: 1n })[0]!;
        expect(view).toMatchObject({ originalText: text, line: text, scaled: false });
        expect(view.amount).toBeUndefined();
        expect(view.unitText).toBe(qualifier.unitText);
        expect(qualifier.name).toBe(name);
        expect(qualifier.originalText.value).toBe(text);
      }
    }
  }
  for (const ingredient of [{ text: 'salt to taste', name: 'salt' }, { text: 'salt to taste', name: '' }]) {
    const qualifier = importRecipe({ recipeIngredient: [ingredient] }, root).ingredients[0]!.qualifier;
    expect(scaleIngredients([storedLine(qualifier)], { numerator: 1n, denominator: 1n })[0]?.line).toBe(ingredient.text);
  }
});

function assertNoOriginalTextSurgery(source: string) {
  const file = ts.createSourceFile('recipe-view.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = new Set(['originalText', 'original', 'source']);
  const isOriginal = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return aliases.has(node.text);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return isOriginal(node.expression);
    if (ts.isCallExpression(node)) return isOriginal(node.expression) || node.arguments.some(isOriginal);
    if (ts.isPropertyAccessExpression(node)) return node.name.text === 'originalText'
      || node.name.text === 'original' || isOriginal(node.expression);
    if (ts.isElementAccessExpression(node)) return ts.isStringLiteral(node.argumentExpression)
      && ['originalText', 'original'].includes(node.argumentExpression.text) || isOriginal(node.expression);
    return false;
  };
  const gather = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isOriginal(node.initializer)) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, gather);
  };
  gather(file);
  const visit = (node: ts.Node, functionName?: string) => {
    if (ts.isFunctionDeclaration(node)) functionName = node.name?.text;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['startsWith', 'replace', 'replaceAll', 'slice', 'substring', 'substr', 'split'].includes(node.expression.name.text)
      && isOriginal(node.expression.expression)) {
      const allowed = functionName === 'ingredientNameFromSpans' && node.expression.name.text === 'slice'
        && node.expression.expression.getText(file) === 'originalText'
        && node.arguments.length === 2 && node.arguments[0]!.getText(file) === 'span.start'
        && node.arguments[1]!.getText(file) === 'span.end';
      if (!allowed) throw new Error(`Original text surgery: ${node.getText(file)}`);
    }
    ts.forEachChild(node, child => visit(child, functionName));
  };
  visit(file);
}

test('display and scaling allow only the named recorded-span slice of original text', () => {
  for (const module of ['display', 'operations']) {
    assertNoOriginalTextSurgery(readFileSync(new URL(`../src/modules/recipe/${module}.ts`, import.meta.url), 'utf8'));
  }
  for (const expression of [
    'line.originalText.value.startsWith(line.amountLexical)',
    'line.originalText.value.slice(line.amountLexical.length)',
    "line.originalText.value.replace(/^200\\b/, '')",
    "original.replace(/^克\\b/, '')",
    'source.slice(1)',
    'source.toLowerCase().startsWith(line.amountLexical)',
  ]) {
    expect(() => assertNoOriginalTextSurgery(`function read(line) {
      const original = line.originalText.value; const source = original; return ${expression};
    }`)).toThrow('Original text surgery');
  }
  expect(() => assertNoOriginalTextSurgery('function ingredientNameFromSpans(originalText, span) { return originalText.slice(span.start, span.end); }'))
    .not.toThrow();
  expect(() => assertNoOriginalTextSurgery('function ingredientNameFromSpans(originalText, span) { return originalText.slice(1); }'))
    .toThrow('Original text surgery');
});
