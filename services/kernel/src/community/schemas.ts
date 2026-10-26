import { t } from 'elysia';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });

export const ownRealmsQuerySchema = t.Object({ cursor: t.Optional(t.String({ maxLength: 4096 })) }, closed);

export const ownRealmsResponseSchema = t.Object(
  {
    items: t.Array(
      t.Object(
        {
          realmId: id,
          name: t.String({ minLength: 1, maxLength: 1024 }),
          role: t.Literal('member'),
        },
        closed,
      ),
    ),
    next: t.Union([t.String(), t.Null()]),
  },
  closed,
);
