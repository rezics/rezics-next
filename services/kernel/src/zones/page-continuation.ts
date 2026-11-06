import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import type { Static } from 'typebox';
import { LIST_CURSOR_BOUNDS } from '../tokens/list-cursor.ts';

const closed = { additionalProperties: false } as const;
function cursorSchema() {
  return memoizedValue(cursorSchema, () =>
    t.String({
      minLength: 1,
      maxLength: LIST_CURSOR_BOUNDS.search.maxTokenLength,
      pattern: '^[A-Za-z0-9_-]+$',
    }),
  );
}

/** Query parameters for a bounded Zone page read. The cursor is opaque to this transport schema. */
export function ZonePageQuerySchema() {
  return memoizedValue(ZonePageQuerySchema, () => t.Object({ cursor: t.Optional(cursorSchema()) }, closed));
}

/** A distinct 202 response indicating that a Zone page read can continue. */
export function ZonePageReadProgressSchema() {
  return memoizedValue(ZonePageReadProgressSchema, () => t.Object({ next: cursorSchema() }, closed));
}

function defaultCursorSchema() {
  return memoizedValue(defaultCursorSchema, () =>
    t.String({
      minLength: 1,
      maxLength: LIST_CURSOR_BOUNDS.default.maxTokenLength,
      pattern: '^[A-Za-z0-9_-]+$',
    }),
  );
}

/** Default-profile query for GET /v1/zones/:id/subjects. */
export function ZoneSubjectListQuerySchema() {
  return memoizedValue(ZoneSubjectListQuerySchema, () =>
    t.Object(
      {
        limit: t.Optional(t.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
        cursor: t.Optional(defaultCursorSchema()),
      },
      closed,
    ),
  );
}

export function ZoneSubjectListProgressSchema() {
  return memoizedValue(ZoneSubjectListProgressSchema, () => t.Object({ next: defaultCursorSchema() }, closed));
}

export type ZonePageQuery = Static<ReturnType<typeof ZonePageQuerySchema>>;
export type ZonePageReadProgress = Static<ReturnType<typeof ZonePageReadProgressSchema>>;
export type ZoneSubjectListQuery = Static<ReturnType<typeof ZoneSubjectListQuerySchema>>;
export type ZoneSubjectListProgress = Static<ReturnType<typeof ZoneSubjectListProgressSchema>>;
