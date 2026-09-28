// Kitchen display for an exact scaled quantity. The stored rational is unchanged;
// only the line a cook reads is rounded. Volume and weight conversions follow
// the US nutrition-labeling measures in 21 CFR 101.9(b)(5)(viii): 1 tsp = 5 mL,
// 1 Tbsp = 15 mL, 1 cup = 240 mL, 1 fl oz = 30 mL, 1 oz = 28 g. A pint is two
// of those cups (480 mL) and a pound is sixteen of those ounces (448 g).

import { exactRational, type ExactRational } from './quantity.ts';

export interface IngredientPresentation {
  /** Full ingredient in the unit system the recipe was written in. */
  line: string;
  alternateLine?: string;
  alternateSystem?: 'us' | 'metric';
  /** The written line, when the kitchen line is a different amount. */
  hint?: string;
  /** Salt, spices or leavening left unscaled because the batch changed by more than double. */
  judgment?: 'seasoning' | 'leavening';
}

interface Unit {
  singular: string;
  plural: string;
  kind: 'volume' | 'mass' | 'count';
  system: 'us' | 'metric';
  /** Milliliters in one of this unit. */
  ml?: bigint;
  /** Grams in one of this unit. */
  grams?: bigint;
  /** Shown as written for both singular and plural ("240 ml"). */
  abbreviation?: string;
}

const cup: Unit = { singular: 'cup', plural: 'cups', kind: 'volume', system: 'us', ml: 240n };
const tablespoon: Unit = { singular: 'tablespoon', plural: 'tablespoons', kind: 'volume', system: 'us', ml: 15n };
const teaspoon: Unit = { singular: 'teaspoon', plural: 'teaspoons', kind: 'volume', system: 'us', ml: 5n };
const fluidOunce: Unit = { singular: 'fluid ounce', plural: 'fluid ounces', kind: 'volume', system: 'us', ml: 30n };
const pint: Unit = { singular: 'pint', plural: 'pints', kind: 'volume', system: 'us', ml: 480n };
const quart: Unit = { singular: 'quart', plural: 'quarts', kind: 'volume', system: 'us', ml: 960n };
const ounce: Unit = { singular: 'ounce', plural: 'ounces', kind: 'mass', system: 'us', grams: 28n };
const pound: Unit = { singular: 'pound', plural: 'pounds', kind: 'mass', system: 'us', grams: 448n };
const milliliter: Unit = { singular: 'ml', plural: 'ml', kind: 'volume', system: 'metric', ml: 1n, abbreviation: 'ml' };
const liter: Unit = { singular: 'l', plural: 'l', kind: 'volume', system: 'metric', ml: 1000n, abbreviation: 'l' };
const gram: Unit = { singular: 'g', plural: 'g', kind: 'mass', system: 'metric', grams: 1n, abbreviation: 'g' };
const kilogram: Unit = { singular: 'kg', plural: 'kg', kind: 'mass', system: 'metric', grams: 1000n, abbreviation: 'kg' };

const count = (singular: string, plural = `${singular}s`): Unit =>
  ({ singular, plural, kind: 'count', system: 'us' });

const units = new Map<string, Unit>([
  ['cup', cup], ['cups', cup],
  ['tablespoon', tablespoon], ['tablespoons', tablespoon], ['tbsp', tablespoon], ['tbs', tablespoon],
  ['teaspoon', teaspoon], ['teaspoons', teaspoon], ['tsp', teaspoon],
  ['fluid ounce', fluidOunce], ['fluid ounces', fluidOunce], ['fl oz', fluidOunce], ['floz', fluidOunce],
  ['pint', pint], ['pints', pint], ['quart', quart], ['quarts', quart],
  ['ounce', ounce], ['ounces', ounce], ['oz', ounce],
  ['pound', pound], ['pounds', pound], ['lb', pound], ['lbs', pound],
  ['milliliter', milliliter], ['milliliters', milliliter], ['ml', milliliter],
  ['liter', liter], ['liters', liter], ['litre', liter], ['litres', liter], ['l', liter],
  ['gram', gram], ['grams', gram], ['g', gram],
  ['kilogram', kilogram], ['kilograms', kilogram], ['kg', kilogram],
  ['egg', count('egg')], ['eggs', count('egg')],
  ['clove', count('clove')], ['cloves', count('clove')],
  ['slice', count('slice')], ['slices', count('slice')],
  ['piece', count('piece')], ['pieces', count('piece')],
  ['sprig', count('sprig')], ['sprigs', count('sprig')],
  ['can', count('can')], ['cans', count('can')],
  ['bunch', count('bunch', 'bunches')], ['bunches', count('bunch', 'bunches')],
  ['head', count('head')], ['heads', count('head')],
  ['stalk', count('stalk')], ['stalks', count('stalk')],
  ['strip', count('strip')], ['strips', count('strip')],
  ['sheet', count('sheet')], ['sheets', count('sheet')],
  ['fillet', count('fillet')], ['fillets', count('fillet')],
  ['breast', count('breast')], ['breasts', count('breast')],
  ['thigh', count('thigh')], ['thighs', count('thigh')],
  ['drumstick', count('drumstick')], ['drumsticks', count('drumstick')],
  ['rasher', count('rasher')], ['rashers', count('rasher')],
  ['link', count('link')], ['links', count('link')],
  ['pat', count('pat')], ['pats', count('pat')],
]);

