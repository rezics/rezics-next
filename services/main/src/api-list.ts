import { t } from 'elysia';
import type { TSchema } from 'typebox';

/** A page bound limits one response, never the population of a collection. */
export const LIST_COST = { limit: 64, queryCharacters: 80, cursorCharacters: 2048 } as const;
export const listRequestFields = {
  q: t.Optional(
    t.String({ maxLength: LIST_COST.queryCharacters, pattern: '^[^\\u0000-\\u001f\\u007f]*$' }),
  ),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: LIST_COST.cursorCharacters })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: LIST_COST.limit })),
};
export const listRequest = t.Object(listRequestFields, { additionalProperties: false });
export interface ListRequest {
  q?: string;
  cursor?: string;
  limit?: number;
}
export function listResponse<Item extends TSchema>(item: Item) {
  return t.Object({
    items: t.Array(item, { maxItems: LIST_COST.limit }),
    nextCursor: t.Nullable(t.String()),
    complete: t.Boolean(),
    count: t.Object({
      value: t.Integer({ minimum: 0 }),
      kind: t.Union([t.Literal('exact'), t.Literal('at-least')]),
    }),
  });
}

export function listResult<Item>(items: Item[], nextCursor: string | null, previousCount = 0) {
  return {
    items,
    nextCursor,
    complete: nextCursor === null,
    count: {
      value: previousCount + items.length,
      kind: nextCursor === null ? ('exact' as const) : ('at-least' as const),
    },
  };
}
