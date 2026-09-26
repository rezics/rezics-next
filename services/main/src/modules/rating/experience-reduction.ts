export const EXPERIENCE_AGGREGATE_PROFILES = [
  'realm-experience-latest-per-rater-mean-v1',
  'realm-experience-mean-per-rater-v1',
  'realm-experience-pooled-observation-mean-v1',
] as const;
export type ExperienceAggregateProfile = typeof EXPERIENCE_AGGREGATE_PROFILES[number];
export const EXPERIENCE_POLICIES = {
  'realm-experience-latest-per-rater-mean-v1': 'latest-per-rater-mean',
  'realm-experience-mean-per-rater-v1': 'mean-per-rater',
  'realm-experience-pooled-observation-mean-v1': 'pooled-observation-mean',
} as const;

interface Fraction { n: bigint; d: bigint }
function fraction(n: bigint, d = 1n): Fraction {
  let a = n, b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}
function add(a: Fraction, b: Fraction): Fraction { return fraction(a.n * b.d + b.n * a.d, a.d * b.d); }
function encoded(value: Fraction) { return { numerator: String(value.n), denominator: String(value.d) }; }
const compareFraction = (a: Fraction, b: Fraction) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;

export interface EffectiveExperience {
  observation: string; raterKey: string; evaluatedAt: string; value: number | null;
}

/** Input is already a complete, verified owner snapshot, at most 100 slots.
 * Never sort by revision time or drop tombstones before selecting the latest. */
export function reduceExperienceRatings(profile: ExperienceAggregateProfile, observations: readonly EffectiveExperience[]) {
  const grouped = new Map<string, { latest: EffectiveExperience; sum: number; count: number }>();
  const histogram = Array.from({ length: 10 }, () => 0);
  let availableCount = 0;
  let first: string | null = null, last: string | null = null;
  for (const observation of observations) {
    if (first === null || observation.evaluatedAt < first) first = observation.evaluatedAt;
    if (last === null || observation.evaluatedAt > last) last = observation.evaluatedAt;
    let rater = grouped.get(observation.raterKey);
    if (!rater) { rater = { latest: observation, sum: 0, count: 0 }; grouped.set(observation.raterKey, rater); }
    if (observation.evaluatedAt > rater.latest.evaluatedAt
      || (observation.evaluatedAt === rater.latest.evaluatedAt && observation.observation > rater.latest.observation)) {
      rater.latest = observation;
    }
    if (observation.value !== null) {
      rater.sum += observation.value; rater.count++; availableCount++;
      histogram[observation.value - 1] = histogram[observation.value - 1]! + 1;
    }
  }
  const policy = EXPERIENCE_POLICIES[profile];
  const points = new Map<string, { value: Fraction; count: number }>();
  let sum = fraction(0n), count = 0, contributingRaters = 0;
  const include = (value: Fraction) => {
    sum = add(sum, value); count++;
    const key = `${value.n}/${value.d}`, prior = points.get(key);
    if (prior) prior.count++; else points.set(key, { value, count: 1 });
  };
  if (policy === 'pooled-observation-mean') {
    for (const observation of observations) if (observation.value !== null) include(fraction(BigInt(observation.value)));
    for (const rater of grouped.values()) if (rater.count) contributingRaters++;
  } else {
    for (const rater of grouped.values()) {
      const value = policy === 'latest-per-rater-mean'
        ? rater.latest.value === null ? null : fraction(BigInt(rater.latest.value))
        : rater.count ? fraction(BigInt(rater.sum), BigInt(rater.count)) : null;
      if (value) { include(value); contributingRaters++; }
    }
  }
  const mean = count ? fraction(sum.n, sum.d * BigInt(count)) : null;
  const unit = policy === 'pooled-observation-mean' ? 'observation' as const : 'rater' as const;
  return {
    aggregationPolicy: policy,
    policyRevision: `https://rezics.com/definition/rating-${policy}-v1`,
    timeBasis: { coverage: 'all-admitted-experiences' as const,
      revisionSelection: 'current-effective-head' as const,
      latestOrder: 'evaluatedAt-then-observation-iri' as const,
      evaluatedRange: first === null ? null : { first, last: last! } },
    population: { observations: observations.length, raters: grouped.size,
      availableObservations: availableCount, withdrawnObservations: observations.length - availableCount,
      contributingRaters },
    count, denominatorUnit: unit, observationHistogram: histogram,
    distribution: { unit, points: [...points.values()].sort((a, b) => compareFraction(a.value, b.value))
      .map(point => ({ ...encoded(point.value), count: point.count })) },
    sum: encoded(sum), mean: mean ? Number(mean.n) / Number(mean.d) : null,
    precision: mean ? { kind: 'exact-rational' as const, ...encoded(mean) } : { kind: 'no-data' as const },
  };
}
