import { t } from 'elysia';
import { HOSTED_PAGE_LIMIT } from './hosted-chapters-limits.ts';
import { HostedIdSchema } from './hosted-chapters-schemas.ts';

const closed = { additionalProperties: false } as const;
const nullableId = t.Union([HostedIdSchema, t.Null()]);

export const HostedSubjectCatalogueQuerySchema = t.Object(
  {
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    limit: t.Optional(t.String({ pattern: '^(?:[1-9]|1[0-9]|20)$' })),
  },
  closed,
);

export const HostedSubjectCatalogueItemSchema = t.Object(
  {
    catalogueId: HostedIdSchema,
    revisionId: HostedIdSchema,
    kind: t.Literal('publication'),
    sourceRevisionId: nullableId,
    threadId: HostedIdSchema,
  },
  closed,
);

export const HostedSubjectCataloguePageSchema = t.Object(
  {
    subjectId: HostedIdSchema,
    items: t.Array(HostedSubjectCatalogueItemSchema, { maxItems: HOSTED_PAGE_LIMIT }),
    nextCursor: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
  },
  closed,
);

export const HostedSubjectParamsSchema = t.Object({ subjectId: HostedIdSchema }, closed);
