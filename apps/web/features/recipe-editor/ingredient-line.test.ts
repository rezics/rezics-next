import { expect, test } from 'bun:test';
import { composeLine, parseLine, partsOf, partsProblem, qualifierOf, readingLine } from './ingredient-line.ts';
import { scaleIngredients } from '../../../../services/main/src/modules/recipe/operations.ts';
import { checkOccurrenceQualifier, type OccurrenceRecord } from '../../../../services/main/src/modules/structure/format.ts';

test('editor ingredients retain the source spans Main needs for unit conversion with preparation notes', () => {
  const id = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const qualifier = qualifierOf(parseLine('200 g butter, softened'), 'en');
  const occurrence: OccurrenceRecord = { occurrence: id, state: 'active', parent: id, role: 'ingredient',
    labels: [], introducedBy: id, qualifier: checkOccurrenceQualifier(qualifier) };
  expect(scaleIngredients([occurrence], { numerator: 1n, denominator: 1n })).toMatchObject([
    { line: '200 g butter, softened', alternateLine: '7 ⅛ ounces butter, softened', alternateSystem: 'us' },
  ]);
});

test('one typed line splits into quantity, unit, name and note', () => {
  expect(parseLine('1½ cups all-purpose flour, sifted')).toEqual({ quantity: '1½', unit: 'cups', name: 'all-purpose flour', note: 'sifted' });
  expect(parseLine('1 1/2 tsp salt')).toEqual({ quantity: '1 1/2', unit: 'tsp', name: 'salt', note: '' });
  expect(parseLine('2-3 cloves garlic (optional), minced')).toEqual({ quantity: '2-3', unit: 'cloves', name: 'garlic (optional)', note: 'minced' });
  expect(parseLine('250g butter')).toEqual({ quantity: '250', unit: 'g', name: 'butter', note: '' });
  expect(parseLine('2 fl oz milk')).toMatchObject({ quantity: '2', unit: 'fl oz', name: 'milk' });
  expect(parseLine('3 large eggs')).toEqual({ quantity: '3', unit: '', name: 'large eggs', note: '' });
  expect(parseLine('2 eggs')).toEqual({ quantity: '2', unit: '', name: 'eggs', note: '' });
  expect(parseLine('salt to taste')).toEqual({ quantity: '', unit: '', name: 'salt to taste', note: '' });
  expect(parseLine('1 cup of sugar')).toMatchObject({ unit: 'cup', name: 'sugar' });
  expect(parseLine('  ')).toEqual({ quantity: '', unit: '', name: '', note: '' });
});

test('parts compose back to the line Main shows and derive the qualifier Main reads', () => {
  const parts = parseLine('1½ cups flour, sifted');
  expect(composeLine(parts)).toBe('1½ cups flour, sifted');
  const qualifier = qualifierOf(parts, 'en');
  expect(qualifier).toMatchObject({ type: 'ingredient-line', originalText: { value: '1½ cups flour, sifted', language: 'en' },
    amountLexical: '1½', amount: { numerator: 3, denominator: 2 }, unitText: 'cups',
    preparation: { value: 'sifted', language: 'en' }, optional: false, scaling: 'linear', parseStatus: 'parsed', substituteFor: [] });
  expect(partsOf(qualifier)).toEqual(parts);
  const none = qualifierOf(parseLine('salt to taste'), 'en');
  expect(none).toMatchObject({ parseStatus: 'unparsed', scaling: 'not-scalable' });
  expect(none.amount).toBeUndefined();
});

test('an edit keeps what the editor does not show and drops a unit IRI whose text changed', () => {
  const previous = { ...qualifierOf(parseLine('250 g flour'), 'en'), unit: 'https://qudt.org/vocab/unit/GM', optional: true,
    substituteFor: ['https://rezics.com/id/00000000-0000-4000-8000-000000000001'] };
  const same = qualifierOf(parseLine('300 g flour'), 'en', previous);
  expect(same).toMatchObject({ unit: 'https://qudt.org/vocab/unit/GM', optional: true, substituteFor: previous.substituteFor });
  expect(qualifierOf(parseLine('300 ml flour'), 'en', previous).unit).toBeUndefined();
});

test('a stored line reads with the published quantity, whatever way it was typed', () => {
  expect(readingLine(qualifierOf(parseLine('1½ cups flour, sifted'), 'en'))).toBe('1 ½ cups flour, sifted');
  expect(readingLine(qualifierOf(parseLine('1 1/2 cups flour, sifted'), 'en'))).toBe('1 ½ cups flour, sifted');
  expect(readingLine(qualifierOf(parseLine('200 g butter, softened'), 'en'))).toBe('200 g butter, softened');
  expect(readingLine(qualifierOf(parseLine('salt to taste'), 'en'))).toBe('salt to taste');
  expect(readingLine(qualifierOf(parseLine('2-3 cloves garlic'), 'en'))).toBe('2–3 cloves garlic');
  expect(readingLine(qualifierOf(parseLine('¾ tsp salt'), 'en'))).toBe('¾ tsp salt');
});

test('an imported whole-line amount lexeme does not hide the ingredient text', () => {
  const original = '1 1/2 tasse de crème épaisse';
  const imported = { ...qualifierOf(parseLine(original), 'fr'),
    originalText: { value: original, language: 'fr' }, amountLexical: original };
  expect(readingLine(imported)).toBe(original);
});

test('empty and oversized lines are caught before they are sent', () => {
  expect(partsProblem(parseLine(''))).toBe('empty');
  expect(partsProblem({ quantity: '', unit: '', name: 'x'.repeat(1001), note: '' })).toBe('long');
  expect(partsProblem(parseLine('1 cup milk'))).toBeNull();
});

test('a legacy whole ingredient line has one quantity even without a retained amount lexeme', () => {
  const qualifier = qualifierOf(parseLine('2 cups flour'), 'en');
  delete qualifier.amountLexical;
  expect(readingLine(qualifier)).toBe('2 cups flour');
  expect(readingLine({ ...qualifier, amount: { numerator: 3, denominator: 1 } })).toBe('3 cups flour');
  expect(readingLine({ ...qualifier, originalText: { value: 'flour', language: 'en' } })).toBe('2 cups flour');
});
