import { t } from 'elysia';
import type { FeedConversationActivity } from './feed-contract.ts';

const closed = { additionalProperties: false } as const;

export const AuthorConversationActivitySchema = t.Unsafe<FeedConversationActivity>(t.Union([
  t.Object({
    state: t.Literal('current'),
    cohort: t.Literal('public'),
    count: t.Object({
      kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]),
      value: t.Integer({ minimum: 0, maximum: 10_000 }),
    }, closed),
    lastActivityAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
  }, closed),
  t.Object({ state: t.Literal('withheld') }, closed),
]));
