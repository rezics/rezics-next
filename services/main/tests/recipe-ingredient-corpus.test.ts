import { expect, spyOn, test } from 'bun:test';
import * as display from '../src/modules/recipe/display.ts';
import { exportRecipe } from '../src/modules/recipe/export.ts';
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
  name: string;
  lexical?: string;
  shown: string;
  doubled: string;
}
const corpus: readonly IngredientCase[] = [
  { input: '1.50 cups cream', amount: [3, 2], unit: 'cups', name: 'cream', lexical: '1.50', shown: '1 ½ cups cream', doubled: '3 cups cream' },
  { input: '200 克 牛奶', amount: [200, 1], unit: '克', name: '牛奶', lexical: '200', shown: '200 克 牛奶', doubled: '400 克 牛奶' },
  { input: '2 fluid ounces milk', amount: [2, 1], unit: 'fluid ounces', name: 'milk', lexical: '2', shown: '2 fluid ounces milk', doubled: '4 fluid ounces milk' },
  { input: { name: '2 fluid ounces milk', value: 2, unitText: 'fluid ounces' }, amount: [2, 1], unit: 'fluid ounces', name: '2 fluid ounces milk', shown: '2 fluid ounces 2 fluid ounces milk', doubled: '4 fluid ounces 2 fluid ounces milk' },
  { input: '7up soda', name: '7up soda', shown: '7up soda', doubled: '7up soda' },
  { input: '3M tape', name: '3M tape', shown: '3M tape', doubled: '3M tape' },
  { input: { name: '5 spice powder', value: '2', unitText: 'g' }, amount: [2, 1], unit: 'g', name: '5 spice powder', shown: '2 g 5 spice powder', doubled: '4 g 5 spice powder' },
  { input: { name: '½cup flour', value: '1/2', unitText: 'cup' }, amount: [1, 2], unit: 'cup', name: '½cup flour', shown: '½ cup ½cup flour', doubled: '1 cup ½cup flour' },
  { input: { name: '1.5–2 cups cream', value: 1.5, maxValue: 2, unitText: 'cups' }, amount: [3, 2], upper: [2, 1], unit: 'cups', name: '1.5–2 cups cream', shown: '1 ½–2 cups 1.5–2 cups cream', doubled: '3–4 cups 1.5–2 cups cream' },
  { input: { name: 'flour', value: 1, maxValue: 2, unitText: 'cups' }, amount: [1, 1], upper: [2, 1], unit: 'cups', name: 'flour', shown: '1–2 cups flour', doubled: '2–4 cups flour' },
  { input: { name: 'flour', value: '2', maxValue: '1', unitText: 'cups' }, unit: 'cups', name: 'flour', shown: 'flour', doubled: 'flour' },
  { input: { name: 'butter', value: '200', unitCode: 'https://qudt.org/vocab/unit/GM' }, amount: [200, 1], iri: 'https://qudt.org/vocab/unit/GM', name: 'butter', shown: '200 g butter', doubled: '400 g butter' },
  { input: { name: '200 g butter', value: 200, unitText: 'g' }, amount: [200, 1], unit: 'g', name: '200 g butter', shown: '200 g 200 g butter', doubled: '400 g 200 g butter' },
  { input: { name: '200g butter', value: 200, unitText: 'g' }, amount: [200, 1], unit: 'g', name: '200g butter', shown: '200 g 200g butter', doubled: '400 g 200g butter' },
  { input: '200g butter', name: '200g butter', shown: '200g butter', doubled: '200g butter' },
  { input: '½cup flour', name: '½cup flour', shown: '½cup flour', doubled: '½cup flour' },
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
  { input: 'salt to taste', name: 'salt to taste', shown: 'salt to taste', doubled: 'salt to taste' },
  { input: 'a handful of herbs', name: 'a handful of herbs', shown: 'a handful of herbs', doubled: 'a handful of herbs' },
  { input: '  salt to taste\t', name: '  salt to taste\t', shown: '  salt to taste\t', doubled: '  salt to taste\t' },
  { input: '3 to 2 cups flour', name: '3 to 2 cups flour', shown: '3 to 2 cups flour', doubled: '3 to 2 cups flour' },
  { input: '1/0 cup flour', name: '1/0 cup flour', shown: '1/0 cup flour', doubled: '1/0 cup flour' },
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

test('the ingredient corpus kills reintroduced lexical and ASCII word-boundary name stripping', () => {
  assertCorpus();
  const mutation = spyOn(display, 'ingredientName').mockImplementation(line => {
    let name = line.originalText.value;
    if (line.amountLexical && name.startsWith(line.amountLexical)) name = name.slice(line.amountLexical.length).trim();
    if (line.unitText) name = name.replace(new RegExp(`^${line.unitText}\\b\\s*`, 'u'), '');
    return name;
  });
  try { expect(assertCorpus).toThrow(); }
  finally { mutation.mockRestore(); }
});

test('native projection and hydration retain text spans and empty structured names', async () => {
  const profile = structureProfiles[0]!;
  for (const input of ['200 克 牛奶', { name: '', value: 1, unitText: 'cup' }]) {
    const qualifier = importRecipe({ recipeIngredient: [input] }, root).ingredients[0]!.qualifier;
    const state: PlacementState = { occurrence: root, placement: root, active: true, parent: root,
      role: 'ingredient', introducedBy: root, qualifier };
    const projection = profile.projectQualifier!(state, root)!;
    if (qualifier.textParts) expect(projection.triples.some(triple =>
      triple.includes(`rv:ingredientTextParts ${lit(JSON.stringify(qualifier.textParts))}`))).toBe(true);
    if (qualifier.name !== undefined) expect(projection.triples.some(triple =>
      triple.includes(`rv:ingredientName ${lit(qualifier.name!)}`))).toBe(true);
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
