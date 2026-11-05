import { decodeRecordedMoneyUnit, decimalParts } from '@rezics/money';
import { stripeRecordedMoneyUnits } from './money-schema';
import { m } from '../paraglide/messages.js';

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
  if (!Number.isSafeInteger(minor) || typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency)) return null;
  const code = currency.toUpperCase();
  const reading = decodeRecordedMoneyUnit(unit, stripeRecordedMoneyUnits);
  if (reading.kind !== 'known') return m.money_raw_minor_unknown_unit({ amount: String(minor), currency: code });
  if (!displayCurrencies.has(currency.toLowerCase()))
    return m.money_raw_minor_recorded_unit({
      amount: String(minor),
      currency: code,
      exponent: String(reading.unit.exponent),
    });
  const parts = decimalParts(minor, reading.unit.exponent);
  if (!parts.ok) return null;
  try {
    const { negative, whole, fraction, exponent } = parts.value;
    const formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    });
    const signedWhole = negative ? (whole === 0n ? -0 : -whole) : whole;
    const localizedFraction = exponent
      ? new Intl.NumberFormat(locale, {
          useGrouping: false,
          minimumIntegerDigits: exponent,
          maximumFractionDigits: 0,
        }).format(fraction)
      : '';
    const display = formatter
      .formatToParts(signedWhole)
      .map((part) => (part.type === 'fraction' ? localizedFraction : part.value))
      .join('');
    return m.money_formatted_recorded_minor({
      display,
      amount: String(minor),
      currency: code,
      exponent: String(exponent),
    });
  } catch {
    return null;
  }
}
