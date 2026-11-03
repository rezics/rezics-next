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
  fieldsTreatment: object({ state: t.String(), other: t.String() }),
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
  outcomes: t.Array(object({ ordinal: count, reviewId: uuid, status: disposition }), {
    maxItems: VNDB_LIMITS.page,
  }),
  stopped: nullable(strings('deadline', 'cancelled')),
});
export const vndbSourceSchema = object({ xml: t.String({ maxLength: VNDB_LIMITS.bytes }) });
export const vndbRemovalSchema = object({ uploadId: uuid, state: strings('cancelled', 'deleted') });
