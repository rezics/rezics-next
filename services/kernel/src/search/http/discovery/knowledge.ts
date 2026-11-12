import { t } from 'elysia';
import { memoizedValue } from '../../../memoized.ts';
import { LIST_CURSOR_BOUNDS } from '../../../tokens/list-cursor.ts';

const closed = { additionalProperties: false } as const;
export const KnowledgeDiscoveryId = t.String({
  format: 'uuid',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const continuation = t.String({ minLength: 1, maxLength: LIST_CURSOR_BOUNDS.search.maxTokenLength });

export function KnowledgeDiscoveryQuerySchema() {
  return memoizedValue(KnowledgeDiscoveryQuerySchema, () =>
    t.Object(
      {
        limit: t.Optional(t.IntegerString({ minimum: 1, maximum: 20 })),
        cursor: t.Optional(continuation),
      },
      closed,
    ),
  );
}
export function KnowledgeDiscoveryPageSchema() {
  return memoizedValue(KnowledgeDiscoveryPageSchema, () =>
    t.Object(
      {
        state: t.Literal('ready'),
        documents: t.Array(
          t.Object(
            {
              subjectId: KnowledgeDiscoveryId,
              documentId: KnowledgeDiscoveryId,
              publicationId: KnowledgeDiscoveryId,
              revisionId: KnowledgeDiscoveryId,
              publishedAt: t.String(),
              title: t.String({ minLength: 1, maxLength: 512 }),
              language: t.Union([t.String(), t.Null()]),
              licence: t.String(),
              sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
            },
            closed,
          ),
          { maxItems: 20 },
        ),
        next: t.Union([continuation, t.Null()]),
      },
      closed,
    ),
  );
}
export function KnowledgeDiscoveryPreparingSchema() {
  return memoizedValue(KnowledgeDiscoveryPreparingSchema, () =>
    t.Object(
      {
        state: t.Literal('preparing'),
        next: continuation,
      },
      closed,
    ),
  );
}
