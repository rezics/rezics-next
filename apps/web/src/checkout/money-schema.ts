import type { KernelClient } from '@rezics/client';
import {
  decodeMoneyUnitEnvelope,
  decodeRecordedMoneyUnit,
  isSafeMinorAmount,
  type RecordedMoneyUnit,
} from '@rezics/money';

/** Adopted native DTOs. Unit facts describe recorded money, never permission or provider qualification. */
export type StripeMoneyUnit = RecordedMoneyUnit<'stripe-api', 0 | 2, 'stripe-money-v1'>;

export type ConfiguredSaleCurrencyRule = Readonly<{
  currency: 'usd' | 'eur';
  unit: StripeMoneyUnit;
  minAmountMinor: number;
  maxAmountMinor: number;
  chargeMultiple: number;
}>;
export type CommerceMoneySchema = Readonly<{
  factsVersion: 'stripe-money-v1';
  taxBehavior: 'exclusive';
  configuredSaleCurrencies: readonly ConfiguredSaleCurrencyRule[];
}>;
export type MoneySchemaData = { kind: 'ready'; schema: CommerceMoneySchema } | { kind: 'unavailable' };
export interface MoneySchemaApi {
  /** Generated GET /v1/commerceMoney, operation commerce.money_schema. */
  read(authorization: string): Promise<MoneySchemaData>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every((name) => name in value);
}
export const stripeRecordedMoneyUnits: readonly StripeMoneyUnit[] = Object.freeze([
  Object.freeze({ system: 'stripe-api', exponent: 0, factsVersion: 'stripe-money-v1' }),
  Object.freeze({ system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' }),
]);
export function isMoneyUnit(value: unknown): value is StripeMoneyUnit {
  return decodeRecordedMoneyUnit(value, stripeRecordedMoneyUnits).kind === 'known';
}
/** Absence in older generated DTOs and recordings stays UNKNOWN. No table backfill. */
export function recordedMoneyUnit(value: unknown): StripeMoneyUnit | null {
  const reading = decodeMoneyUnitEnvelope(value, stripeRecordedMoneyUnits);
  return reading.kind === 'known' ? (reading.unit as StripeMoneyUnit) : null;
}
export function recordedTaxBehavior(value: unknown): 'exclusive' | null {
  return record(value) && value.taxBehavior === 'exclusive' ? 'exclusive' : null;
}
export function isSaleCurrencyRule(value: unknown): value is ConfiguredSaleCurrencyRule {
  return (
    record(value) &&
    keys(value, ['currency', 'unit', 'minAmountMinor', 'maxAmountMinor', 'chargeMultiple']) &&
    (value.currency === 'usd' || value.currency === 'eur') &&
    isMoneyUnit(value.unit) &&
    value.unit.exponent === 2 &&
    isSafeMinorAmount(value.minAmountMinor) &&
    value.minAmountMinor > 0 &&
    isSafeMinorAmount(value.maxAmountMinor) &&
    value.maxAmountMinor >= value.minAmountMinor &&
    typeof value.chargeMultiple === 'number' &&
    Number.isSafeInteger(value.chargeMultiple) &&
    value.chargeMultiple > 0
  );
}
export function parseMoneySchema(value: unknown): CommerceMoneySchema | null {
  if (
    !record(value) ||
    !keys(value, ['factsVersion', 'taxBehavior', 'configuredSaleCurrencies']) ||
    value.factsVersion !== 'stripe-money-v1' ||
    value.taxBehavior !== 'exclusive' ||
    !Array.isArray(value.configuredSaleCurrencies) ||
    value.configuredSaleCurrencies.length > 2 ||
    !value.configuredSaleCurrencies.every(isSaleCurrencyRule) ||
    new Set(value.configuredSaleCurrencies.map((rule) => rule.currency)).size !== value.configuredSaleCurrencies.length
  )
    return null;
  return {
    factsVersion: value.factsVersion,
    taxBehavior: value.taxBehavior,
    configuredSaleCurrencies: value.configuredSaleCurrencies,
  };
}
/** The served editor binds the actual generated caller; an unbound port has no configuration facts. */
export function createNativeMoneySchemaApi(client?: Pick<KernelClient, 'commerceMoney'>): MoneySchemaApi {
  return {
    async read(authorization) {
      if (!client) return { kind: 'unavailable' };
      try {
        const result = await client.commerceMoney.get({
          headers: { authorization },
          fetch: { cache: 'no-store', redirect: 'manual' },
        });
        const schema = result.status === 200 && !result.error ? parseMoneySchema(result.data) : null;
        return schema ? { kind: 'ready', schema } : { kind: 'unavailable' };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
export const nativeMoneySchemaApi = createNativeMoneySchemaApi();
