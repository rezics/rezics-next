import { languageTagSchema } from '../display-language/schema.ts';
import { t } from 'elysia';
import { sourcePosition } from '../../api-contract.ts';
import { readId } from '../work/read-contract.ts';
import { TARGET_CONTEXT_ID, LEGACY_TARGET_CONTEXT_ID, TARGET_OBSERVATION_ID, TARGET_RATING_WRITE_COST } from './target.ts';
import { TARGET_AGGREGATE_PROFILE } from './target-aggregate.ts';

export const targetGrain = t.Union([t.Literal('release'), t.Literal('realization'), t.Literal('occurrence'), t.Literal('resource')]);
const questionLanguage = languageTagSchema(TARGET_RATING_WRITE_COST.questionLanguageBytes);
export const targetRatingContextInput = t.Object({ profile: t.Literal(TARGET_CONTEXT_ID), realm: readId,
  question: t.String({ minLength: 3, maxLength: 120 }), language: questionLanguage, targetGrain, actingSubject: readId }, { additionalProperties: false });
export const targetRatingContextReadResult = t.Object({ context: readId, realm: readId,
  question: t.String({ minLength: 3, maxLength: 120 }), language: questionLanguage, contextRevision: readId, targetGrain,
  scale: t.Object({ min: t.Literal(1), max: t.Literal(10), step: t.Literal(1) }), cadence: t.Literal('standing'),
  population: t.Literal('account-principal'), aggregation: t.Literal('latest-per-rater-mean'),
  profile: t.Union([t.Literal(TARGET_CONTEXT_ID), t.Literal(LEGACY_TARGET_CONTEXT_ID)]) });
export const targetRatingContextWriteResult = t.Object({ ...targetRatingContextReadResult.properties,
  profile: t.Literal(TARGET_CONTEXT_ID), sourcePosition, replayed: t.Boolean() });
export const targetRatingObservationInput = t.Object({ profile: t.Literal(TARGET_OBSERVATION_ID),
  context: readId, target: readId, actingSubject: readId, expectedRevisionHead: t.Nullable(readId),
  value: t.Nullable(t.Integer({ minimum: 1, maximum: 10 })) }, { additionalProperties: false });
export const targetRatingObservationWriteResult = t.Object({ profile: t.Literal(TARGET_OBSERVATION_ID),
  context: readId, target: readId, observation: readId, observationRevision: readId, predecessor: t.Nullable(readId),
  value: t.Nullable(t.Integer({ minimum: 1, maximum: 10 })),
  availability: t.Union([t.Literal('available'), t.Literal('withdrawn')]), sourcePosition, replayed: t.Boolean() });
export const targetRatingObservationReadResult = t.Object({
  ...t.Omit(targetRatingObservationWriteResult, ['sourcePosition', 'replayed']).properties, evaluatedAt: t.String(), submittedAt: t.String(),
  originalSubmissionAt: t.String(), revisedAt: t.String() });
export const targetAggregateInput = t.Object({ profile: t.Literal(TARGET_AGGREGATE_PROFILE),
  context: readId, target: readId, actingSubject: t.Optional(readId) }, { additionalProperties: false });
const count = t.Integer({ minimum: 0, maximum: 100 });
export const targetAggregateResult = t.Object({ profile: t.Literal(TARGET_AGGREGATE_PROFILE),
  complete: t.Literal(true), context: readId, realm: readId, target: readId, targetGrain,
  scope: t.Object({ question: t.String({ minLength: 3, maxLength: 120 }), language: questionLanguage, grain: targetGrain,
    population: t.Literal('account-principal'), countedTarget: readId }),
  scale: targetRatingContextReadResult.properties.scale, cadence: t.Literal('standing'),
  populationPolicy: t.Literal('account-principal'), aggregationPolicy: t.Literal('latest-per-rater-mean'),
  population: count, count, withdrawnCount: count, histogram: t.Array(count, { minItems: 10, maxItems: 10 }),
  sum: t.Integer({ minimum: 0, maximum: 1000 }), mean: t.Nullable(t.Number()),
  precision: t.Union([t.Object({ kind: t.Literal('no-data') }), t.Object({ kind: t.Literal('exact-rational'),
    numerator: t.Integer({ minimum: 1 }), denominator: t.Integer({ minimum: 1 }) })]), sourcePosition });
