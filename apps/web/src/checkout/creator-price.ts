import { parseDecimalAmount, validateMinorAmount } from '@rezics/money';
import { isSaleCurrencyRule, type ConfiguredSaleCurrencyRule } from './money-schema';

export type CreatorPriceIssue =
  | 'malformed-decimal'
  | 'unsupported-currency'
  | 'policy-unavailable'
  | 'minimum'
  | 'maximum'
  | 'increment'
  | 'unsafe-integer';
export type CreatorPriceValidation =
  | Readonly<{ kind: 'valid'; amountMinor: number }>
  | Readonly<{ kind: 'invalid'; issue: CreatorPriceIssue }>;

export class CreatorPriceError extends RangeError {
  constructor(readonly issue: CreatorPriceIssue) {
    super(issue);
    this.name = 'CreatorPriceError';
  }
}

/** Validate a typed seller draft against the exact rule currently shown beside the input. */
export function validateCreatorPrice(
  text: string,
  rule?: ConfiguredSaleCurrencyRule,
): CreatorPriceValidation {
  if (!rule) return { kind: 'invalid', issue: 'unsupported-currency' };
  if (!isSaleCurrencyRule(rule)) return { kind: 'invalid', issue: 'policy-unavailable' };

  const parsed = parseDecimalAmount(text, rule.unit.exponent);
  if (!parsed.ok) {
    return {
      kind: 'invalid',
      issue:
        parsed.error.code === 'unsafe-integer'
          ? 'unsafe-integer'
          : parsed.error.code === 'invalid-exponent'
            ? 'policy-unavailable'
            : 'malformed-decimal',
    };
  }

  const validated = validateMinorAmount(parsed.value, {
    minimumMinor: rule.minAmountMinor,
    maximumMinor: rule.maxAmountMinor,
    incrementMinor: rule.chargeMultiple,
  });
  if (!validated.ok) {
    const issue: CreatorPriceIssue =
      validated.error.code === 'below-minimum'
        ? 'minimum'
        : validated.error.code === 'above-maximum'
          ? 'maximum'
          : validated.error.code === 'increment-mismatch'
            ? 'increment'
            : validated.error.code === 'unsafe-integer'
              ? 'unsafe-integer'
              : 'policy-unavailable';
    return { kind: 'invalid', issue };
  }
  return { kind: 'valid', amountMinor: validated.value };
}

/** ASCII major-unit input; native Commerce independently validates the captured operands. */
export function parseCreatorPrice(text: string, rule: ConfiguredSaleCurrencyRule): number {
  const result = validateCreatorPrice(text, rule);
  if (result.kind === 'invalid') throw new CreatorPriceError(result.issue);
  return result.amountMinor;
}
