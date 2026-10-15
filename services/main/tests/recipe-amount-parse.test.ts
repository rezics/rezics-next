import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importRecipe } from '../src/modules/recipe/importer.ts';
import { recognizeUnit } from '../src/modules/recipe/display.ts';

const parse = (line: string) => importRecipe({ recipeIngredient: [line] }, 'recipe').ingredients[0]!.qualifier;
const amount = (numerator: number, denominator = 1) => ({ numerator, denominator });

const fractions = [
  ['¼', 1, 4], ['½', 1, 2], ['¾', 3, 4],
  ['⅐', 1, 7], ['⅑', 1, 9], ['⅒', 1, 10], ['⅓', 1, 3], ['⅔', 2, 3],
  ['⅕', 1, 5], ['⅖', 2, 5], ['⅗', 3, 5], ['⅘', 4, 5], ['⅙', 1, 6],
  ['⅚', 5, 6], ['⅛', 1, 8], ['⅜', 3, 8], ['⅝', 5, 8], ['⅞', 7, 8],
] as const;

test('every Unicode vulgar fraction imports exactly alone, with a unit, and in mixed numbers', () => {
  for (const [glyph, numerator, denominator] of fractions) {
    for (const line of [glyph, `${glyph} cups flour`]) {
      const parsed = parse(line);
      expect(parsed.amount).toEqual(amount(numerator, denominator));
      expect(parsed.amountUpper).toBeUndefined();
      expect(parsed.amountLexical).toBe(glyph);
      expect(parsed.parseStatus).toBe('partial');
      expect(parsed.unitText).toBe(line === glyph ? undefined : 'cups');
    }
    for (const lexical of [`2${glyph}`, `2 ${glyph}`]) {
      const parsed = parse(`${lexical} cups flour`);
      expect(parsed.amount).toEqual(amount(2 * denominator + numerator, denominator));
      expect(parsed.amountLexical).toBe(lexical);
      expect(parsed.unitText).toBe('cups');
    }
  }
});

test('fraction slash, ASCII fractions and mixed numbers retain only the quantity lexical form', () => {
  for (const [line, numerator, denominator, lexical] of [
    ['1⁄2 cup flour', 1, 2, '1⁄2'], ['2 1⁄2 cups flour', 5, 2, '2 1⁄2'],
    ['2 2/4 cups flour', 5, 2, '2 2/4'], ['6⁄8 cup flour', 3, 4, '6⁄8'],
    ['0½ cups flour', 1, 2, '0½'], ['  1½\t cups flour  ', 3, 2, '1½'],
  ] as const) {
    const parsed = parse(line);
    expect(parsed.amount).toEqual(amount(numerator, denominator));
    expect(parsed.amountLexical).toBe(lexical);
    expect(parsed.originalText.value).toBe(line);
    expect(parsed.unitText).toBe(line.includes('cups') ? 'cups' : 'cup');
  }
});

test('ranges populate both exact endpoints and consume the entire quantity before the unit', () => {
  for (const [line, lower, upper, unitText, lexical] of [
    ['2 to 3 tablespoons butter', amount(2), amount(3), 'tablespoons', '2 to 3'],
    ['2-3 tablespoons butter', amount(2), amount(3), 'tablespoons', '2-3'],
    ['2–3 tablespoons butter', amount(2), amount(3), 'tablespoons', '2–3'],
    ['2 – 3 tablespoons butter', amount(2), amount(3), 'tablespoons', '2 – 3'],
    ['1½ to 2 cups flour', amount(3, 2), amount(2), 'cups', '1½ to 2'],
    ['½–¾ cup butter', amount(1, 2), amount(3, 4), 'cup', '½–¾'],
    ['1/2 to 2 2/4 cups flour', amount(1, 2), amount(5, 2), 'cups', '1/2 to 2 2/4'],
    ['1⁄2-2 1⁄2 cups flour', amount(1, 2), amount(5, 2), 'cups', '1⁄2-2 1⁄2'],
    ['4 or 5 sour apples', amount(4), amount(5), undefined, '4 or 5'],
    ['2 to 2', amount(2), amount(2), undefined, '2 to 2'],
    ['1 to 2.5 cups flour', amount(1), amount(5, 2), 'cups', '1 to 2.5'],
  ] as const) {
    const parsed = parse(line);
    expect(parsed.amount).toEqual(lower);
    expect(parsed.amountUpper).toEqual(upper);
    expect(parsed.unitText).toBe(unitText);
    expect(parsed.amountLexical).toBe(lexical);
    expect(parsed.parseStatus).toBe('partial');
    expect(parsed.scaling).toBe('linear');
  }
});

test('bounds apply before reduction and reject a failed range rather than retaining one endpoint', () => {
  for (const [line, expected] of [
    ['1000000000000 eggs', amount(1_000_000_000_000)],
    ['1/1000000000000 cup flour', amount(1, 1_000_000_000_000)],
    ['1000000000000/1000000000000 cup flour', amount(1)],
    ['499999999999½ cups flour', amount(999_999_999_999, 2)],
    ['0/9 cups flour', amount(0)],
  ] as const) expect(parse(line).amount).toEqual(expected);
  for (const line of [
    '1000000000001 eggs', '1/1000000000001 cup flour',
    '1000000000001/1000000000001 cup flour', '500000000000½ cups flour',
    '1/0 cup flour', '2 1/0 cups flour', '1⁄0 cup flour',
    '-½ cup flour', '⅟ cup flour', '½cup flour', '200g flour', '7up soda', '3M tape',
    '1 to 1/0 cups flour', '1 to 1000000000001 cups flour',
    '1/0 to 2 cups flour', '3 to 2 cups flour',
    '1 to 0.5 cups flour',
  ]) {
    const parsed = parse(line);
    expect(parsed.amount).toBeUndefined();
    expect(parsed.amountUpper).toBeUndefined();
    expect(parsed.unitText).toBeUndefined();
    expect(parsed.amountLexical).toBeUndefined();
    expect(parsed.parseStatus).toBe('unparsed');
  }
});

