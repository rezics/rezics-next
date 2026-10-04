/** Additive rating figures of one RatingContext and target: they sum across
 * targets, so every derived figure recomputes from them and never from a mean. */
export interface RatingComponents { count: number; sum: number; histogram: readonly number[] }

export type MeanDisplay = 'shown' | 'withheld-below-threshold' | 'no-data';

/** A mean shows only from `threshold` ratings; below it the count and histogram
 * still show. The histogram is what the sum and count were added from. */
export function meanDisclosure(components: RatingComponents, threshold: number):
  { mean: number | null; display: MeanDisplay } {
  if (components.count === 0) return { mean: null, display: 'no-data' };
  if (components.count < threshold) return { mean: null, display: 'withheld-below-threshold' };
  return { mean: components.sum / components.count, display: 'shown' };
}

/** The additive figures agree with each other: the count and the sum are what
 * the histogram says. A caller that holds a mismatch has a defect, not data. */
export function componentsAgree(components: RatingComponents): boolean {
  return components.histogram.length === 10 && components.histogram.every(bin => Number.isInteger(bin) && bin >= 0)
    && components.count === components.histogram.reduce((total, bin) => total + bin, 0)
    && components.sum === components.histogram.reduce((total, bin, index) => total + bin * (index + 1), 0);
}
