import { isSaleCurrencyRule, type ConfiguredSaleCurrencyRule } from './money-schema';

/** ASCII major-unit input; the native server independently validates the resulting raw integer. */
export function parseCreatorPrice(text: string, rule: ConfiguredSaleCurrencyRule): number {
  if (!isSaleCurrencyRule(rule) || typeof text !== 'string' || text.length > 32)
    throw new RangeError('Invalid creator price');
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text);
  if (!match || match[0] !== text || (match[2]?.length ?? 0) > rule.unit.exponent)
    throw new RangeError('Invalid creator price');
  const scale = 10n ** BigInt(rule.unit.exponent);
  const raw = BigInt(match[1]!) * scale + BigInt((match[2] ?? '').padEnd(rule.unit.exponent, '0') || '0');
  if (
    raw < BigInt(rule.minAmountMinor) ||
    raw > BigInt(rule.maxAmountMinor) ||
    raw % BigInt(rule.chargeMultiple) !== 0n ||
    raw > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new RangeError('Invalid creator price');
  return Number(raw);
}
