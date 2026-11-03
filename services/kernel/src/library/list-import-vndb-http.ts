import { t } from 'elysia';
import { VNDB_LIMITS } from './list-import-vndb-parser.ts';

const object = <P extends Parameters<typeof t.Object>[0]>(properties: P) =>
  t.Object(properties, { additionalProperties: false });
const strings = (...values: string[]) => t.Union(values.map((v) => t.Literal(v)));
const nullable = <T extends Parameters<typeof t.Union>[0][number]>(schema: T) => t.Union([schema, t.Null()]);
const uuid = t.String({ format: 'uuid' });
const nullableText = nullable(t.String());
const count = t.Integer({ minimum: 0 });
const disposition = strings('applied', 'skipped', 'stale', 'unsupported', 'failed');
const reviewStatus = strings('reviewed', 'applying', 'applied', 'skipped', 'stale', 'unsupported', 'failed');
const scoreStatus = strings('reviewed', 'applying', 'applied', 'skipped', 'stale', 'unsupported', 'failed', 'unavailable');
const baseline = t.Union([
  t.Null(),
  object({ state: t.String(), revision: t.Integer({ minimum: 1 }), incarnationId: nullableText }),
]);
export const vndbDecisionSchema = object({
  reviewId: uuid,
  status: reviewStatus,
  targetId: nullableText,
  state: nullableText,
  baseline,
  replace: t.Boolean(),
  action: nullable(strings('state', 'skip', 'retain')),
});
const nativeQuestion = object({
  id: uuid,
  revision: t.Integer({ minimum: 1 }),
  meaning: nullableText,
  label: t.String(),
  grain: strings('work', 'release', 'episode', 'character'),
  scale: object({ min: t.Integer(), max: t.Integer(), step: t.Integer({ minimum: 1 }) }),
  aggregateEffect: t.Literal('public-standard-aggregate'),
});
const nativeVoteObservation = t.Union([
  object({ state: t.Literal('unavailable') }),
  object({ state: t.Literal('absent') }),
  object({ state: t.Literal('cleared'), revision: t.Integer({ minimum: 1 }), at: t.String() }),
  object({ state: t.Literal('set'), units: t.Integer({ minimum: 0 }), revision: t.Integer({ minimum: 1 }), at: t.String() }),
]);
const scoreDecision = object({
  reviewId: uuid,
  status: scoreStatus,
  targetId: uuid,
  action: strings('vote', 'clear'),
  units: nullable(t.Integer({ minimum: 0, maximum: 20 })),
  question: nativeQuestion,
  currentVote: nativeVoteObservation,
  consent: strings('adopt-native-vote', 'clear-native-vote'),
  sourceReason: t.String(),
  nativeAdmission: t.Literal('unavailable'),
});
export const vndbReviewSchema = t.Union([
  vndbDecisionSchema,
  scoreDecision,
  object({
    status: t.Literal('unavailable'),
    reason: strings('native-question-unavailable', 'native-current-vote-unavailable'),
  }),
]);
const nativeScore = object({
  question: nullable(nativeQuestion),
  currentVote: nativeVoteObservation,
  sourceReason: t.String(),
  exactUnits: nullable(t.Integer({ minimum: 0, maximum: 20 })),
  admission: object({
    status: t.Literal('unavailable'),
    reason: strings(
      'conditional-admission-unavailable',
      'native-question-unavailable',
      'native-current-vote-unavailable',
      'source-not-vn-score',
    ),
  }),
});
const sourceValue = object({
  kind: strings('missing', 'unknown', 'invalid', 'value'),
  raw: nullableText,
  value: t.Optional(t.Union([t.String(), t.Number()])),
  precision: t.Optional(strings('year', 'month', 'day')),
  scale: t.Optional(object({ min: t.Number(), max: t.Number(), step: t.Number() })),
});
const row = object({
  ordinal: count,
  kind: strings('vn', 'retained'),
  identifier: t.Union([t.Null(), object({ provider: t.Literal('vndb'), kind: t.Literal('vn'), value: t.String() })]),
  title: t.String(),
  labels: t.Array(t.String()),
  suggestedRole: nullableText,
  fields: t.Record(t.String(), sourceValue),
  retainedReason: t.String(),
  evidence: t.Unknown(),
  match: object({
    status: strings('matched', 'ambiguous', 'unmatched', 'unavailable', 'unsupported'),
    candidates: t.Array(uuid, { maxItems: 2 }),
  }),
  target: t.Union([
    t.Null(),
    object({
      targetId: uuid,
      states: t.Array(
        object({ id: t.String(), labels: t.Record(t.String(), t.String()), role: t.Optional(t.String()) }),
      ),
      baseline,
    }),
  ]),
  decision: t.Union([t.Null(), vndbDecisionSchema]),
  scoreDecision: t.Union([t.Null(), scoreDecision]),
  nativeScore,
  fieldsTreatment: object({ state: t.String(), score: t.String(), other: t.String() }),
});
export const vndbPreviewSchema = object({
  uploadId: uuid,
  rows: count,
  limits: object(Object.fromEntries(Object.entries(VNDB_LIMITS).map(([key, value]) => [key, t.Literal(value)]))),
});
export const vndbPageSchema = object({
  uploadId: uuid,
  state: strings('active', 'cancelled'),
  expiresAt: t.String(),
  total: count,
  next: nullable(count),
  rows: t.Array(row, { maxItems: VNDB_LIMITS.page }),
});
export const vndbApplySchema = object({
  uploadId: uuid,
  outcomes: t.Array(t.Union([
    object({ ordinal: count, reviewId: uuid, status: disposition }),
    object({ ordinal: count, scoreReviewId: uuid, status: strings('applied', 'skipped', 'stale', 'unsupported', 'failed', 'unavailable') }),
  ]), {
    maxItems: VNDB_LIMITS.page,
  }),
  stopped: nullable(strings('deadline', 'cancelled')),
});
export const vndbSourceSchema = object({ xml: t.String({ maxLength: VNDB_LIMITS.bytes }) });
export const vndbRemovalSchema = object({ uploadId: uuid, state: strings('cancelled', 'deleted') });
