import type { RatingSummary } from './types.ts';

// What the reviews section needs to review more than the Work's own story: the reviewable targets of the Work and
// the aggregate scope Main gives with each rating summary. Plain data, so the server builds it and the browser reads it.

/** The grains a Work's reviews are filtered by: its story (Main Version), an edition (release), a translation (realization), a related Work. */
export type ReviewGrain = 'story' | 'edition' | 'translation' | 'related';

/** Something reviewers were asked about: a resource Main knows by its IRI, named for the chooser. */
export interface ReviewTarget { grain: ReviewGrain; target: string; label: string; language?: string }

/** The query that selects a rating scope on Main's resource reads (`scope` and, for a Realm, its IRI). */
export type ReviewScopeQuery = { scope: 'global' | 'realm' | 'mine'; realm?: string };

/**
 * The aggregate of one rating question, with the scope Main states for it: the question asked, the grain it counts
 * (an edition is not its story), whose ratings are counted, and the resource counted.
 */
export interface ReviewAggregate {
  question: string; grain: string; population: string; countedTarget: string;
  count: number; mean: number | null; scale: { min: number; max: number } | null;
  /** Retains the owner's histogram and disclosure metadata for target aggregates. */
  summary?: RatingSummary;
}

/** The aggregate of a rating summary, exactly as Main returned it; null when the summary has no question or states no scope. */
export function aggregateOf(summary: RatingSummary): ReviewAggregate | null {
  if (summary.status !== 'available' || !summary.aggregationScope) return null;
  const { question, grain, population, countedTarget } = summary.aggregationScope;
  return { question, grain, population, countedTarget, count: summary.count, mean: summary.mean,
    scale: summary.scale ? { min: summary.scale.min, max: summary.scale.max } : null, summary };
}
