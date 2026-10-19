import { ingredientName, judgmentOf, largeRatio, presentQuantity, recognizeUnit, RECIPE_UNIT_DEFINITIONS } from './display.ts';
import { exactRational, scaleExact, type ExactRational } from './quantity.ts';
import type { OccurrenceRecord } from '../structure/format.ts';

export interface ScaledIngredient {
  occurrence: string;
  originalText: string;
  sourceLexical?: string;
  /** Scaled structured amount, independent of whether a food name can be composed. */
  amount?: ExactRational;
  amountUpper?: ExactRational;
  /** Registered unit-code label, or the supplied written unit when no code is known. */
  unitText?: string;
  scaled: boolean;
  reason?: 'unparsed' | 'non-linear' | 'not-scalable';
  /** Composed only with a numeric amount and supplied name/spans; otherwise unchanged source. */
  line: string;
  alternateLine?: string;
  alternateSystem?: 'us' | 'metric';
  /** Written line, when `line` is a different amount. */
  hint?: string;
  judgment?: 'seasoning' | 'leavening';
}

function rational(value: { numerator: number; denominator: number }): ExactRational {
  return exactRational(BigInt(value.numerator), BigInt(value.denominator));
}

/**
 * The authored qualifier governs exact numeric scaling. Ingredient names and
 * recognized units cannot override it. Kitchen advice and rounded display text
 * do not change the exact amount or the retained source text.
 */
export function scaleIngredients(records: readonly OccurrenceRecord[], factor: ExactRational): ScaledIngredient[] {
  const checkedFactor = exactRational(factor.numerator, factor.denominator);
  return records.flatMap(record => {
    if (record.state !== 'active' || record.role !== 'ingredient'
      || record.qualifier?.type !== 'ingredient-line') return [];
    const line = record.qualifier;
    const sourceAmount = line.amount ? rational(line.amount) : undefined;
    const sourceUpper = line.amountUpper ? rational(line.amountUpper) : undefined;
    const unitText = (line.unit ? RECIPE_UNIT_DEFINITIONS.get(line.unit) : undefined) ?? line.unitText;
    const unit = recognizeUnit(unitText);
    const name = ingredientName(line);
    const judgment = judgmentOf(name ?? line.originalText.value);
    const showJudgment = Boolean(judgment) && line.scaling === 'linear' && line.parseStatus !== 'unparsed'
      && sourceAmount !== undefined && largeRatio(checkedFactor);
    const reason = line.parseStatus === 'unparsed' ? 'unparsed' as const
      : line.scaling === 'non-linear' ? 'non-linear' as const
        : line.scaling === 'not-scalable' ? 'not-scalable' as const
          : undefined;
    const apply = !reason && sourceAmount !== undefined;
    const amount = sourceAmount ? (apply ? scaleExact(sourceAmount, checkedFactor) : sourceAmount) : undefined;
    const amountUpper = sourceUpper ? (apply ? scaleExact(sourceUpper, checkedFactor) : sourceUpper) : undefined;
    return [{ occurrence: record.occurrence, originalText: line.originalText.value,
      ...(line.amountLexical ? { sourceLexical: line.amountLexical } : {}),
      ...(amount ? { amount } : {}),
      ...(amountUpper ? { amountUpper } : {}),
      ...(unitText ? { unitText } : {}),
      scaled: apply,
      ...(reason ? { reason } : {}),
      ...presentQuantity({ original: line.originalText.value, name, ...(unitText ? { unitText } : {}),
        ...(unit ? { unit } : {}), ...(amount ? { amount } : {}), ...(amountUpper ? { amountUpper } : {}),
        changed: apply && checkedFactor.numerator !== checkedFactor.denominator,
        ...(showJudgment && judgment ? { judgment } : {}) }) }];
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
