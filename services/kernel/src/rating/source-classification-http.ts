import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import type { Static } from 'typebox';
import {
  ClassificationAssociationSchema,
  ClassificationObservationSchema,
  ClassificationClearSchema,
  ClassificationSourceVersionSchema,
} from './source-classification-contract.ts';

const closed = { additionalProperties: false } as const;
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
export function SourceClassificationBatchInputSchema() {
  return memoizedValue(SourceClassificationBatchInputSchema, () =>
    t.Object(
      {
        associations: t.Array(ClassificationAssociationSchema, { maxItems: 32 }),
      },
      closed,
    ),
  );
}
function command() {
  return memoizedValue(command, () => ({
    association: ClassificationAssociationSchema,
    expectedObservation: t.Union([digest, t.Null()]),
  }));
}
export function SourceClassificationPutInputSchema() {
  return memoizedValue(SourceClassificationPutInputSchema, () =>
    t.Object({ ...command(), value: ClassificationObservationSchema }, closed),
  );
}
export function SourceClassificationClearInputSchema() {
  return memoizedValue(SourceClassificationClearInputSchema, () =>
    t.Object({ ...command(), value: ClassificationClearSchema }, closed),
  );
}
const absent = t.Object({ state: t.Literal('unavailable'), reason: t.Literal('not_supplied') }, closed);
export function SourceClassificationFigureSchema() {
  return memoizedValue(SourceClassificationFigureSchema, () =>
    t.Object(
      {
        provider: t.Literal('vndb'),
        association: ClassificationAssociationSchema,
        observation: t.Object({ digest, sourceVersion: ClassificationSourceVersionSchema }, closed),
        sourceAlias: t.String(),
        sourceRecordId: t.String(),
        sourceAssociationId: t.String(),
        confidence: t.Union([
          absent,
          t.Object(
            {
              state: t.Literal('available'),
              value: t.Number(),
              unit: t.Literal('vndb-tag-rating'),
              minExclusive: t.Literal(0),
              max: t.Literal(3),
            },
            closed,
          ),
        ]),
        lie: t.Union([
          absent,
          t.Object({ state: t.Literal('available'), value: t.Boolean(), unit: t.Literal('boolean') }, closed),
        ]),
        confidenceCount: t.Optional(t.Integer()),
        lieCount: t.Optional(t.Integer()),
        asOf: t.String(),
        ageSeconds: t.Integer(),
        attribution: t.String(),
        licence: t.String(),
      },
      closed,
    ),
  );
}
export function SourceClassificationReadSchema() {
  return memoizedValue(SourceClassificationReadSchema, () =>
    t.Union([
      t.Object({ state: t.Literal('available'), value: SourceClassificationFigureSchema() }, closed),
      t.Object(
        {
          state: t.Literal('unavailable'),
          reason: t.Union([
            t.Literal('not_found'),
            t.Literal('not_observed'),
            t.Literal('provenance_unavailable'),
            t.Literal('authority_unavailable'),
            t.Literal('changed'),
          ]),
        },
        closed,
      ),
    ]),
  );
}
export function SourceClassificationBatchSchema() {
  return memoizedValue(SourceClassificationBatchSchema, () =>
    t.Object(
      {
        items: t.Array(SourceClassificationReadSchema(), { maxItems: 32 }),
        actions: t.Array(t.Union([t.Literal('put'), t.Literal('clear')]), { maxItems: 2 }),
      },
      closed,
    ),
  );
}
const mutation = { observationDigest: digest, state: t.Union([t.Literal('published'), t.Literal('cleared')]) };
export function SourceClassificationPutSchema() {
  return memoizedValue(SourceClassificationPutSchema, () =>
    t.Object({ ...mutation, figure: SourceClassificationFigureSchema() }, closed),
  );
}
export const SourceClassificationClearResultSchema = t.Object(mutation, closed);
export type SourceClassificationBatchInput = Static<ReturnType<typeof SourceClassificationBatchInputSchema>>;
export type SourceClassificationPutInput = Static<ReturnType<typeof SourceClassificationPutInputSchema>>;
export type SourceClassificationClearInput = Static<ReturnType<typeof SourceClassificationClearInputSchema>>;
export type SourceClassificationBatch = Static<ReturnType<typeof SourceClassificationBatchSchema>>;
export type SourceClassificationPutResult = Static<ReturnType<typeof SourceClassificationPutSchema>>;
export type SourceClassificationClearResult = Static<typeof SourceClassificationClearResultSchema>;
