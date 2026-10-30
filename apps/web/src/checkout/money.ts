import { isMoneyUnit } from './money-schema';

// Adopted documented currency vocabulary, used only for placement. Exponents always come from recorded metadata.
const displayCurrencies = new Set([
  'usd',
  'eur',
  'cad',
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
  'isk',
  'ugx',
  'huf',
  'twd',
]);

/** Exact signed recorded money. Intl chooses symbols, grouping and digits, never the unit or divisor. */
export function formatMinorAmount(locale: string, currency: string, minor: number, unit?: unknown): string | null {
  if (
    !Number.isSafeInteger(minor) ||
    typeof currency !== 'string' ||
    !isMoneyUnit(unit) ||
    !displayCurrencies.has(currency.toLowerCase())
  )
    return null;
  try {
    const digits = unit.exponent;
    const formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    const amount = BigInt(minor);
    const scale = 10n ** BigInt(digits);
    const whole = amount / scale;
    const remainder = (amount < 0n ? -amount : amount) % scale;
    const fraction = digits
      ? new Intl.NumberFormat(locale, {
          useGrouping: false,
          minimumIntegerDigits: digits,
          maximumFractionDigits: 0,
        }).format(remainder)
      : '';
    return formatter
      .formatToParts(whole === 0n && (minor < 0 || Object.is(minor, -0)) ? -0 : whole)
      .map((part) => (part.type === 'fraction' ? fraction : part.value))
      .join('');
  } catch {
    return null;
  }
}
