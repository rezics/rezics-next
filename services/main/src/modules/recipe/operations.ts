import { exactRational, scaleExact, type ExactRational } from './quantity.ts';
import type { OccurrenceRecord } from '../structure/format.ts';

export interface ScaledIngredient {
  occurrence: string;
  originalText: string;
  sourceLexical?: string;
  amount?: ExactRational;
  amountUpper?: ExactRational;
  unitText?: string;
  scaled: boolean;
  reason?: 'unparsed' | 'non-linear' | 'not-scalable';
}

/** Exact scaling changes only numeric amounts; source text and uncertain units survive verbatim. */
export function scaleIngredients(records: readonly OccurrenceRecord[], factor: ExactRational): ScaledIngredient[] {
  const checkedFactor = exactRational(factor.numerator, factor.denominator);
  return records.flatMap(record => {
    if (record.state !== 'active' || record.role !== 'ingredient'
      || record.qualifier?.type !== 'ingredient-line') return [];
    const line = record.qualifier;
    const reason = line.parseStatus === 'unparsed' ? 'unparsed'
      : line.scaling === 'non-linear' ? 'non-linear'
        : line.scaling === 'not-scalable' ? 'not-scalable' : undefined;
    return [{ occurrence: record.occurrence, originalText: line.originalText.value,
      ...(line.amountLexical ? { sourceLexical: line.amountLexical } : {}),
      ...(line.amount ? { amount: reason
        ? exactRational(BigInt(line.amount.numerator), BigInt(line.amount.denominator))
        : scaleExact({ numerator: BigInt(line.amount.numerator), denominator: BigInt(line.amount.denominator) },
          checkedFactor) } : {}),
      ...(line.amountUpper ? { amountUpper: reason
        ? exactRational(BigInt(line.amountUpper.numerator), BigInt(line.amountUpper.denominator))
        : scaleExact({ numerator: BigInt(line.amountUpper.numerator),
          denominator: BigInt(line.amountUpper.denominator) }, checkedFactor) } : {}),
      ...(line.unitText ? { unitText: line.unitText } : {}), scaled: !reason && line.amount !== undefined,
      ...(reason ? { reason } : {}) }];
  });
}

export interface NutrientAmount { nutrient: string; unit: string; amount: ExactRational }
export interface NutritionResult {
  nutrients: NutrientAmount[];
  basis: 'per-serving' | 'whole-recipe';
  coverage: 'complete' | 'partial' | 'unknown';
}

/** Add exact values by nutrient and unit, preserving explicit gaps as partial coverage. */
export function calculateNutrition(inputs: readonly {
  values: readonly NutrientAmount[]; coverage: 'complete' | 'partial' | 'unknown';
}[], basis: NutritionResult['basis']): NutritionResult {
  const sums = new Map<string, { nutrient: string; unit: string; amount: ExactRational }>();
  let coverage: NutritionResult['coverage'] = inputs.length ? 'complete' : 'unknown';
  for (const input of inputs) {
    if (input.coverage === 'unknown') coverage = 'unknown';
    else if (input.coverage === 'partial' && coverage === 'complete') coverage = 'partial';
    for (const value of input.values) {
      const amount = exactRational(value.amount.numerator, value.amount.denominator);
      const key = `${value.nutrient}\0${value.unit}`;
      const prior = sums.get(key);
      if (!prior) sums.set(key, { ...value, amount });
      else {
        const numerator = prior.amount.numerator * amount.denominator
          + amount.numerator * prior.amount.denominator;
        const denominator = prior.amount.denominator * amount.denominator;
        prior.amount = exactRational(numerator, denominator);
      }
    }
  }
  return { nutrients: [...sums.values()], basis, coverage };
}
