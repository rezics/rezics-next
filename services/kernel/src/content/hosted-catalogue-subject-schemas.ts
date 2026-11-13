import { t } from 'elysia';
import { HOSTED_PAGE_LIMIT } from './hosted-chapters-limits.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const nullableId = t.Union([id, t.Null()]);

export const HostedSubjectCatalogueQuerySchema = t.Object(
  {
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    limit: t.Optional(t.String({ pattern: '^(?:[1-9]|1[0-9]|20)$' })),
  },
  closed,
);

export const HostedSubjectCatalogueItemSchema = t.Object(
  {
    catalogueId: id,
    revisionId: id,
    kind: t.Literal('publication'),
    sourceRevisionId: nullableId,
    threadId: id,
  },
  closed,
);

export const HostedSubjectCataloguePageSchema = t.Object(
  {
    subjectId: id,
    items: t.Array(HostedSubjectCatalogueItemSchema, { maxItems: HOSTED_PAGE_LIMIT }),
    nextCursor: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
  },
  closed,
);
