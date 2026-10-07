// Exact quantities typed by a cook: "1½", "1 1/2", "3/4", "0.75", "2-3". Main stores amounts as
// reduced non-negative rationals with the written form kept beside them, so nothing is rounded here.

export interface Rational { numerator: number; denominator: number }

const LIMIT = 1_000_000_000_000n;

const VULGAR: Readonly<Record<string, Rational>> = {
  '½': { numerator: 1, denominator: 2 }, '⅓': { numerator: 1, denominator: 3 }, '⅔': { numerator: 2, denominator: 3 },
  '¼': { numerator: 1, denominator: 4 }, '¾': { numerator: 3, denominator: 4 }, '⅕': { numerator: 1, denominator: 5 },
  '⅖': { numerator: 2, denominator: 5 }, '⅗': { numerator: 3, denominator: 5 }, '⅘': { numerator: 4, denominator: 5 },
  '⅙': { numerator: 1, denominator: 6 }, '⅚': { numerator: 5, denominator: 6 }, '⅛': { numerator: 1, denominator: 8 },
  '⅜': { numerator: 3, denominator: 8 }, '⅝': { numerator: 5, denominator: 8 }, '⅞': { numerator: 7, denominator: 8 },
};
const VULGAR_CLASS = Object.keys(VULGAR).join('');

const gcd = (a: bigint, b: bigint): bigint => (b ? gcd(b, a % b) : a);

function reduced(numerator: bigint, denominator: bigint): Rational | null {
  if (denominator < 1n || numerator < 0n) return null;
  const divisor = gcd(numerator, denominator) || 1n;
  const n = numerator / divisor;
  const d = denominator / divisor;
  return n > LIMIT || d > LIMIT ? null : { numerator: Number(n), denominator: Number(d) };
}

// One quantity: mixed number, vulgar fraction (with optional whole), plain fraction, decimal or integer.
const QUANTITY = new RegExp(
  `^(?:(\\d+)[\\s-]*([${VULGAR_CLASS}])|([${VULGAR_CLASS}])|(\\d+)[\\s-]+(\\d+)/(\\d+)|(\\d+)/(\\d+)|(\\d+)[.,](\\d{1,12})|(\\d+))`,
);
const RANGE = /^\s*(?:-|–|—|~|to\b)\s*/i;

function one(text: string): { value: Rational; length: number } | null {
  const match = QUANTITY.exec(text);
  if (!match) return null;
  const [whole, vulgarAfterWhole, vulgarAlone, mixedWhole, mixedNumerator, mixedDenominator, fractionNumerator,
    fractionDenominator, decimalWhole, decimalFraction, integer] = match.slice(1);
  let value: Rational | null;
  if (whole !== undefined) {
    const fraction = VULGAR[vulgarAfterWhole!]!;
    value = reduced(BigInt(whole) * BigInt(fraction.denominator) + BigInt(fraction.numerator), BigInt(fraction.denominator));
  } else if (vulgarAlone !== undefined) value = VULGAR[vulgarAlone]!;
  else if (mixedWhole !== undefined) {
    const denominator = BigInt(mixedDenominator!);
    value = reduced(BigInt(mixedWhole) * denominator + BigInt(mixedNumerator!), denominator);
  } else if (fractionNumerator !== undefined) value = reduced(BigInt(fractionNumerator), BigInt(fractionDenominator!));
  else if (decimalWhole !== undefined) {
    const scale = 10n ** BigInt(decimalFraction!.length);
    value = reduced(BigInt(decimalWhole) * scale + BigInt(decimalFraction!), scale);
  } else value = reduced(BigInt(integer!), 1n);
  return value ? { value, length: match[0].length } : null;
}

export interface LeadingAmount {
  /** The quantity exactly as typed, a prefix of the text (a range keeps both ends). */
  lexical: string;
  amount: Rational;
  amountUpper?: Rational;
  /** What follows the quantity, without leading space. */
  rest: string;
}

/** The quantity a line starts with, or null when it starts with anything else. */
export function leadingAmount(text: string): LeadingAmount | null {
  const trimmed = text.trimStart();
  const first = one(trimmed);
  if (!first) return null;
  let length = first.length;
  let upper: Rational | undefined;
  const separator = RANGE.exec(trimmed.slice(length));
  if (separator) {
    const second = one(trimmed.slice(length + separator[0].length));
    if (second && second.value.numerator * first.value.denominator > first.value.numerator * second.value.denominator) {
      upper = second.value;
      length += separator[0].length + second.length;
    }
  }
  return { lexical: trimmed.slice(0, length), amount: first.value, ...(upper ? { amountUpper: upper } : {}),
    rest: trimmed.slice(length).trimStart() };
}

/** The numeric value of a field holding only a quantity ("1½", "2-3"); null when anything else is typed. */
export function wholeAmount(text: string): LeadingAmount | null {
  const found = leadingAmount(text);
  return found && !found.rest ? found : null;
}

export const sameRational = (a: Rational | undefined, b: Rational | undefined) =>
  (!a && !b) || (a !== undefined && b !== undefined && a.numerator === b.numerator && a.denominator === b.denominator);

/** A whole number of minutes (or any whole count) typed in a field, as an exact rational; null when it is not one. */
export function wholeNumber(text: string): Rational | null {
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  return { numerator: Number(trimmed), denominator: 1 };
}

/** A positive or zero amount typed for a yield or servings field: "4", "1½", "0.5". */
export function typedAmount(text: string): Rational | null {
  const found = wholeAmount(text.trim());
  return found && !found.amountUpper ? found.amount : null;
}

/** The text for a rational the way the field shows it back: whole numbers plain, fractions as "n/d". */
export function amountText(value: Rational | undefined): string {
  if (!value) return '';
  if (value.denominator === 1) return String(value.numerator);
  const whole = Math.floor(value.numerator / value.denominator);
  const rest = value.numerator - whole * value.denominator;
  return whole ? `${whole} ${rest}/${value.denominator}` : `${rest}/${value.denominator}`;
}
