import type { Static } from 'typebox';
import type { AccountDiscoverySummary } from '../search/index.ts';
import type { ViewerReactionKind } from './reads.ts';
import type { ReactionTarget } from './reactions.ts';
import type { FeedReviewContext } from './model.ts';
import type { FeedItem, FeedPage } from './contract/index.ts';
export declare const FeedSelectionIdSchema: import("typebox").TString;
export type FeedSelection = {
    spaceId?: string;
    ratingQuestionId?: string;
};
export declare const FeedKindSchema: import("typebox").TString;
/** Use the native kind.in literal grammar, including its UTF-8 byte and control-character bounds.
 * Exact IDs are preserved: no trimming, case folding or catalogue-type coercion. */
export declare function readFeedKind(kind: string | undefined): string | undefined;
export declare const FeedAuthorSchema: import("typebox").TUnsafe<Pick<AccountDiscoverySummary, "avatar" | "displayName" | "handle">>;
export type FeedAuthor = Static<typeof FeedAuthorSchema>;
export type FeedReactionTarget = Readonly<{
    targetKind: Extract<ReactionTarget['targetKind'], 'thread' | 'post'>;
    targetId: ReactionTarget['targetId'];
}>;
export type FeedReactionCounts = Partial<Record<ViewerReactionKind, number>>;
export type FeedReactionAdvice = Readonly<{
    target: FeedReactionTarget;
    state: 'current';
    allowed: readonly ViewerReactionKind[];
}> | Readonly<{
    target: FeedReactionTarget;
    state: 'sign_in' | 'unavailable';
}>;
/** Feed-local only: Semantic summaries and public Search caches carry no viewer slot. */
declare const subjectReactionKinds: readonly ['like', 'love', 'laugh', 'insightful', 'sad'];
export type FeedSubjectReactionKind = (typeof subjectReactionKinds)[number];
export declare const FeedSubjectReactionKindSchema: import("typebox").TUnsafe<"insightful" | "laugh" | "like" | "love" | "sad">;
export declare const FeedSubjectReactionsSchema: import("typebox").TObject<{
    target: import("typebox").TObject<{
        targetKind: import("typebox").TLiteral<"subject">;
        targetId: import("typebox").TString;
    }>;
    counts: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"available">;
        values: import("typebox").TObject<{
            like: import("typebox").TOptional<import("typebox").TInteger>;
            love: import("typebox").TOptional<import("typebox").TInteger>;
            laugh: import("typebox").TOptional<import("typebox").TInteger>;
            insightful: import("typebox").TOptional<import("typebox").TInteger>;
            sad: import("typebox").TOptional<import("typebox").TInteger>;
        }>;
        asOf: import("typebox").TUnion<[import("typebox").TUnsafe<Readonly<{
            epoch: number;
            position: string;
        }>>, import("typebox").TNull]>;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
    }>]>;
    viewer: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"available">;
        kind: import("typebox").TUnion<[import("typebox").TUnsafe<"insightful" | "laugh" | "like" | "love" | "sad">, import("typebox").TNull]>;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
    }>]>>;
    action: import("typebox").TUnion<[import("typebox").TLiteral<"sign_in">, import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">]>;
}>;
export type FeedSubjectReactions = Static<typeof FeedSubjectReactionsSchema>;
export type FeedContentSummary = {
    author?: FeedAuthor;
    excerpt?: string;
    reviewContext?: FeedReviewContext;
    conversationActivity?: FeedConversationActivity;
    reactionTarget?: FeedReactionTarget;
    reactions?: FeedReactionCounts;
    viewerReaction?: ViewerReactionKind | null;
    reactionAdvice?: FeedReactionAdvice;
};
export type FeedConversationActivity = Readonly<{
    state: 'current';
    cohort: 'public';
    count: ConversationActivityReplyCount;
    lastActivityAt: string | null;
}> | Readonly<{
    state: 'withheld';
}>;
type ConversationActivityReplyCount = Readonly<{
    kind: 'exact';
    value: number;
} | {
    kind: 'lower-bound';
    value: number;
}>;
export declare function FeedItemSchema(): import("typebox").TUnsafe<FeedItem>;
export declare const FeedSourceStateSchema: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"preparing">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"not_requested">]>;
export declare function FeedPageSchema(): import("typebox").TUnsafe<Readonly<{
    feedItems: readonly FeedItem[];
    viewerPersonalActions?: unknown;
    next: string | null;
    asOf: string;
    reactionsAsOf?: import("./contract/feed.ts").FeedReactionFreshness | null;
    sources: Readonly<{
        discovery: import("./contract/feed.ts").FeedSourceState;
        following: import("./contract/feed.ts").FeedSourceState;
        continue: import("./contract/feed.ts").FeedSourceState;
    }>;
}>>;
export type { FeedItem, FeedPage };
export type FeedSourceState = Static<typeof FeedSourceStateSchema>;
export type FeedItemWire = Static<ReturnType<typeof FeedItemSchema>>;
export type FeedPageWire = Static<ReturnType<typeof FeedPageSchema>>;
