import { t } from 'elysia';
import type { Static } from 'typebox';
import { LIST_CURSOR_BOUNDS } from '../tokens/list-cursor.ts';

const closed = { additionalProperties: false } as const;
const cursorSchema = t.String({
  minLength: 1,
  maxLength: LIST_CURSOR_BOUNDS.search.maxTokenLength,
  pattern: '^[A-Za-z0-9_-]+$',
});

/** Query parameters for a bounded Zone page read. The cursor is opaque to this transport schema. */
export const ZonePageQuerySchema = t.Object({ cursor: t.Optional(cursorSchema) }, closed);

/** A distinct 202 response indicating that a Zone page read can continue. */
export const ZonePageReadProgressSchema = t.Object({ next: cursorSchema }, closed);

export type ZonePageQuery = Static<typeof ZonePageQuerySchema>;
export type ZonePageReadProgress = Static<typeof ZonePageReadProgressSchema>;
