import { languageTagSchema } from '../display-language/schema.ts';
import { t } from 'elysia';
import { sourcePosition } from '../../api-contract.ts';
import { readId } from '../work/read-contract.ts';
import { TARGET_CONTEXT_ID, SCOPED_TARGET_CONTEXT_ID, LEGACY_TARGET_CONTEXT_ID, TARGET_OBSERVATION_ID, TARGET_RATING_WRITE_COST,
  MAX_DISPLAY_THRESHOLD, ACCEPTED_TARGET_CONTEXT_ID } from './target.ts';
import { ACCEPTED_FRAME_DIMENSIONS, CONTEXT_ACCEPTANCE_COST } from './acceptance.ts';
import { TARGET_AGGREGATE_PROFILE } from './target-aggregate.ts';

const legacyTargetGrain = t.Union([t.Literal('release'), t.Literal('realization'), t.Literal('occurrence'), t.Literal('resource')]);
export const targetGrain = t.Union([...legacyTargetGrain.anyOf, t.Literal('projection')]);
const questionLanguage = languageTagSchema(TARGET_RATING_WRITE_COST.questionLanguageBytes);
export const targetRatingContextInput = t.Object({ profile: t.Literal(TARGET_CONTEXT_ID), realm: readId,
  question: t.String({ minLength: 3, maxLength: 120 }), language: questionLanguage, targetGrain: legacyTargetGrain, actingSubject: readId }, { additionalProperties: false });
const displayThreshold = t.Integer({ minimum: 1, maximum: MAX_DISPLAY_THRESHOLD });
/** v3 admits projections and its optional threshold override. */
export const scopedTargetRatingContextInput = t.Object({ profile: t.Literal(SCOPED_TARGET_CONTEXT_ID), realm: readId,
  question: t.String({ minLength: 3, maxLength: 120 }), language: questionLanguage, targetGrain,
  displayThreshold: t.Optional(displayThreshold),
  actingSubject: readId }, { additionalProperties: false });
const acceptanceFields = {
  acceptedSubjectTypes: t.Optional(t.Array(t.String({ pattern: '^https?://[^\\s<>"{}|^`\\\\]+$', maxLength: 512 }),
    { minItems: 1, maxItems: CONTEXT_ACCEPTANCE_COST.subjectTypes, uniqueItems: true })),
  acceptedFrameDimensions: t.Optional(t.Array(t.Union(ACCEPTED_FRAME_DIMENSIONS.map(dimension => t.Literal(dimension))),
    { minItems: 1, maxItems: CONTEXT_ACCEPTANCE_COST.frameDimensions, uniqueItems: true })),
};
export const ratingContextOwner = t.Object({ kind: t.Union([t.Literal('realm'), t.Literal('global')]), id: readId });
export const acceptedTargetRatingContextInput = t.Object({ ...scopedTargetRatingContextInput.properties,
  profile: t.Literal(ACCEPTED_TARGET_CONTEXT_ID), ...acceptanceFields }, { additionalProperties: false });
export const targetRatingContextReadResult = t.Object({ context: readId, realm: readId,
  question: t.String({ minLength: 3, maxLength: 120 }), language: questionLanguage, contextRevision: readId, targetGrain,
  scale: t.Object({ min: t.Literal(1), max: t.Literal(10), step: t.Literal(1) }), cadence: t.Literal('standing'),
  population: t.Literal('account-principal'), aggregation: t.Literal('latest-per-rater-mean'), displayThreshold,
  owner: ratingContextOwner, ...acceptanceFields,
  profile: t.Union([t.Literal(ACCEPTED_TARGET_CONTEXT_ID), t.Literal(SCOPED_TARGET_CONTEXT_ID), t.Literal(TARGET_CONTEXT_ID), t.Literal(LEGACY_TARGET_CONTEXT_ID)]) });
export const targetRatingContextWriteResult = t.Object({ ...targetRatingContextReadResult.properties,
  profile: t.Union([t.Literal(ACCEPTED_TARGET_CONTEXT_ID), t.Literal(SCOPED_TARGET_CONTEXT_ID), t.Literal(TARGET_CONTEXT_ID)]), sourcePosition, replayed: t.Boolean() });
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
const count = t.Integer({ minimum: 0 });
export const meanDisplay = t.Union([t.Literal('shown'), t.Literal('withheld-below-threshold'), t.Literal('no-data')]);
const aggregatePrecision = t.Union([t.Object({ kind: t.Literal('no-data') }),
  t.Object({ kind: t.Literal('withheld-below-threshold') }),
  t.Object({ kind: t.Literal('exact-rational'), numerator: t.Integer({ minimum: 1 }), denominator: t.Integer({ minimum: 1 }) })]);
/** Count, histogram and sum always show; the mean only from the Context's display threshold. */
export const targetAggregateResult = t.Object({ profile: t.Literal(TARGET_AGGREGATE_PROFILE),
  complete: t.Literal(true), context: readId, realm: readId, target: readId, targetGrain,
  contextRevision: readId,
  lastAdmissionId: t.Nullable(t.String({ format: 'uuid' })),
  scope: t.Object({ question: t.String({ minLength: 3, maxLength: 120 }), language: questionLanguage, grain: targetGrain,
    population: t.Literal('account-principal'), countedTarget: readId }),
  scale: targetRatingContextReadResult.properties.scale, cadence: t.Literal('standing'),
  populationPolicy: t.Literal('account-principal'), aggregationPolicy: t.Literal('latest-per-rater-mean'),
  population: count, count, withdrawnCount: count, histogram: t.Array(count, { minItems: 10, maxItems: 10 }),
  sum: t.Integer({ minimum: 0 }), displayThreshold, mean: t.Nullable(t.Number()), meanDisplay,
  precision: aggregatePrecision, sourcePosition });
