import { formatQuantity, leadingAmount, type Rational, sameRational } from './quantity.ts';

// An ingredient is written as one line and kept as parts. The line is what a cook types and what
// Main shows back (`originalText`); the parts are what scaling and unit conversion read.
// Main derives an ingredient's name by removing the written quantity and unit from the line's
// start (`services/main/src/modules/recipe/display.ts`), so the line always starts with exactly
// the quantity and unit text stored beside it.

/** The units Main converts between systems and counts it recognises; others stay as written. */
export const knownUnits = ['cup', 'cups', 'tablespoon', 'tablespoons', 'tbsp', 'teaspoon', 'teaspoons', 'tsp',
  'fl oz', 'pint', 'pints', 'quart', 'quarts', 'ounce', 'ounces', 'oz', 'pound', 'pounds', 'lb', 'lbs',
  'ml', 'l', 'g', 'kg', 'clove', 'cloves', 'slice', 'slices', 'piece', 'pieces', 'sprig', 'sprigs', 'can', 'cans',
  'bunch', 'bunches', 'stalk', 'stalks', 'sheet', 'sheets', 'pinch', 'dash'] as const;
const unitWords = new Set<string>([...knownUnits.filter(unit => !unit.includes(' ')), 'milliliter', 'milliliters',
  'liter', 'liters', 'litre', 'litres', 'gram', 'grams', 'kilogram', 'kilograms', 'tbs', 'floz', 'head', 'heads',
  'strip', 'strips', 'fillet', 'fillets']);

export interface IngredientParts {
  /** The written quantity, a range included ("1½", "2-3"); empty when the line has none. */
  quantity: string;
  unit: string;
  name: string;
  /** A preparation note: "sifted", "finely chopped". */
  note: string;
}

export const emptyParts: IngredientParts = { quantity: '', unit: '', name: '', note: '' };

/** The comma that starts a note: the first one outside parentheses. */
function noteSplit(text: string): [string, string] {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if ((char === ',' || char === '，' || char === '、') && depth === 0) {
      return [text.slice(0, index), text.slice(index + 1)];
    }
  }
  return [text, ''];
}

/** Reads one typed line into parts. A line without a leading quantity keeps everything as the name. */
export function parseLine(line: string): IngredientParts {
  const trimmed = line.trim();
  if (!trimmed) return emptyParts;
  const amount = leadingAmount(trimmed);
  const [body, note] = noteSplit(amount ? amount.rest : trimmed);
  let unit = '';
  let name = body.trim();
  if (amount) {
    const first = /^([\p{L}]+\.?(?:\s+oz\b)?)(?=\s|$)/u.exec(name) ?? /^(fl oz)\b/i.exec(name);
    const word = first?.[1]?.replace(/\.$/, '');
    if (word && (unitWords.has(word.toLowerCase()) || word.toLowerCase() === 'fl oz')) {
      const remainder = name.slice(first![0].length).trim().replace(/^of\s+/i, '');
      // "2 eggs": a unit with nothing after it is the ingredient itself.
      if (remainder) { unit = first![1]!.trim(); name = remainder; }
    } else {
      // "250g flour": the unit is glued to the number; the amount regexp stops at the digits.
      const glued = /^([\p{L}]{1,12})\b/u.exec(amount.rest);
      if (glued && glued.index === 0 && !/\s/.test(trimmed.slice(amount.lexical.length, amount.lexical.length + 1))
        && unitWords.has(glued[1]!.toLowerCase())) {
        const remainder = body.trim().slice(glued[1]!.length).trim().replace(/^of\s+/i, '');
        if (remainder) { unit = glued[1]!; name = remainder; }
      }
    }
  }
  return { quantity: amount?.lexical ?? '', unit, name, note: note.trim() };
}

/** The line a cook reads for these parts. */
export function composeLine(parts: IngredientParts): string {
  const head = [parts.quantity.trim(), parts.unit.trim(), parts.name.trim()].filter(Boolean).join(' ');
  const note = parts.note.trim();
  return note ? (head ? `${head}, ${note}` : note) : head;
}

export interface IngredientQualifier {
  type: 'ingredient-line';
  originalText: { value: string; language: string };
  amountLexical?: string;
  amount?: Rational;
  amountUpper?: Rational;
  unit?: string;
  unitText?: string;
  preparation?: { value: string; language: string };
  optional: boolean;
  scaling: 'linear' | 'non-linear' | 'not-scalable';
  substituteFor: string[];
  parseStatus: 'parsed' | 'partial' | 'unparsed';
  residual?: string;
}

const MAX_LINE = 1000;

