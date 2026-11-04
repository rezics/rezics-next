import { t } from 'elysia';
import type { Static } from 'typebox';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const revision = t.Union([id, t.Null()]);
const status = t.Union([t.Literal('current'), t.Literal('unavailable')]);
const reply = t.Object({ state: t.Union([
  t.Literal('available'), t.Literal('sign_in_required'), t.Literal('denied'),
  t.Literal('withheld'), t.Literal('unavailable'),
]) }, closed);
const reference = t.Union([
  t.Object({ type: t.Literal('content.thread'), id, placeId: id, sourceRevisionId: revision }, closed),
  t.Object({ type: t.Literal('content.post'), id, threadId: id, placeId: id,
    threadRevisionId: revision, sourceRevisionId: revision }, closed),
]);
export const AuthorContributionSelectionSchema = t.Object({
  proof: t.String({ minLength: 1, maxLength: 4096 }),
  references: t.Array(reference, { minItems: 1, maxItems: 20 }),
}, closed);
export const AuthorContributionActionsInputSchema = t.Object({
  ...AuthorContributionSelectionSchema.properties,
  view: t.Union([t.Literal('posts'), t.Literal('reviews'), t.Literal('discussion')]),
  cursor: t.Union([t.String({ minLength: 1, maxLength: 4096 }), t.Null()]),
}, closed);
export type AuthorContributionActionsInput = Static<typeof AuthorContributionActionsInputSchema>;
export type AuthorContributionSelection = Static<typeof AuthorContributionSelectionSchema>;

const watchState = t.Union([status, t.Literal('sign_in_required')]);
const counts = t.Object({
  upvote: t.Optional(t.Integer({ minimum: 0 })), downvote: t.Optional(t.Integer({ minimum: 0 })),
  like: t.Optional(t.Integer({ minimum: 0 })), love: t.Optional(t.Integer({ minimum: 0 })),
  laugh: t.Optional(t.Integer({ minimum: 0 })), insightful: t.Optional(t.Integer({ minimum: 0 })),
  sad: t.Optional(t.Integer({ minimum: 0 })),
}, closed);
export const AuthorContributionActionsResponseSchema = t.Object({
  viewer: t.Union([
    t.Object({ kind: t.Literal('anonymous') }, closed),
    t.Object({ kind: t.Literal('account'), id }, closed),
  ]),
  selected: t.Array(t.Object({ reference,
    state: t.Union([t.Literal('current'), t.Literal('erased'), t.Literal('withheld')]), reply,
  }, closed), { maxItems: 20 }),
  reactions: t.Object({ state: status, retryable: t.Boolean(),
    items: t.Array(t.Object({
      type: t.Union([t.Literal('content.thread'), t.Literal('content.post')]), id,
      state: t.Union([status, t.Literal('not_applicable')]),
      counts: t.Optional(counts), viewerSelection: t.Optional(t.Union([t.String({ maxLength: 32 }), t.Null()])),
    }, closed), { maxItems: 60 }),
    reactionsAsOf: t.Union([t.Object({ epoch: t.Integer({ minimum: 1 }),
      position: t.String({ pattern: '^[0-9]+$' }) }, closed), t.Null()]),
  }, closed),
  actions: t.Object({ state: status, retryable: t.Boolean(),
    references: t.Array(t.Object({
      type: t.Union([t.Literal('content.thread'), t.Literal('content.post')]), id,
      sourceRevisionId: t.Optional(id), state: t.Union([t.Literal('current'), t.Literal('withheld')]),
      operations: t.Array(t.Object({ action: t.String(), operationId: t.String(),
        state: t.Union([t.Literal('available'), t.Literal('sign_in_required'), t.Literal('denied'),
          t.Literal('withheld'), t.Literal('unavailable'), t.Literal('not_applicable')]),
      }, closed), { maxItems: 256 }),
    }, closed), { maxItems: 60 }),
  }, closed),
  watch: t.Object({ state: watchState, retryable: t.Boolean(),
    items: t.Array(t.Object({ threadId: id, state: watchState, watching: t.Optional(t.Boolean()) }, closed),
      { maxItems: 20 }),
  }, closed),
  currentness: t.Object({ source: t.Literal('current'), place: t.Literal('current'),
    reactions: status, authors: status, actions: status, watch: watchState,
  }, closed),
}, closed);
