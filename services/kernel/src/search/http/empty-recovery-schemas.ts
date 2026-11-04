import { t } from 'elysia';

const closed = { additionalProperties: false } as const;

export const EmptyRecoveryActionSchema = t.Union([
  t.Object({ kind: t.Literal('edit-query') }, closed),
  t.Object({ kind: t.Literal('remove-type') }, closed),
  t.Object({ kind: t.Literal('remove-kind'), value: t.String({ maxLength: 128 }) }, closed),
  t.Object(
    { kind: t.Literal('remove-facet'), property: t.String({ maxLength: 128 }), value: t.String({ maxLength: 128 }) },
    closed,
  ),
  t.Object({ kind: t.Literal('remove-range'), property: t.String({ maxLength: 128 }) }, closed),
]);

export const EmptyRecoverySchema = t.Object(
  {
    status: t.Union([t.Literal('ready'), t.Literal('preparing'), t.Literal('unavailable')]),
    alternatives: t.Array(
      t.Object({ query: t.String({ maxLength: 128 }), label: t.String({ maxLength: 128 }) }, closed),
      { maxItems: 3 },
    ),
    actions: t.Array(EmptyRecoveryActionSchema, { maxItems: 8 }),
  },
  closed,
);

export const EmptyRecoveryActionsSchema = t.Optional(t.Array(EmptyRecoveryActionSchema, { maxItems: 8 }));