/** What Main would refuse about parts before they are sent; `null` when they can be written. */
export function partsProblem(parts: IngredientParts): 'empty' | 'long' | null {
  const line = composeLine(parts);
  if (!line) return 'empty';
  return line.length > MAX_LINE || parts.note.trim().length > 500 || parts.unit.trim().length > 100 ? 'long' : null;
}

/**
 * The qualifier Main stores for these parts. `previous` carries what the editor does not edit
 * (optionality, scaling, substitutions, a unit IRI for an unchanged unit, a source residual).
 */
export function qualifierOf(parts: IngredientParts, language: string, previous?: IngredientQualifier): IngredientQualifier {
  const written = composeLine({ ...parts, quantity: parts.quantity.trim(), unit: parts.unit.trim(), name: parts.name.trim(),
    note: parts.note.trim() });
  const amount = leadingAmount(parts.quantity.trim());
  const typed = amount && !amount.rest ? amount : null;
  const unitText = parts.unit.trim();
  const note = parts.note.trim();
  const status = typed ? (parts.name.trim() ? 'parsed' : 'partial') : 'unparsed';
  const keepsUnit = previous?.unit !== undefined && previous.unitText === (unitText || undefined);
  return {
    type: 'ingredient-line',
    originalText: { value: written, language },
    ...(typed ? { amountLexical: typed.lexical, amount: typed.amount, ...(typed.amountUpper ? { amountUpper: typed.amountUpper } : {}) } : {}),
    ...(keepsUnit ? { unit: previous!.unit } : {}),
    ...(unitText ? { unitText } : {}),
    ...(note ? { preparation: { value: note, language } } : {}),
    optional: previous?.optional ?? false,
    // Without an amount there is nothing to scale; Main shows such a line as written.
    scaling: typed ? (previous?.scaling === 'not-scalable' || previous?.scaling === 'non-linear' ? previous.scaling : 'linear') : 'not-scalable',
    substituteFor: previous?.substituteFor ?? [],
    parseStatus: status,
    ...(previous?.residual && status !== 'parsed' ? { residual: previous.residual } : {}),
  };
}

/**
 * The line a cook reads for a stored ingredient: the words they wrote, with the quantity
 * in the kitchen fraction the published recipe uses. The stored line itself is unchanged.
 */
export function readingLine(qualifier: IngredientQualifier): string {
  const original = qualifier.originalText.value;
  if (!qualifier.amount) return original;
  const main = formatQuantity(qualifier.amount);
  const upper = qualifier.amountUpper ? formatQuantity(qualifier.amountUpper) : null;
  const shown = upper ? `${main}\u2013${upper}` : main;
  const lexical = qualifier.amountLexical?.trim();
  if (lexical && original.toLowerCase().startsWith(lexical.toLowerCase())) return shown + original.slice(lexical.length);
  return composeLine({ ...partsOf(qualifier), quantity: shown });
}

/** Parts for a stored line, so an existing ingredient opens in the same fields it would be typed in. */
export function partsOf(qualifier: IngredientQualifier): IngredientParts {
  let rest = qualifier.originalText.value.trim();
  const lexical = qualifier.amountLexical?.trim();
  if (lexical && rest.toLowerCase().startsWith(lexical.toLowerCase())) rest = rest.slice(lexical.length).trim();
  const unit = qualifier.unitText?.trim() ?? '';
  if (unit && rest.toLowerCase().startsWith(unit.toLowerCase())) rest = rest.slice(unit.length).trim();
  const note = qualifier.preparation?.value.trim() ?? '';
  if (note) {
    for (const separator of [`, ${note}`, `,${note}`, `，${note}`]) {
      if (rest.endsWith(separator)) { rest = rest.slice(0, -separator.length).trim(); break; }
    }
  }
  return { quantity: lexical ?? '', unit, name: rest.replace(/^of\s+/i, ''), note };
}

/** True when two qualifiers say the same thing, so a write of one over the other changes nothing. */
export function sameQualifier(a: IngredientQualifier, b: IngredientQualifier): boolean {
  return a.originalText.value === b.originalText.value && a.originalText.language === b.originalText.language
    && a.amountLexical === b.amountLexical && sameRational(a.amount, b.amount) && sameRational(a.amountUpper, b.amountUpper)
    && a.unit === b.unit && a.unitText === b.unitText && a.preparation?.value === b.preparation?.value
    && a.optional === b.optional && a.scaling === b.scaling && a.parseStatus === b.parseStatus
    && a.residual === b.residual && a.substituteFor.length === b.substituteFor.length
    && a.substituteFor.every((id, index) => id === b.substituteFor[index]);
}
