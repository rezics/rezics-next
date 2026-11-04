import { t } from 'elysia';
import type { ViewerPersonalActionsPage } from '../library/viewer-personal-actions.ts';
import { viewerFactsResponseSchema } from '../library/viewer-facts.ts';

const closed = { additionalProperties: false } as const;
const native = viewerFactsResponseSchema.anyOf[0];
/** Add mounted actions to the native facts, retaining its exact absence and refusal states. */
export const FeedViewerPersonalActionsSchema = t.Unsafe<ViewerPersonalActionsPage>(t.Union([
  t.Object({
    ...native.properties,
    rows: t.Array(t.Object({
      ...native.properties.rows.items.properties,
      actions: t.Union([
        t.Object({ state: t.Literal('current'), allowed: t.Array(t.Object({
          action: t.String(), operations: t.Array(t.String()),
        }, closed)) }, closed),
        t.Object({ state: t.Literal('unavailable'), reason: t.Union([
          t.Literal('admission'), t.Literal('currentness'), t.Literal('dependency'),
        ]) }, closed),
      ]),
    }, closed), { maxItems: 100 }),
  }, closed),
  viewerFactsResponseSchema.anyOf[1],
]));