test('existing scalar ingredient outputs retain their amount, lexical text, unit and status', () => {
  for (const [line, expected, unitText, lexical] of [
    ['1', amount(1), undefined, '1'], ['1 egg', amount(1), 'egg', '1'],
    ['1/2 cup flour', amount(1, 2), 'cup', '1/2'], ['1 1/2 cups flour', amount(3, 2), 'cups', '1 1/2'],
    ['2 1/2-inch pieces', amount(5, 2), undefined, '2 1/2'], ['2-inch pieces', amount(2), undefined, '2'],
    ['Salt to taste', undefined, undefined, undefined],
    ['Grated rind ½ lemon', undefined, undefined, undefined],
    ['1.5 cups flour', amount(3, 2), 'cups', '1.5'],
    ['½cup flour', undefined, undefined, undefined],
    ['1 to ½cup flour', undefined, undefined, undefined],
  ] as const) {
    const parsed = parse(line);
    expect(parsed.amount).toEqual(expected);
    expect(parsed.amountUpper).toBeUndefined();
    expect(parsed.unitText).toBe(unitText);
    expect(parsed.amountLexical).toBe(lexical);
    expect(parsed.parseStatus).toBe(expected ? 'partial' : 'unparsed');
  }
});

test('Boston cookbook pin parses 46 leading fractions and both ranges; its embedded fraction stays unparsed', () => {
  const root = resolve(import.meta.dir, '../../..');
  const pins = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/gutenberg/recipe-extract-pins.json'), 'utf8')) as {
    pins: { id: string; edition: number; sourceSha256: string; ingredientLineCount: number;
      fractionCount: number; rangeCount: number; recipes: { ingredientLines: [number, number] }[] }[];
  };
  const pin = pins.pins.find(item => item.id === 'boston-cookbook')!;
  const lock = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/fixtures.lock.json'), 'utf8')) as {
    entries: { source: string; id: string; seed: string; sha256: string }[];
  };
  const entry = lock.entries.find(item => item.source === 'gutenberg' && item.id === `pg${pin.edition}`)!;
  const bytes = readFileSync(resolve(root, entry.seed));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
  const fixture = JSON.parse(bytes.toString('utf8')) as { sourceSha256: string; text: string };
  expect(fixture.sourceSha256).toBe(pin.sourceSha256);
  const sourceLines = fixture.text.split('\n');
  const lines = pin.recipes.flatMap(recipe => sourceLines
    .slice(recipe.ingredientLines[0] - 1, recipe.ingredientLines[1]).filter(line => line.trim()));
  const expectedAmounts: Record<string, { numerator: number; denominator: number }> = {
    '1': amount(1), '2': amount(2), '3': amount(3), '4': amount(4), '6': amount(6),
    '1½': amount(3, 2), '2½': amount(5, 2), '1¼': amount(5, 4),
    '¼': amount(1, 4), '½': amount(1, 2), '¾': amount(3, 4),
    '⅓': amount(1, 3), '⅔': amount(2, 3), '⅛': amount(1, 8), '⅞': amount(7, 8),
  };
  const imported = importRecipe({ recipeIngredient: lines }, 'boston');
  expect(lines).toHaveLength(pin.ingredientLineCount);
  expect(imported.ingredients).toHaveLength(111);
  let parsedCount = 0;
  let fractionCount = 0;
  let parsedFractionCount = 0;
  let rangeCount = 0;
  const embeddedFractions: string[] = [];
  for (const [index, line] of lines.entries()) {
    const qualifier = imported.ingredients[index]!.qualifier;
    const tokens = line.trim().split(/\s+/u);
    const inline = tokens[0] === 'Yolks' || tokens[0] === 'Whites';
    const expected = expectedAmounts[tokens[inline ? 1 : 0]!];
    const isRange = tokens[1] === 'to' || tokens[1] === 'or';
    expect(qualifier.amountLexical).toBe(expected ? (isRange ? tokens.slice(0, 3).join(' ') : tokens[inline ? 1 : 0]) : undefined);
    expect(qualifier.amount).toEqual(expected);
    if (expected && !inline) {
      expect(qualifier.textParts).toBeDefined();
      expect(qualifier.originalText.value.slice(qualifier.textParts!.amount.start, qualifier.textParts!.amount.end))
        .toBe(qualifier.amountLexical!);
    } else expect(qualifier.textParts).toBeUndefined();
    expect(qualifier.parseStatus).toBe(expected ? 'partial' : 'unparsed');
    expect(qualifier.amountUpper).toEqual(isRange ? amount(Number(tokens[2])) : undefined);
    const writtenUnit = expected ? tokens[isRange ? 3 : inline ? 2 : 1] : undefined;
    expect(qualifier.unitText).toBe(recognizeUnit(writtenUnit) ? writtenUnit : undefined);
    if (expected) parsedCount++;
    if (isRange) rangeCount++;
    if (/[¼½¾⅓⅔⅛⅞]/u.test(line)) {
      fractionCount++;
      if (expected) parsedFractionCount++;
      else embeddedFractions.push(line.trim());
    }
  }
  expect(parsedCount).toBe(94);
  expect(fractionCount).toBe(pin.fractionCount);
  expect(fractionCount).toBe(47);
  expect(parsedFractionCount).toBe(46);
  expect(rangeCount).toBe(pin.rangeCount);
  expect(rangeCount).toBe(2);
  expect(embeddedFractions).toEqual(['Grated rind ½ lemon']);
});
