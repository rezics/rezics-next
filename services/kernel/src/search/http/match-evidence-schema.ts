import { t } from 'elysia';

const closed = { additionalProperties: false } as const;
const span = t.Object({ start: t.Integer({ minimum: 0 }), end: t.Integer({ minimum: 1 }) }, closed);
const reason = t.Object(
  {
    field: t.Union([t.Literal('title'), t.Literal('alias'), t.Literal('description')]),
    language: t.String({ minLength: 2, maxLength: 35, pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$' }),
    text: t.String({ minLength: 1, maxLength: 256 }),
    spans: t.Array(span, { minItems: 1, maxItems: 8 }),
  },
  closed,
);
export const MatchEvidenceSchema = t.Union([
  t.Object({ state: t.Literal('absent') }, closed),
  t.Object({ state: t.Literal('unsupported') }, closed),
  t.Object({ state: t.Literal('unavailable') }, closed),
  t.Object(
    {
      state: t.Literal('current'),
      source: t.Object({ id: t.String({ format: 'uuid' }), revision: t.Integer({ minimum: 0 }) }, closed),
      query: t.String({ pattern: '^[0-9a-f]{64}$' }),
      reasons: t.Array(reason, { minItems: 1, maxItems: 3 }),
    },
    closed,
  ),
]);
