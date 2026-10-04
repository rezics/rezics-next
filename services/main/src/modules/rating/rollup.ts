import { meanDisclosure, type RatingComponents } from './components.ts';

/** A roll-up is its own metric: a named formula over one RatingContext's additive
 * components, never over stored means and never across Contexts or scales. */
const ROLLUP_FORMULAS = ['pooled', 'mean-of-means'] as const;
export type RollupFormula = typeof ROLLUP_FORMULAS[number];
export const MAX_ROLLUP_MEMBERS = 200;
/** Members below this many ratings are not ranked, however high their mean. */
export const RANK_MINIMUM_RATINGS = 50;
export const RANK_FORMULA = 'bayesian-weighted-rating';

export type ValueWithheld = 'coverage-below-half';

/** `requested` counts every named member, readable or not; `members` are the
 * readable ones. Coverage is the share of requested members at or above the
 * display threshold, and a value shows only when that share reaches half. */
export function rollUp(formula: RollupFormula, members: readonly RatingComponents[], requested: number, threshold: number) {
  const meeting = members.filter(member => member.count >= threshold);
  const coverage = { members: requested, available: members.length, meetingThreshold: meeting.length };
  if (meeting.length * 2 < requested) return { coverage, value: null, valueWithheld: 'coverage-below-half' as ValueWithheld };
  // Coverage of at least half of a nonempty request leaves one member with ratings.
  const value = formula === 'pooled'
    ? members.reduce((total, member) => total + member.sum, 0) / members.reduce((total, member) => total + member.count, 0)
    : meeting.reduce((total, member) => total + member.sum / member.count, 0) / meeting.length;
  return { coverage, value, valueWithheld: null };
}

/** The prior comes from the same RatingContext's own components: its pooled mean,
 * weighted as the average ratings per target but never lighter than the ranking
 * minimum, so a sparse Context cannot hand a handful of ratings full say. */
export function rankingPrior(context: { targets: number; count: number; sum: number }) {
  if (context.targets < 1 || context.count < 1) return null;
  return { mean: context.sum / context.count,
    weight: Math.max(RANK_MINIMUM_RATINGS, Math.round(context.count / context.targets)),
    ratings: context.count, targets: context.targets };
}
export type RankingPrior = NonNullable<ReturnType<typeof rankingPrior>>;

/** (v / (v + m)) * R + (m / (v + m)) * C: the member's mean R pulled toward the prior C by weight m. */
export function weightedRating(components: RatingComponents, prior: RankingPrior): number {
  const { count } = components;
  return (count / (count + prior.weight)) * (components.sum / count) + (prior.weight / (count + prior.weight)) * prior.mean;
}

/** Members with enough ratings, best first; ties keep the larger sample, then target order. */
export function rankMembers<T extends { target: string; components: RatingComponents }>(members: readonly T[],
  prior: RankingPrior) {
  return members.filter(member => member.components.count >= RANK_MINIMUM_RATINGS)
    .map(member => ({ target: member.target, count: member.components.count,
      mean: member.components.sum / member.components.count, score: weightedRating(member.components, prior) }))
    .sort((a, b) => b.score - a.score || b.count - a.count || (a.target < b.target ? -1 : 1))
    .map((item, index) => ({ position: index + 1, ...item }));
}

/** A member's own figure, with the same display threshold as its page. */
export function memberFigure(components: RatingComponents, threshold: number) {
  const { mean, display } = meanDisclosure(components, threshold);
  return { mean, meanDisplay: display, meetsThreshold: components.count >= threshold };
}
