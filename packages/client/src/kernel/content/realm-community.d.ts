import { type ContentBoardDependencies } from './boards.ts';
import { type CommunityComments } from './community-projection/index.ts';
import type { BoardRecord, ReadContext } from './model.ts';
import type { ThreadView } from './reads.ts';
export type RealmCommunityThread = Readonly<{
    thread: ThreadView;
    target: Readonly<{
        kind: 'thread';
        id: string;
        boardId: string;
    }>;
    comments: CommunityComments;
}>;
export type RealmCommunityRecent = Readonly<{
    state: 'current';
    threads: readonly RealmCommunityThread[];
    complete: boolean;
}>;
export declare const RealmCommunityRecentSchema: import("typebox").TObject<{
    state: import("typebox").TLiteral<"current">;
    threads: import("typebox").TArray<import("typebox").TObject<{
        comments: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"current">;
            cohort: import("typebox").TUnion<[import("typebox").TLiteral<"public">, import("typebox").TLiteral<"viewer">]>;
            count: import("typebox").TObject<{
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"exact">, import("typebox").TLiteral<"lower-bound">]>;
                value: import("typebox").TInteger;
            }>;
            lastActivityAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            source: import("typebox").TObject<{
                epoch: import("typebox").TInteger;
                position: import("typebox").TString;
            }>;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
        }>]>;
        target: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"thread">;
            id: import("typebox").TString;
            boardId: import("typebox").TString;
        }>;
        thread: import("typebox").TUnsafe<Omit<Readonly<{
            id: import("./model.ts").ThreadId;
            route: import("./model.ts").Route;
            authorId: import("./model.ts").ContentId;
            kind: 'discussion' | 'review';
            title: string | null;
            licence: string;
            subjectIds: readonly import("./model.ts").ContentId[];
            boardId: import("./model.ts").BoardId;
            visibility: import("./model.ts").Visibility;
            securityRevision: import("./model.ts").SecurityRevision;
            availability: import("./model.ts").Availability;
            createdAt: string;
            firstPost: import("./model.ts").PostEntry;
        }>, "firstPost"> & Readonly<{
            firstPost: import("./reads.ts").PostEntry;
        }> & {
            readonly viewerReaction?: ("downvote" | "insightful" | "laugh" | "like" | "love" | "sad" | "upvote") | null;
        } & {
            readonly reactions?: {
                readonly downvote?: number;
                readonly insightful?: number;
                readonly laugh?: number;
                readonly like?: number;
                readonly love?: number;
                readonly sad?: number;
                readonly upvote?: number;
            };
        } & Readonly<{
            reviewContext?: import("./model.ts").FeedReviewContext;
        }>>;
    }>>;
    complete: import("typebox").TBoolean;
}>;
/** One activity batch for the entire admitted Board window: 20 × 3 keys fits
 * the producer's 100-key bound. Missing coverage stays unavailable, never zero.
 * The three-card projection carries reading destinations only, without actions,
 * author-account hydration, reactions or a complete Board opening per row.
 */
export declare function observeRealmCommunity(deps: ContentBoardDependencies, boards: readonly BoardRecord[], context: ReadContext): Promise<{
    recent: Map<string, Readonly<{
        state: 'current';
        threads: readonly RealmCommunityThread[];
        complete: boolean;
    }>>;
    current(): Promise<boolean>;
}>;
