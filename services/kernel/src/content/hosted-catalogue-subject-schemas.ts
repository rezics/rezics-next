import { t } from 'elysia';
import { memoizedValue } from '../memoized.ts';
import { HOSTED_PAGE_LIMIT } from './hosted-chapters-limits.ts';
import { HostedIdSchema } from './hosted-chapters-schemas.ts';

const closed = { additionalProperties: false } as const;

function nullableIdSchema() {
  return memoizedValue(nullableIdSchema, () => t.Union([HostedIdSchema, t.Null()]));
}

function hostedSubjectCatalogueItemSchema() {
  return memoizedValue(hostedSubjectCatalogueItemSchema, () =>
    t.Object(
      {
        catalogueId: HostedIdSchema,
        revisionId: HostedIdSchema,
        kind: t.Literal('publication'),
        sourceRevisionId: nullableIdSchema(),
        threadId: HostedIdSchema,
        title: t.Optional(t.String({ maxLength: 512 })),
      },
      closed,
    ),
  );
}

export function hostedSubjectCatalogueQuerySchema() {
  return memoizedValue(hostedSubjectCatalogueQuerySchema, () =>
    t.Object(
      {
        cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
        limit: t.Optional(t.String({ pattern: '^(?:[1-9]|1[0-9]|20)$' })),
        includeTitle: t.Optional(t.Literal('1')),
      },
      closed,
    ),
  );
}

export function hostedSubjectCataloguePageSchema() {
  return memoizedValue(hostedSubjectCataloguePageSchema, () =>
    t.Object(
      {
        subjectId: HostedIdSchema,
        items: t.Array(hostedSubjectCatalogueItemSchema(), { maxItems: HOSTED_PAGE_LIMIT }),
        nextCursor: t.Union([t.String({ maxLength: 4096 }), t.Null()]),
      },
      closed,
    ),
  );
}
