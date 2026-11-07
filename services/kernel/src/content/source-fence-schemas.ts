import { t } from 'elysia';

const closed = { additionalProperties: false } as const;
export const SourceFenceQuerySchema = t.Object(
  {
    source: t.String({ minLength: 1, maxLength: 32, pattern: '^[a-z][a-z0-9_-]{0,31}$' }),
    externalId: t.String({ minLength: 1, maxLength: 1024, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$' }),
    fieldGroup: t.Union([t.Literal('facts'), t.Literal('summary'), t.Literal('cover')]),
  },
  closed,
);
export const SourceFenceResponseSchema = t.Object(
  {
    fenced: t.Boolean(),
    securityRevision: t.Union([t.String({ pattern: '^[1-9][0-9]*$' }), t.Null()]),
  },
  closed,
);
