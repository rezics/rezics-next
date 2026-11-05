import { pickText } from '@rezics/composition';
import type { Related } from './types';

/** The read-only label projection quantity consumers may use without owning subject state. */
export type QuantityUnitLabels = Readonly<Record<string, { labels?: Record<string, string> }>>;

/** Exact unit identities from the admitted catalogue; symbols never choose or convert an amount. */
export const unitSymbols: Record<string, string> = {
  'http://www.wikidata.org/entity/Q1238720': 'vol',
  'http://www.wikidata.org/entity/Q1980247': 'ch',
  'http://www.wikidata.org/entity/Q11574': 's',
  'http://www.wikidata.org/entity/Q7727': 'min',
  'http://www.wikidata.org/entity/Q577': 'a',
  'http://www.wikidata.org/entity/Q11573': 'm',
  'http://www.wikidata.org/entity/Q174728': 'cm',
  'http://www.wikidata.org/entity/Q11570': 'kg',
  'http://www.wikidata.org/entity/Q41803': 'g',
  'http://www.wikidata.org/entity/Q3241121': 'mg',
};

/** Empty means explicitly unitless; null means the unit has no disclosed reading label. */
export function quantityUnitLabel(unit: string, related: QuantityUnitLabels, locale: string): string | null {
  if (unit === '1') return '';
  if (Object.hasOwn(unitSymbols, unit)) return unitSymbols[unit]!;
  const labels = Object.hasOwn(related, unit) ? related[unit]?.labels : undefined;
  const label = pickText(labels ?? {}, locale).text;
  return typeof label === 'string' && label.trim() ? label : null;
}

// Native quantity decimals are signed, at most 127 characters, and never exponential.
const decimal = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 127 && /^[+-](?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value);
const unitIri = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u0020\u007f-\u009f<>"{}|\\^`]*$/;

/** Compare bounded decimal strings without putting their numeric facts through floating point. */
function greater(left: string, right: string): boolean {
  const parts = (value: string) => {
    const [integer, fraction = ''] = value.slice(1).split('.');
    return { integer: integer!, fraction, negative: value[0] === '-' && /[1-9]/.test(value) };
  };
  const a = parts(left);
  const b = parts(right);
  if (a.negative !== b.negative) return b.negative;
  const precision = Math.max(a.fraction.length, b.fraction.length);
  const x = a.integer + a.fraction.padEnd(precision, '0');
  const y = b.integer + b.fraction.padEnd(precision, '0');
  const order =
    a.integer.length === b.integer.length ? (x === y ? 0 : x > y ? 1 : -1) : a.integer.length - b.integer.length;
  return a.negative ? order < 0 : order > 0;
}

/** Read only a native quantity shape; preserve every signed digit and each disclosed bound verbatim. */
export function quantityPresentation(content: unknown, related: Related, locale: string) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const value = content as Record<string, unknown>;
  if (
    !Object.hasOwn(value, 'amount') ||
    !Object.hasOwn(value, 'unit') ||
    Object.keys(value).some((key) => !['amount', 'unit', 'lowerBound', 'upperBound'].includes(key)) ||
    !decimal(value.amount) ||
    typeof value.unit !== 'string' ||
    (value.unit !== '1' && !unitIri.test(value.unit))
  )
    return null;
  const bounds: string[] = [];
  for (const bound of ['lowerBound', 'upperBound'] as const) {
    if (!Object.hasOwn(value, bound)) continue;
    if (!decimal(value[bound])) return null;
    if (bound === 'lowerBound' ? greater(value[bound], value.amount) : greater(value.amount, value[bound])) return null;
    bounds.push(`${bound === 'lowerBound' ? '≥' : '≤'} ${value[bound]}`);
  }
  return {
    numbers: value.amount + (bounds.length ? ` (${bounds.join('; ')})` : ''),
    unitLabel: quantityUnitLabel(value.unit, related, locale),
  };
}