const seasonings = ['salt', 'pepper', 'paprika', 'cumin', 'cinnamon', 'nutmeg', 'cayenne', 'chili', 'chilli',
  'spice', 'seasoning', 'oregano', 'thyme', 'rosemary', 'basil', 'saffron', 'turmeric', 'cloves'];
const leavenings = ['baking powder', 'baking soda', 'bicarbonate', 'yeast', 'cream of tartar'];

const snaps = [
  [0n, 1n, ''], [1n, 8n, '⅛'], [1n, 4n, '¼'], [1n, 3n, '⅓'], [3n, 8n, '⅜'], [1n, 2n, '½'],
  [5n, 8n, '⅝'], [2n, 3n, '⅔'], [3n, 4n, '¾'], [7n, 8n, '⅞'], [1n, 1n, '1'],
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function recognizeUnit(unitText: string | undefined): Unit | undefined {
  if (!unitText) return undefined;
  return units.get(unitText.trim().toLowerCase().replace(/\.$/, ''));
}

/** More than double, or less than half. A straight doubling still scales. */
export function largeRatio(factor: ExactRational): boolean {
  return factor.numerator > factor.denominator * 2n || factor.numerator * 2n < factor.denominator;
}

export function judgmentOf(name: string): 'seasoning' | 'leavening' | undefined {
  const haystack = ` ${name.toLowerCase()} `;
  if (leavenings.some(phrase => haystack.includes(` ${phrase} `))) return 'leavening';
  if (seasonings.some(phrase => haystack.includes(` ${phrase} `))) return 'seasoning';
  return undefined;
}

/** The food named by a line, after its written amount and unit. */
export function ingredientName(original: string, lexical: string | undefined, unitText: string | undefined): string {
  let rest = original.trim();
  const lead = lexical?.trim();
  if (lead && rest.toLowerCase().startsWith(lead.toLowerCase())) rest = rest.slice(lead.length).trim();
  const forms = new Set<string>();
  if (unitText?.trim()) forms.add(unitText.trim());
  const known = recognizeUnit(unitText);
  if (known) forms.add(known.singular).add(known.plural);
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    rest = rest.replace(new RegExp(`^${escapeRegExp(form)}\\b`, 'i'), '').trim();
  }
  return rest.replace(/^of\s+/i, '');
}

function atLeast(quantity: ExactRational, whole: bigint): boolean {
  return quantity.numerator >= whole * quantity.denominator;
}

function mul(quantity: ExactRational, by: bigint): ExactRational {
  return exactRational(quantity.numerator * by, quantity.denominator);
}

function div(quantity: ExactRational, by: bigint): ExactRational {
  return exactRational(quantity.numerator, quantity.denominator * by);
}

/** Nearest kitchen fraction: eighths, quarters, thirds, and halves, including ⅓, ½ and ¾. */
function kitchenParts(numerator: bigint, denominator: bigint): { whole: bigint; fraction: string } {
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  let best: (typeof snaps)[number] = snaps[0];
  let bestNum = remainder;
  let bestDen = denominator;
  for (const snap of snaps) {
    const diffNum = remainder * snap[1] - snap[0] * denominator;
    const absNum = diffNum < 0n ? -diffNum : diffNum;
    const diffDen = denominator * snap[1];
    if (absNum * bestDen < bestNum * diffDen) {
      best = snap;
      bestNum = absNum;
      bestDen = diffDen;
    }
  }
  if (best[2] === '1') return { whole: whole + 1n, fraction: '' };
  // A positive amount smaller than half of ⅛ would otherwise read as zero.
  if (best[2] === '' && remainder !== 0n && whole === 0n) return { whole: 0n, fraction: '⅛' };
  return { whole, fraction: best[2] };
}

