import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importRecipe } from '../src/modules/recipe/importer.ts';
import { checkOccurrenceQualifier } from '../src/modules/structure/format.ts';
import { exportRecipe } from '../src/modules/recipe/export.ts';
import { parseRecipeFile } from '../src/modules/recipe/file-intake.ts';

const parse = (line: string, inLanguage = 'it') => importRecipe({ inLanguage, recipeIngredient: [line] }, 'source').ingredients[0]!.qualifier;
const amount = (numerator: number, denominator = 1) => ({ numerator, denominator });

test('Italian written quantities retain exact values and units without interpreting qualitative amounts as numbers', () => {
  for (const [line, expected, unit, lexical] of [
    ['Farina, grammi 200.', amount(200), 'grammi', '200'],
    ['Uova, N. 2.', amount(2), undefined, '2'],
    ['Latte, decilitri 3.', amount(3), 'decilitri', '3'],
    ['Farina 200 g', amount(200), 'g', '200'],
    ['200 grammi di farina', amount(200), 'grammi', '200'],
    ['Olio, cucchiai 2.', amount(2), 'cucchiai', '2'],
    ['Uova, 2.', amount(2), undefined, '2'],
    ['un cucchiaio di olio', amount(1), 'cucchiaio', 'un'],
    ['Sale, un pizzico.', amount(1), 'pizzico', 'un'],
    ['Mezzo petto di cappone', amount(1, 2), undefined, 'Mezzo'],
    ['Le zampe di due o tre polli.', amount(2), undefined, 'due o tre'],
    ['Sale, q.b.', undefined, undefined, 'q.b.'],
    ['Sale, quanto basta.', undefined, undefined, 'quanto basta.'],
    ['Burro, quanto una noce.', undefined, undefined, 'quanto una noce.'],
  ] as const) {
    const qualifier = parse(line);
    expect(qualifier.amount).toEqual(expected);
    expect(qualifier.unitText).toBe(unit);
    expect(qualifier.amountLexical).toBe(lexical);
    expect(qualifier.originalText).toEqual({ value: line, language: 'it' });
    expect(qualifier.parseStatus).toBe('partial');
    expect(() => checkOccurrenceQualifier(qualifier)).not.toThrow();
  }
  expect(parse('Le zampe di due o tre polli.').amountUpper).toEqual(amount(3));
  expect(parse('flour 2 to 3 cups', 'en').amountUpper).toEqual(amount(3));
  expect(parse('flour 2 to 3 cups', 'en').amountLexical).toBe('2 to 3');
});

test('references, compound quantities, alternatives and absent quantities never manufacture a scalar', () => {
  for (const line of ['Uova, uno intero e un rosso.', 'Un cervello di agnello o mezzo di bestia più grossa.',
    'Una zampa di vitella di latte, oppure grammi 150 di', "Rossi d'uovo N. 3 e, al bisogno, aggiungete una chiara."]) {
    expect(parse(line).amount).toBeUndefined();
    expect(parse(line).amountLexical).toBeDefined();
  }
  for (const line of ['Odore di noce moscata.', 'Farina, idem.', 'Per ogni uovo:',
    'Sale e pepe, niente.', 'Vedi N. 323', 'Burro (vedi N. 323).', 'Farina, grammi 1/0.',
    'Farina, grammi 3 to 2.', '200g farina']) {
    expect(parse(line).amount).toBeUndefined();
    expect(parse(line).amountLexical).toBeUndefined();
  }
  expect(parse("Muscolo senz'osso (vedi N. 323), grammi 500.").amount).toEqual(amount(500));
  expect(parse('una presa', 'en').amount).toBeUndefined();
  expect(parse('un cucchiaio di olio').name).toBe('olio');
});

test('every retained Artusi extract reads only its stated scalar or range and survives file exchange', () => {
  const root = resolve(import.meta.dir, '../../..');
  const pins = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/gutenberg/recipe-extract-pins.json'), 'utf8')) as {
    pins: { id: string; edition: number; sourceSha256: string; ingredientLineCount: number;
      recipes: { id: string; ingredientLines: [number, number] }[] }[];
  };
  const pin = pins.pins.find(item => item.id === 'artusi')!;
  const lock = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/fixtures.lock.json'), 'utf8')) as {
    entries: { source: string; id: string; seed: string; sha256: string }[];
  };
  const entry = lock.entries.find(item => item.source === 'gutenberg' && item.id === `pg${pin.edition}`)!;
  const bytes = readFileSync(resolve(root, entry.seed));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
  const fixture = JSON.parse(bytes.toString('utf8')) as { sourceSha256: string; text: string };
  expect(fixture.sourceSha256).toBe(pin.sourceSha256);
  // One expectation per retained physical line, including continuation lines.
  const expected: Record<string, (number | null)[]> = {
    gelatina: [500, null, null, 2, 2],
    'cappelletti-romagna': [180, 0.5, null, 30, null, null, 1],
    'tortellini-italiana': [300, null, 50, 50, null, null],
    'tortellini-bolognese': [30, 20, 60, 60, 1, null, null],
    panata: [130, 4, 50, null, 1],
    'semolino-composta-ii': [null, 30, 20, 20, 1, null],
    'krapfen-minestra': [100, 20, null, 1, 1],
    'passatelli-di-carne': [150, 50, 30, 15, 15, 2, null, null],
    'nocciuole-di-semolino': [3, 100, 20, null, null, null, null, null],
    'mattoncini-di-ricotta': [200, 30, 2, null, null],
  };
  let total = 0;
  for (const recipe of pin.recipes) {
    const lines = fixture.text.split('\n').slice(recipe.ingredientLines[0] - 1, recipe.ingredientLines[1]).filter(line => line.trim());
    const imported = importRecipe({ inLanguage: 'it', recipeIngredient: lines }, 'artusi');
    expect(imported.ingredients.map(item => item.qualifier.amount ?? null)).toEqual(expected[recipe.id]!.map(value =>
      value === null ? null : value === 0.5 ? amount(1, 2) : amount(value)));
    expect(imported.ingredients.map(item => item.qualifier.originalText.value)).toEqual(lines);
    for (const item of imported.ingredients) checkOccurrenceQualifier(item.qualifier);
    const exported = exportRecipe(imported.ingredients.map((item, index) => ({
      occurrence: `line-${index}`, parent: 'recipe', state: 'active', role: 'ingredient', labels: [],
      introducedBy: 'recipe', qualifier: item.qualifier,
    })), 'recipe');
    expect(parseRecipeFile(Buffer.from(JSON.stringify(exported.recipe)), 'application/ld+json').preview.ingredients
      .map(item => item.qualifier)).toEqual(imported.ingredients.map(item => item.qualifier));
    total += lines.length;
  }
  expect(total).toBe(pin.ingredientLineCount);
  expect(total).toBe(62);
});
