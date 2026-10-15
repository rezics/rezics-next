import { t } from 'elysia';
import { checkedExactNumber, semanticValueRdf, type ExactNumber } from '../semantic/value.ts';

export const SCALED_REALM_CONTEXT = 'realm-standing-rating-context-v2';
export const SCALED_REALM_OBSERVATION = 'realm-standing-rating-observation-v2';
export const SCALED_GLOBAL_CONTEXT = 'global-rating-standing-context-v2';
export const SCALED_GLOBAL_OBSERVATION = 'global-rating-standing-observation-v2';
export const scaledProfile = (profile: string) => profile.replace(/-v1$/, '-v2');

export interface JudgmentScale { min: number; max: number; step: number }
export const judgmentScaleSchema = t.Object({ min: t.Number({ minimum: 0, maximum: 1_000_000 }), max: t.Number({ minimum: 0, maximum: 1_000_000 }), step: t.Number({ minimum: 0.000001, maximum: 1_000_000 }) },
  { additionalProperties: false });

export const exactRatingSchema = t.Object({ kind: t.Union([t.Literal('integer'), t.Literal('decimal')]), lexical: t.String({ maxLength: 32 }) });

// A bounded decimal grid keeps both RDF scalars and histogram positions exact.
// BigInt arithmetic, rather than floating point remainder, decides membership.
export class InvalidJudgmentScale extends RangeError {}
const UNITS = 1_000_000n;
export function ratingUnits(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000
    || !/^-?\d+(?:\.\d{1,6})?$/.test(String(value))) throw new InvalidJudgmentScale('invalid exact rating decimal');
  return ratingUnitsFromText(String(value));
}

export function isRatingValue(value: unknown): value is number {
  try { return ratingUnits(value) >= 0n; } catch { return false; }
}

export function judgmentScale(scale: JudgmentScale): JudgmentScale {
  const min = ratingUnits(scale.min), max = ratingUnits(scale.max), step = ratingUnits(scale.step);
  if (min < 0n || max <= min || step <= 0n || (max - min) % step !== 0n
    || (max - min) / step > 1000n) throw new InvalidJudgmentScale('invalid judgment scale');
  return { min: scale.min, max: scale.max, step: scale.step };
}

export function contextScale(state: Record<string, unknown>): JudgmentScale {
  return judgmentScale({ min: state.scaleMin as number, max: state.scaleMax as number,
    step: (state.scaleStep ?? 1) as number });
}

export function onJudgmentScale(value: unknown, scale: JudgmentScale): value is number {
  try {
    const n = ratingUnits(value), min = ratingUnits(scale.min), max = ratingUnits(scale.max);
    return n >= min && n <= max && (n - min) % ratingUnits(scale.step) === 0n;
  } catch { return false; }
}

export function exactRating(value: number): ExactNumber {
  ratingUnits(value);
  return checkedExactNumber({ kind: Number.isInteger(value) ? 'integer' : 'decimal', lexical: String(value) });
}

export function ratingTerm(value: number): string {
  return semanticValueRdf(exactRating(value), () => { throw new Error('rating is a scalar'); }).object;
}

export function scalePattern(scale?: JudgmentScale): string {
  return scale ? `rv:ratingScaleMin ${ratingTerm(scale.min)} ; rv:ratingScaleMax ${ratingTerm(scale.max)} ; rv:ratingScaleStep ${ratingTerm(scale.step)}`
    : 'rv:ratingScaleMin ?scaleMin ; rv:ratingScaleMax ?scaleMax';
}

export const unitsNumber = (value: bigint) => Number(value) / Number(UNITS);
export const RATING_UNITS = UNITS;

/** Exact projection arithmetic can exceed the bound on one person's score. */
export function ratingUnitsFromText(lexical: string): bigint {
  if (lexical.length > 128 || !/^-?\d+(?:\.\d{1,6})?$/.test(lexical)) throw new InvalidJudgmentScale('invalid rating sum');
  const negative = lexical.startsWith('-');
  const [whole, part = ''] = (negative ? lexical.slice(1) : lexical).split('.');
  return (BigInt(whole!) * RATING_UNITS + BigInt(part.padEnd(6, '0'))) * (negative ? -1n : 1n);
}

export function ratingUnitsText(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  const part = String(magnitude % RATING_UNITS).padStart(6, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${magnitude / RATING_UNITS}${part ? `.${part}` : ''}`;
}
