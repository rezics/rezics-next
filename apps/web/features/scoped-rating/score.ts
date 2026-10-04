import type { RollupMember, TargetRating } from './types.ts';

// What a figure may claim. Main withholds a mean below the question's display threshold but always returns the count
// and the histogram, so a client that drew "0.0" or an empty histogram for "too few" would invent a number.

/** One target's figures for one question, as every source reduces to. */
export interface Figures {
  count: number;
  /** Null when Main withheld it: below the threshold, or nobody has rated. */
  mean: number | null;
  /** Ratings the question needs before it shows a mean, or null when the read did not carry it. */
  displayThreshold: number | null;
  /** The top of the question's scale. */
  max: number;
  /** `histogram[i]` is the number of ratings of `i + 1`. */
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
export function bars(figures: Pick<Figures, 'count' | 'histogram' | 'max'>): Bar[] | null {
  if (figures.count <= 0 || figures.histogram.every(count => count <= 0)) return null;
  return Array.from({ length: figures.max }, (_, index) => figures.max - index)
    .map(value => ({ value, count: figures.histogram[value - 1] ?? 0 }));
}

/** A target read, or null where no question applies to the target. */
export function figuresOfRating(rating: TargetRating): Figures | null {
  if (rating.status !== 'available' || !rating.scale) return null;
  const histogram = Array.from({ length: rating.scale.max }, () => 0);
  for (const entry of rating.distribution) if (entry.value >= 1 && entry.value <= histogram.length) histogram[entry.value - 1] = entry.count;
  return { count: rating.count, mean: rating.meanDisplay === 'shown' ? rating.mean : null,
    displayThreshold: rating.displayThreshold, max: rating.scale.max, histogram };
}

/** A roll-up member Main could count; a member it could not is not a figure. */
export function figuresOfMember(member: RollupMember, threshold: number, max: number): Figures | null {
  if (member.status !== 'available') return null;
  return { count: member.components.count, mean: member.meanDisplay === 'shown' ? member.mean : null,
    displayThreshold: threshold, max, histogram: member.components.histogram.slice(0, max) };
}
