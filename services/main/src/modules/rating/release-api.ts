import { t } from 'elysia';
import { sourcePosition } from '../../api-contract.ts';
import { RELEASE_CONTEXT_ID, RELEASE_OBSERVATION_ID } from './release.ts';
import { RELEASE_AGGREGATE_PROFILE } from './release-aggregate.ts';

const target = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const scale = t.Object({ min: t.Literal(1), max: t.Literal(10), step: t.Literal(1) });
const availability = t.Union([t.Literal('available'), t.Literal('withdrawn')]);
const replay = { sourcePosition, replayed: t.Boolean() };

export const releaseRatingContextInput = t.Object({
  profile: t.Literal(RELEASE_CONTEXT_ID), realm: target,
  question: t.String({ minLength: 3, maxLength: 120 }), actingSubject: target,
}, { additionalProperties: false });

export const releaseRatingContextReadResult = t.Object({
  context: target, realm: target, question: t.String(), contextRevision: target,
  targetGrain: t.Literal('fixedRelease'), scale, cadence: t.Literal('standing'),
  population: t.Literal('account-principal'), aggregation: t.Literal('latest-per-rater-mean'),
  profile: t.Literal(RELEASE_CONTEXT_ID),
});
export const releaseRatingContextWriteResult = t.Object({
  ...releaseRatingContextReadResult.properties, ...replay,
});

/** The release names its Work and MainVersion; the command checks both against the sealed release. */
export const releaseRatingObservationInput = t.Object({
  profile: t.Literal(RELEASE_OBSERVATION_ID), context: target, work: target,
  mainVersion: target, release: target, expectedRevisionHead: t.Nullable(target),
  value: t.Nullable(t.Integer({ minimum: 1, maximum: 10 })), actingSubject: target,
}, { additionalProperties: false });

export const releaseRatingObservationWriteResult = t.Object({
  observation: target, observationRevision: target, predecessor: t.Nullable(target),
  context: target, work: target, mainVersion: target, release: target,
  value: t.Nullable(t.Integer()), availability, profile: t.Literal(RELEASE_OBSERVATION_ID), ...replay,
});
export const releaseRatingObservationReadResult = t.Object({
  observation: target, observationRevision: target, context: target, work: target,
  mainVersion: target, release: target, predecessor: t.Nullable(target), availability,
  value: t.Nullable(t.Integer()), evaluatedAt: t.String(), submittedAt: t.String(),
  originalSubmissionAt: t.String(), revisedAt: t.String(), profile: t.Literal(RELEASE_OBSERVATION_ID),
});

export const releaseAggregateInput = t.Object({
  profile: t.Literal(RELEASE_AGGREGATE_PROFILE), context: target, release: target,
}, { additionalProperties: false });

const count = t.Integer({ minimum: 0, maximum: 100 });
export const releaseAggregateResult = t.Object({
  profile: t.Literal(RELEASE_AGGREGATE_PROFILE), complete: t.Literal(true),
  context: target, realm: target, work: target, mainVersion: target, release: target,
  targetGrain: t.Literal('fixedRelease'), scale, cadence: t.Literal('standing'),
  populationPolicy: t.Literal('account-principal'), aggregationPolicy: t.Literal('latest-per-rater-mean'),
  population: count, count, withdrawnCount: count,
  histogram: t.Tuple([count, count, count, count, count, count, count, count, count, count]),
  sum: t.Integer({ minimum: 0, maximum: 1000 }), mean: t.Nullable(t.Number()),
  precision: t.Union([t.Object({ kind: t.Literal('no-data') }),
    t.Object({ kind: t.Literal('exact-rational'), numerator: t.Integer(), denominator: t.Integer() })]),
  sourcePosition,
});
