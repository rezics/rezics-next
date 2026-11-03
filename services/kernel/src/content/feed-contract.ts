import { t } from 'elysia';
import type { Static } from 'typebox';
import { FilterError, parseDiscoveryFilter } from '@rezics/filter';
import { ProblemError } from '../http/problem.ts';
import { SubjectSummarySchema } from '../semantic/http/summaries.ts';
import type { ThreadView } from './reads.ts';
import type { ItemView } from './model.ts';
import type { AccountDiscoverySummary } from '../search/discovery.ts';
import type { CollectionResourceView } from '../library/collection-reads.ts';
import { continuePageSchema } from '../library/continue-routes.ts';
import { REACTION_KINDS } from './events.ts';
import type { ReactionCountFreshness, ViewerReactionKind } from './reads.ts';
import type { ReactionTarget } from './reactions.ts';

const closed = { additionalProperties: false } as const;
const nullable = t.Union([t.String(), t.Null()]);
const uuid = t.String({ format: 'uuid' });
export const FeedSelectionIdSchema = t.String({ format: 'uuid' });
export type FeedSelection = { spaceId?: string; ratingQuestionId?: string };

export const FeedKindSchema = t.String({ minLength: 1, maxLength: 256 });

/** Use the native kind.in literal grammar, including its UTF-8 byte and control-character bounds.
 * Exact IDs are preserved: no trimming, case folding or catalogue-type coercion. */
export function readFeedKind(kind: string | undefined): string | undefined {
  if (kind === undefined) return undefined;
  try {
    parseDiscoveryFilter({ kind: { in: [kind] } });
    return kind;
  } catch (error) {
    if (error instanceof FilterError)
      throw new ProblemError(error.problem, {
        errors: error.errors.map(({ code }) => ({ pointer: '/kind', code })),
      });
    throw error;
  }
}
const avatar = t.Object(
  {
    media: uuid,
    width: t.Integer({ minimum: 1 }),
    height: t.Integer({ minimum: 1 }),
    placeholder: t.Object({ thumbhash: t.String(), color: t.String() }, closed),
    variants: t.Array(
      t.Object({ format: t.Union([t.Literal('avif'), t.Literal('webp')]), width: t.Integer() }, closed),
    ),
    focalPoint: t.Union([t.Object({ x: t.Number(), y: t.Number() }, closed), t.Null()]),
    credit: t.Null(),
  },
  closed,
);
// The Accounts native discovery type owns these fields; no public profile fetch is performed by the feed.
const accountSummary = t.Unsafe<AccountDiscoverySummary>(
  t.Object(
    {
      id: uuid,
      accountKind: t.Union([t.Literal('actor'), t.Literal('organization')]),
      handle: nullable,
      displayName: nullable,
      automated: t.Boolean(),
      operatorId: t.Union([uuid, t.Null()]),
      avatar: t.Union([avatar, t.Null()]),
      verifiedAgent: t.Union([t.Object({ id: uuid, label: t.String(), type: t.String() }, closed), t.Null()]),
    },
    closed,
  ),
);
export const FeedAuthorSchema = t.Unsafe<Pick<AccountDiscoverySummary, 'displayName' | 'handle' | 'avatar'>>(
  t.Object({ displayName: nullable, handle: nullable, avatar: t.Union([avatar, t.Null()]) }, closed),
);
export type FeedAuthor = Static<typeof FeedAuthorSchema>;
export type FeedReactionTarget = Readonly<{
  targetKind: Extract<ReactionTarget['targetKind'], 'thread' | 'post'>;
  targetId: ReactionTarget['targetId'];
}>;
export type FeedReactionCounts = Partial<Record<ViewerReactionKind, number>>;
const reactionKind = t.Union(REACTION_KINDS.map((kind) => t.Literal(kind)));
const reactionTarget = t.Unsafe<FeedReactionTarget>(
  t.Object({ targetKind: t.Union([t.Literal('thread'), t.Literal('post')]), targetId: uuid }, closed),
);
const reactionCounts = t.Unsafe<FeedReactionCounts>(
  t.Object(
    {
      upvote: t.Optional(t.Integer({ minimum: 1 })),
      downvote: t.Optional(t.Integer({ minimum: 1 })),
      like: t.Optional(t.Integer({ minimum: 1 })),
      love: t.Optional(t.Integer({ minimum: 1 })),
      laugh: t.Optional(t.Integer({ minimum: 1 })),
      insightful: t.Optional(t.Integer({ minimum: 1 })),
      sad: t.Optional(t.Integer({ minimum: 1 })),
    },
    closed,
  ),
);
const reactionFreshness = t.Unsafe<ReactionCountFreshness>(
  t.Object(
    {
      epoch: t.Integer({ minimum: 1 }),
      position: t.String({ pattern: '^[1-9][0-9]*$' }),
    },
    closed,
  ),
);
export type FeedContentSummary = {
  author?: FeedAuthor;
  excerpt?: string;
  reactionTarget?: FeedReactionTarget;
  reactions?: FeedReactionCounts;
  viewerReaction?: ViewerReactionKind | null;
};
const contentSummaryFields = {
  author: t.Optional(FeedAuthorSchema),
  excerpt: t.Optional(t.String({ maxLength: 160 })),
  reactionTarget: t.Optional(reactionTarget),
  reactions: t.Optional(reactionCounts),
  viewerReaction: t.Optional(t.Union([reactionKind, t.Null()])),
};
const threadSummary = t.Unsafe<Pick<ThreadView, 'id' | 'kind' | 'title' | 'createdAt'> & FeedContentSummary>(
  t.Object(
    {
      ...contentSummaryFields,
      id: uuid,
      kind: t.Union([t.Literal('discussion'), t.Literal('review')]),
      title: nullable,
      createdAt: t.String(),
    },
    closed,
  ),
);
const postSummary = t.Unsafe<
  Pick<ItemView, 'id' | 'threadId' | 'createdAt'> & Pick<ThreadView, 'title'> & FeedContentSummary