function formatKitchen(quantity: ExactRational): { text: string; aboveOne: boolean } {
  const parts = kitchenParts(quantity.numerator, quantity.denominator);
  const whole = parts.whole === 0n ? '' : parts.whole.toString();
  const text = whole && parts.fraction ? `${whole} ${parts.fraction}` : whole || parts.fraction || '0';
  return { text, aboveOne: parts.whole > 1n || (parts.whole === 1n && parts.fraction !== '') };
}

function phrase(amount: ExactRational, upper: ExactRational | undefined, unit: Unit | undefined,
  rawUnit: string | undefined, name: string): string {
  const main = formatKitchen(amount);
  const end = upper ? formatKitchen(upper) : null;
  const unitText = unit
    ? (unit.abbreviation ?? ((main.aboveOne || end?.aboveOne) ? unit.plural : unit.singular))
    : rawUnit ?? '';
  const amountText = end ? `${main.text}\u2013${end.text}` : main.text;
  return [amountText, unitText, name].filter(part => part.length > 0).join(' ');
}

function fromMilliliters(ml: ExactRational): { amount: ExactRational; unit: Unit } {
  const cups = div(ml, 240n);
  if (cups.numerator * 4n >= cups.denominator) return { amount: cups, unit: cup };
  const spoons = div(ml, 15n);
  if (atLeast(spoons, 1n)) return { amount: spoons, unit: tablespoon };
  return { amount: div(ml, 5n), unit: teaspoon };
}

function fromGrams(grams: ExactRational): { amount: ExactRational; unit: Unit } {
  const pounds = div(grams, 448n);
  if (pounds.numerator * 2n >= pounds.denominator) return { amount: pounds, unit: pound };
  return { amount: div(grams, 28n), unit: ounce };
}

function converted(amount: ExactRational, upper: ExactRational | undefined, unit: Unit, name: string):
  { line: string; system: 'us' | 'metric' } | null {
  if (unit.kind === 'count') return null;
  if (unit.system === 'us' && unit.ml) {
    const ml = mul(amount, unit.ml);
    const mlUpper = upper ? mul(upper, unit.ml) : undefined;
    const shown = atLeast(ml, 1000n)
      ? { amount: div(ml, 1000n), upper: mlUpper ? div(mlUpper, 1000n) : undefined, unit: liter }
      : { amount: ml, upper: mlUpper, unit: milliliter };
    return { line: phrase(shown.amount, shown.upper, shown.unit, undefined, name), system: 'metric' };
  }
  if (unit.system === 'us' && unit.grams) {
    const grams = mul(amount, unit.grams);
    const gramsUpper = upper ? mul(upper, unit.grams) : undefined;
    const shown = atLeast(grams, 1000n)
      ? { amount: div(grams, 1000n), upper: gramsUpper ? div(gramsUpper, 1000n) : undefined, unit: kilogram }
      : { amount: grams, upper: gramsUpper, unit: gram };
    return { line: phrase(shown.amount, shown.upper, shown.unit, undefined, name), system: 'metric' };
  }
  if (unit.system === 'metric' && unit.ml) {
    const ml = mul(amount, unit.ml);
    const mlUpper = upper ? mul(upper, unit.ml) : undefined;
    const shown = fromMilliliters(ml);
    const shownUpper = mlUpper ? fromMilliliters(mlUpper) : null;
    const end = shownUpper && shownUpper.unit === shown.unit ? shownUpper.amount : undefined;
    return { line: phrase(shown.amount, end, shown.unit, undefined, name), system: 'us' };
  }
  if (unit.system === 'metric' && unit.grams) {
    const grams = mul(amount, unit.grams);
    const gramsUpper = upper ? mul(upper, unit.grams) : undefined;
    const shown = fromGrams(grams);
    const shownUpper = gramsUpper ? fromGrams(gramsUpper) : null;
    const end = shownUpper && shownUpper.unit === shown.unit ? shownUpper.amount : undefined;
    return { line: phrase(shown.amount, end, shown.unit, undefined, name), system: 'us' };
  }
  return null;
}

export function presentQuantity(input: {
  original: string; name: string; unitText?: string; unit?: Unit; amount?: ExactRational;
  amountUpper?: ExactRational; changed: boolean; judgment?: 'seasoning' | 'leavening';
}): IngredientPresentation {
  if (!input.amount) return { line: input.original, ...(input.judgment ? { judgment: input.judgment } : {}) };
  const line = phrase(input.amount, input.amountUpper, input.unit, input.unitText, input.name);
  const alternate = input.unit ? converted(input.amount, input.amountUpper, input.unit, input.name) : null;
  return {
    line,
    ...(alternate ? { alternateLine: alternate.line, alternateSystem: alternate.system } : {}),
    ...(input.changed && line !== input.original ? { hint: input.original } : {}),
    ...(input.judgment ? { judgment: input.judgment } : {}),
  };
}
