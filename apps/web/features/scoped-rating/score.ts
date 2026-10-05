import type { RatingSummary } from '../work-page/types.ts';
import type { Rollup, RollupMember } from './types.ts';

// What a figure may claim, for every surface that shows a score (the Work page, entity pages, the scoped places).
// Main withholds a mean below the question's display threshold but always returns the count and the histogram, so a
// client that drew "0.0" or an empty histogram for "too few" would invent a number.

/** One target's figures for one question, as every source reduces to. */
export interface Figures {
  count: number;
  /** Null when Main withheld it: below the threshold, or nobody has rated. */
  mean: number | null;
  /** Ratings the question needs before it shows a mean, or null when the read did not carry it. */
  displayThreshold: number | null;
  /** The bottom and the top of the question's scale. */
  min: number;
  max: number;
  /** `histogram[i]` is the number of ratings of `min + i`. */
  histogram: readonly number[];
}

export type ScoreView =
  /** "No ratings yet". */
  | { kind: 'none' }
  /** "3 more ratings will reveal the average"; `remaining` is null when the read did not say how many. */
  | { kind: 'withheld'; count: number; remaining: number | null }
  /** "8/10 · 7 ratings". */
  | { kind: 'shown'; mean: number; count: number; max: number };

export function scoreView(figures: Pick<Figures, 'count' | 'mean' | 'displayThreshold' | 'max'>): ScoreView {
  if (figures.count <= 0) return { kind: 'none' };
  if (figures.mean !== null) return { kind: 'shown', mean: figures.mean, count: figures.count, max: figures.max };
  const remaining = figures.displayThreshold !== null && figures.displayThreshold > figures.count
    ? figures.displayThreshold - figures.count : null;
  return { kind: 'withheld', count: figures.count, remaining };
}

export interface Bar { value: number; count: number }

/** The bars of a histogram from the top of the scale down, or null where there is nothing to draw: no zero histogram. */
export function bars(figures: Pick<Figures, 'count' | 'histogram' | 'min' | 'max'>): Bar[] | null {
  if (figures.count <= 0 || figures.histogram.every(count => count <= 0)) return null;
  return Array.from({ length: figures.max - figures.min + 1 }, (_, index) => figures.max - index)
    .map(value => ({ value, count: figures.histogram[value - figures.min] ?? 0 }));
}

/**
 * A rating read of any grain (a Work's, a release's, a character's, a place's), or null where no question applies. The
 * mean is only what Main marked as shown: a read that does not say, as a Work's does, shows its mean.
 */
export function figuresOfRating(rating: RatingSummary): Figures | null {
  if (rating.status !== 'available' || !rating.scale) return null;
  const { min, max } = rating.scale;
  const histogram = Array.from({ length: max - min + 1 }, () => 0);
  for (const entry of rating.distribution) if (entry.value >= min && entry.value <= max) histogram[entry.value - min] = entry.count;
  const shown = rating.mean !== null && (!('meanDisplay' in rating) || rating.meanDisplay === 'shown');
  return { count: rating.count, mean: shown ? rating.mean : null,
    displayThreshold: 'displayThreshold' in rating ? rating.displayThreshold ?? null : null, min, max, histogram };
}

/** A roll-up member Main could count; a member it could not is not a figure. */
export function figuresOfMember(member: RollupMember, threshold: number, max: number): Figures | null {
  if (member.status !== 'available') return null;
  return { count: member.components.count, mean: member.meanDisplay === 'shown' ? member.mean : null,
    displayThreshold: threshold, min: 1, max, histogram: member.components.histogram.slice(0, max) };
}

/**
 * The ratings behind a roll-up's value: every available member's under `pooled`, only the members that meet the display
 * threshold under `mean-of-means`, as the server averages. Never more than the value stands on.
 */
export function ratingsCounted(rollup: Pick<Rollup, 'formula' | 'members'>): number {
  return rollup.members.reduce((sum, member) => member.status !== 'available'
    || (rollup.formula === 'mean-of-means' && !member.meetsThreshold) ? sum : sum + member.components.count, 0);
}
