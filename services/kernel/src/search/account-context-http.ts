import { t } from 'elysia';
const closed = { additionalProperties: false } as const;
export const AccountContextSchema = t.Object({
  biography: t.Union([
    t.Object({ state: t.Literal('available'), text: t.String({ maxLength: 1024 }), truncated: t.Boolean() }, closed),
    ...(['absent', 'withheld', 'unavailable'] as const).map((state) => t.Object({ state: t.Literal(state) }, closed)),
  ]),
  followTarget: t.Union([
    t.Object({ state: t.Literal('unavailable') }, closed),
    t.Object({ state: t.Literal('available'), id: t.String({ format: 'uuid' }), label: t.String({ maxLength: 160 }),
      type: t.String({ maxLength: 256 }), source: t.String({ pattern: '^[0-9a-f]{64}$' }) }, closed),
  ]),
}, closed);
