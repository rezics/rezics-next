import { t } from 'elysia';
const closed = { additionalProperties: false } as const;
export const QueryShareSchema = t.Object(
  {
    viewer: t.Union([t.Literal('anonymous'), t.Literal('signed-in')]),
    action: t.Union([t.Literal('allowed'), t.Literal('disabled'), t.Literal('unavailable')]),
    reason: t.Union([
      t.Literal('ready'),
      t.Literal('private_context'),
      t.Literal('unsupported'),
      t.Literal('oversized'),
      t.Literal('unavailable'),
    ]),
    document: t.Union([
      t.Null(),
      t.Object(
        {
          text: t.String({ maxLength: 512 }),
          filter: t.Union([t.String({ maxLength: 16384 }), t.Null()]),
          languages: t.Array(t.String({ maxLength: 35 }), { maxItems: 8 }),
          sort: t.Union([t.String(), t.Null()]),
          textField: t.Optional(t.Literal('credited_creator')),
          creditQualifiers: t.Optional(
            t.Array(
              t.Object(
                {
                  property: t.String({ minLength: 1, maxLength: 256 }),
                  value: t.String({ minLength: 1, maxLength: 256 }),
                },
                closed,
              ),
              { maxItems: 4 },
            ),
          ),
          spoilerThreshold: t.Optional(t.Integer({ minimum: 0, maximum: 2 })),
        },
        closed,
      ),
    ]),
    parameters: t.Union([t.String({ maxLength: 8192 }), t.Null()]),
    selections: t.Array(
      t.Object({ value: t.String({ maxLength: 256 }), language: t.String({ maxLength: 35 }) }, closed),
      { maxItems: 128 },
    ),
  },
  closed,
);
