import { t } from 'elysia';
const closed = { additionalProperties: false } as const;
export const QueryShareSchema = t.Object({
  action: t.Union([t.Literal('allowed'), t.Literal('disabled'), t.Literal('unavailable')]),
  reason: t.Union(['ready', 'private_context', 'unsupported', 'oversized', 'unavailable'].map((value) => t.Literal(value))),
  document: t.Union([t.Null(), t.Object({
    text: t.String({ maxLength: 512 }), filter: t.Union([t.String({ maxLength: 16384 }), t.Null()]),
    languages: t.Array(t.String({ maxLength: 35 }), { maxItems: 8 }), sort: t.Union([t.String(), t.Null()]),
  }, closed)]),
  parameters: t.Union([t.String({ maxLength: 8192 }), t.Null()]),
  selections: t.Array(t.Object({ value: t.String({ maxLength: 256 }), language: t.String({ maxLength: 35 }) }, closed), { maxItems: 128 }),
}, closed);
