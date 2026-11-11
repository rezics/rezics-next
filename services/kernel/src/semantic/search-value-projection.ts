import { readNativeCalendarDate, type CalendarDate } from '@rezics/filter';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Canonical decimal identity, independent of sign, trailing zeroes and exponent spelling. */
function decimalIdentity(input: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(input);
  if (!match) return null;
  let digits = (match[2]! + (match[3] ?? '')).replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent)) return null;
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent++;
  }
  return `${match[1] === '-' ? '-' : ''}${digits}e${exponent}`;
}

/** Return the Search double only when it preserves the admitted decimal's exact value. */
export function exactSearchNumber(input: string): number | null {
  const amount = Number(input);
  if (!Number.isFinite(amount) || (Number.isInteger(amount) && !Number.isSafeInteger(amount))) return null;
  const source = decimalIdentity(input);
  if (source === null || source !== decimalIdentity(String(amount))) return null;
  return amount;
}

/** Whether an admitted quantity denotes the point represented by its nominal amount. */
export function isPointSearchQuantity(content: unknown): content is Record<string, unknown> & { amount: string } {
  if (!record(content) || typeof content.amount !== 'string') return false;
  const amount = decimalIdentity(content.amount);
  if (amount === null) return false;
  for (const bound of ['lowerBound', 'upperBound']) {
    if (content[bound] !== undefined && (typeof content[bound] !== 'string' || decimalIdentity(content[bound]) !== amount))
      return false;
  }
  return true;
}

/** Exact numeric projection shared by Search evidence and list-fact presentation. */
export function exactSearchQuantityAmount(content: unknown): number | null {
  if (!isPointSearchQuantity(content)) return null;
  return exactSearchNumber(content.amount);
}

/**
 * Project Gregorian Wikibase dates into the astronomical numbering used by Search queries.
 * The caller retains the original Wikibase time string as the statement value.
 */
export function projectSearchCalendarDate(content: unknown): CalendarDate | undefined {
  if (!record(content)) return undefined;
  if (
    (content.timezone !== undefined && content.timezone !== 0) ||
    (content.before !== undefined && content.before !== 0) ||
    (content.after !== undefined && content.after !== 0)
  )
    return undefined;
  const date = readNativeCalendarDate(content);
  if (!date) return undefined;
  if (typeof content.time !== 'string' || !content.time.startsWith('-')) return date;
  if (Object.is(date.year, -0)) return undefined;
  return { ...date, year: date.year + 1 };
}