>(
  t.Object(
    {
      ...contentSummaryFields,
      id: uuid,
      threadId: uuid,
      createdAt: t.String(),
      title: nullable,
    },
    closed,
  ),
);
const collectionSummary = t.Unsafe<Pick<CollectionResourceView, 'id' | 'title' | 'description'>>(
  t.Object({ id: uuid, title: t.String(), description: nullable }, closed),
);
const key = <Owner extends string, Kind extends string>(owner: Owner, kind: Kind) =>
  t.Object(
    {
      owner: t.Literal(owner),
      kind: t.Literal(kind),
      route: t.Integer({ minimum: 0, maximum: 65535 }),
      id: uuid,
    },
    closed,
  );
const destination = <Kind extends 'subject' | 'account' | 'thread' | 'collection'>(kind: Kind) =>
  t.Object(
    {
      kind: t.Literal(kind),
      id: uuid,
      title: nullable,
    },
    closed,
  );
const postDestination = t.Object(
  { kind: t.Literal('post'), id: uuid, title: nullable, threadId: uuid, postId: uuid },
  closed,
);
const common = { id: t.String({ minLength: 1, maxLength: 512 }), occurredAt: nullable };
const semanticKey = t.Object(
  {
    owner: t.Literal('semantic'),
    kind: t.String({ minLength: 1 }),
    route: t.Integer({ minimum: 0, maximum: 65535 }),
    id: uuid,
  },
  closed,
);
export const FeedItemSchema = t.Union([
  t.Object(
    {
      ...common,
      source: t.Literal('discovery'),
      key: semanticKey,
      summary: SubjectSummarySchema,
      destination: destination('subject'),
    },
    closed,
  ),
  t.Object(
    {
      ...common,
      source: t.Literal('discovery'),
      key: key('accounts', 'account'),
      summary: accountSummary,
      destination: destination('account'),
    },
    closed,
  ),
  t.Object(
    {
      ...common,
      source: t.Literal('continue'),
      key: semanticKey,
      summary: SubjectSummarySchema,
      destination: destination('subject'),
      continue: continuePageSchema.properties.subjects.items,
    },
    closed,
  ),
  t.Object(
    {
      ...common,
      source: t.Literal('following'),
      key: semanticKey,
      summary: SubjectSummarySchema,
      destination: destination('subject'),
    },
    closed,
  ),
  t.Object(
    {
      ...common,
      source: t.Literal('following'),
      key: key('content', 'thread'),
      summary: threadSummary,
      destination: destination('thread'),
    },
    closed,
  ),
  t.Object(
    {
      ...common,
      source: t.Literal('following'),
      key: key('content', 'post'),
      summary: postSummary,
      destination: postDestination,
    },
    closed,
  ),
  t.Object(
    {
      ...common,
      source: t.Literal('following'),
      key: key('library', 'collection'),
      summary: collectionSummary,
      destination: destination('collection'),
    },
    closed,
  ),
]);
export const FeedSourceStateSchema = t.Union([
  t.Literal('ready'),
  t.Literal('preparing'),
  t.Literal('unavailable'),
  t.Literal('not_requested'),
]);
export const FeedPageSchema = t.Object(
  {
    feedItems: t.Array(FeedItemSchema, { maxItems: 20 }),
    next: nullable,
    asOf: t.String({ format: 'date-time' }),
    reactionsAsOf: t.Optional(t.Union([reactionFreshness, t.Null()])),
    sources: t.Object(
      { discovery: FeedSourceStateSchema, following: FeedSourceStateSchema, continue: FeedSourceStateSchema },
      closed,
    ),
  },
  closed,
);
export type FeedItem = Static<typeof FeedItemSchema>;
export type FeedPage = Static<typeof FeedPageSchema>;
export type FeedSourceState = Static<typeof FeedSourceStateSchema>;
