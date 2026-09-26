import { t } from 'elysia';
import { sourcePosition } from '../../api-contract.ts';
import { EXPERIENCE_AGGREGATE_PROFILES, EXPERIENCE_POLICIES } from './experience-reduction.ts';

const target = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const integerText = t.String({ pattern: '^(0|[1-9][0-9]*)$', maxLength: 128 });
const positiveText = t.String({ pattern: '^[1-9][0-9]*$', maxLength: 128 });
const fraction = { numerator: integerText, denominator: positiveText };
const count = t.Integer({ minimum: 0, maximum: 100 });
const unit = t.Union([t.Literal('rater'), t.Literal('observation')]);

export const experienceAggregateInput = t.Object({
  profile: t.Union(EXPERIENCE_AGGREGATE_PROFILES.map(value => t.Literal(value))),
  context: target, work: target, mainVersion: target,
}, { additionalProperties: false });

export const experienceAggregateResult = t.Union(EXPERIENCE_AGGREGATE_PROFILES.map(profile => t.Object({
  profile: t.Literal(profile), aggregationPolicy: t.Literal(EXPERIENCE_POLICIES[profile]),
  policyRevision: t.Literal(`https://rezics.com/definition/rating-${EXPERIENCE_POLICIES[profile]}-v1`),
  complete: t.Literal(true), context: target, realm: target, work: target, mainVersion: target,
  targetGrain: t.Literal('mainVersion'), cadence: t.Literal('experience'),
  populationPolicy: t.Literal('account-principal'),
  scale: t.Object({ min: t.Literal(1), max: t.Literal(10), step: t.Literal(1) }),
  timeBasis: t.Object({ coverage: t.Literal('all-admitted-experiences'),
    revisionSelection: t.Literal('current-effective-head'), latestOrder: t.Literal('evaluatedAt-then-observation-iri'),
    evaluatedRange: t.Nullable(t.Object({ first: t.String(), last: t.String() })) }),
  population: t.Object({ observations: count, raters: count, availableObservations: count,
    withdrawnObservations: count, contributingRaters: count }),
  count, denominatorUnit: unit,
  observationHistogram: t.Tuple([count, count, count, count, count, count, count, count, count, count]),
  distribution: t.Object({ unit, points: t.Array(t.Object({ ...fraction, count }), { maxItems: 100 }) }),
  sum: t.Object(fraction), mean: t.Nullable(t.Number()),
  precision: t.Union([t.Object({ kind: t.Literal('no-data') }),
    t.Object({ kind: t.Literal('exact-rational'), ...fraction })]),
  sourcePosition,
})));
