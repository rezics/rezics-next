import { t } from 'elysia';
import type { TProperties } from 'typebox';

const closed = { additionalProperties: false } as const;
const readResult = t.Object({ status: t.Integer(), body: t.Any() }, closed);

/** The common page body shared by public presentation reads and their extensions. */
export const PageResponseSchema = t.Object(
  {
    subject: t.Optional(t.String()),
    account: t.Optional(t.String()),
    profile: t.String(),
    template: t.Object(
      {
        scope: t.Union([t.Literal('route'), t.Literal('type'), t.Literal('base'), t.Literal('generic')]),
        key: t.Union([t.String(), t.Null()]),
      },
      closed,
    ),
    document: t.Any(),
    views: t.Optional(t.Array(t.String())),
    reads: t.Record(t.String(), readResult),
  },
  closed,
);

/** Builds a closed top-level extension of the common page response without mutating its schema. */
export function extendPageResponseSchema<Extension extends TProperties>(extension: Extension) {
  return t.Object({ ...PageResponseSchema.properties, ...extension }, closed);
}
