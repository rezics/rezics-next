import { t } from 'elysia';
import type { TProperties } from 'typebox';

const closed = { additionalProperties: false } as const;
const readResult = t.Object(
  { status: t.Integer(), body: t.Any(), headers: t.Optional(t.Record(t.String(), t.String())) },
  closed,
);

/** The common page body shared by public presentation reads and their extensions. */
export const PageResponseSchema = t.Object(
  {
    subject: t.Optional(t.String()),
    account: t.Optional(t.String()),
    context: t.Optional(
      t.Object(
        {
          id: t.String(),
          population: t.Union([
            t.Object({ kind: t.Literal('global') }, closed),
            t.Object({ kind: t.Literal('realm'), id: t.String(), title: t.String() }, closed),
          ]),
        },
        closed,
      ),
    ),
    continuation: t.Optional(t.Object({ node: t.String(), cursor: t.String() }, closed)),
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
    viewer: t.Optional(
      t.Object(
        {
          kind: t.Union([t.Literal('anonymous'), t.Literal('account')]),
          account: t.Optional(t.String()),
        },
        closed,
      ),
    ),
    actions: t.Optional(
      t.Record(
        t.String(),
        t.Union([
          t.Literal('allowed'),
          t.Literal('denied'),
          t.Literal('unavailable'),
          t.Literal('unsupported'),
          t.Literal('withheld'),
        ]),
      ),
    ),
  },
  closed,
);

/** Builds a closed top-level extension of the common page response without mutating its schema. */
export function extendPageResponseSchema<Extension extends TProperties>(extension: Extension) {
  return t.Object({ ...PageResponseSchema.properties, ...extension }, closed);
}
