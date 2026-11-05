import { type DocumentSnapshot } from '@rezics/document';
import type { Static, TSchema } from 'typebox';
export { CommunityPresentationSchema } from './community-presentation-model.ts';
import { REACTION_KINDS } from './events.ts';
import type { AuthorPostEntry, AuthorThreadEntry } from './author-item-reads.ts';
import type { FeedReviewContext } from './model.ts';
import type { ItemView, PostEntry } from './reads.ts';
import type { ReportReadView } from './reports.ts';
import type { Operation } from './operation-contract.ts';
import type { OwnDraftEntry } from './own-drafts.ts';
import type { SubjectThreadCardEntry } from './subject-threads-cards.ts';
import type { SubjectThreadEntry } from './subject-entry.ts';
type ViewerReactionKind = (typeof REACTION_KINDS)[number];
type ViewerReactionSlot = {
    readonly viewerReaction?: ViewerReactionKind | null;
};
type ReactionCountMap = {
    readonly [kind in ViewerReactionKind]?: number;
};
type ReactionCountsSlot = {
    readonly reactions?: ReactionCountMap;
};
/** Validate the published TypeBox shape without Elysia removing unknown input or response fields. */
export declare function strictContentSchema<S extends TSchema>(schema: S, check?: (value: unknown) => readonly {
    pointer: string;
    code: string;
}[]): {
    '~standard': {
        version: 1;
        vendor: string;
        types: {
            input: Static<S>;
            output: Static<S>;
        } | undefined;
        validate(value: unknown): {
            value: Static<S>;
            issues?: never;
        } | {
            value?: never;
            issues: {
                message: string;
            }[];
        };
        jsonSchema: {
            input: () => S;
            output: () => S;
        };
    };
};
export declare const SourceFenceQuerySchema: import("typebox").TObject<{
    source: import("typebox").TString;
    externalId: import("typebox").TString;
    fieldGroup: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
}>;
export declare const SourceFenceResponseSchema: import("typebox").TObject<{
    fenced: import("typebox").TBoolean;
    securityRevision: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare const ContentIdSchema: import("typebox").TString;
export declare const WatchManagementKindSchema: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"board">]>;
export declare const WatchManagementAdviceSchema: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"denied">]>;
export declare const WatchManagementViewerSchema: import("typebox").TObject<{
    state: import("typebox").TLiteral<"current">;
    accountId: import("typebox").TString;
}>;
export declare const WatchManagementActionsSchema: import("typebox").TObject<{
    remove: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"denied">]>;
}>;
export declare const WatchManagementCommandSchema: import("typebox").TObject<{
    watchId: import("typebox").TString;
    kind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"board">]>;
    expectedRevision: import("typebox").TInteger;
}>;
export declare const WatchManagementItemSchema: import("typebox").TUnion<[import("typebox").TObject<{
    id: import("typebox").TString;
    kind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"board">]>;
    revision: import("typebox").TInteger;
    createdAt: import("typebox").TString;
    state: import("typebox").TLiteral<"available">;
    resourceId: import("typebox").TString;
    title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    command: import("typebox").TObject<{
        watchId: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"board">]>;
        expectedRevision: import("typebox").TInteger;
    }>;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    kind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"board">]>;
    revision: import("typebox").TInteger;
    createdAt: import("typebox").TString;
    state: import("typebox").TLiteral<"unavailable">;
    command: import("typebox").TObject<{
        watchId: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"board">]>;
        expectedRevision: import("typebox").TInteger;
    }>;
}>]>;
export declare const WatchManagementPageSchema: import("typebox").TObject<{
    viewer: import("typebox").TObject<{
        state: import("typebox").TLiteral<"current">;
        accountId: import("typebox").TString;
    }>;
    actions: import("typebox").TObject<{
        remove: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"denied">]>;
    }>;
    items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"board">]>;
        revision: import("typebox").TInteger;
        createdAt: import("typebox").TString;
        state: import("typebox").TLiteral<"available">;
        resourceId: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        command: import("typebox").TObject<{
            watchId: import("typebox").TString;
            kind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"board">]>;
            expectedRevision: import("typebox").TInteger;
        }>;
    }>, import("typebox").TObject<{
        id: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"board">]>;
        revision: import("typebox").TInteger;
        createdAt: import("typebox").TString;
        state: import("typebox").TLiteral<"unavailable">;
        command: import("typebox").TObject<{
            watchId: import("typebox").TString;
            kind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"board">]>;
            expectedRevision: import("typebox").TInteger;
        }>;
    }>]>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export type WatchManagementKind = Static<typeof WatchManagementKindSchema>;
export type WatchManagementAdvice = Static<typeof WatchManagementAdviceSchema>;
export type WatchManagementViewer = Static<typeof WatchManagementViewerSchema>;
export type WatchManagementActions = Static<typeof WatchManagementActionsSchema>;
export type WatchManagementCommand = Static<typeof WatchManagementCommandSchema>;
export type WatchManagementItem = Static<typeof WatchManagementItemSchema>;
export type WatchManagementPage = Static<typeof WatchManagementPageSchema>;
export declare const ReportInputSchema: import("typebox").TObject<{
    target: import("typebox").TObject<{
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"board">, import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"post">, import("typebox").TLiteral<"subject">, import("typebox").TLiteral<"space">, import("typebox").TLiteral<"realm">]>;
        id: import("typebox").TString;
    }>;
    revisionId: import("typebox").TOptional<import("typebox").TString>;
    botToken: import("typebox").TOptional<import("typebox").TString>;
    reason: import("typebox").TUnion<[import("typebox").TLiteral<"off_topic">, import("typebox").TLiteral<"inappropriate">, import("typebox").TLiteral<"spam">, import("typebox").TLiteral<"illegal">, import("typebox").TLiteral<"other">]>;
    evidence: import("typebox").TOptional<import("typebox").TString>;
}>;
export declare const ReportReceiptSchema: import("typebox").TObject<{
    reportId: import("typebox").TString;
}>;
export declare const ReportResponseSchema: import("typebox").TObject<{
    report: import("typebox").TUnsafe<ReportReadView>;
    inspection: import("typebox").TOptional<import("typebox").TUnsafe<Readonly<{
        reportedRevision: import("./reports.ts").ReportTargetInspection;
        currentTarget: import("./reports.ts").ReportTargetInspection;
        viewer: Readonly<{
            canDismiss: boolean;
            canTakeDown: boolean;
        }>;
    }>>>;
}>;
/** The erased variant cannot carry authored bytes, even to an authorized reader. */
export declare const ItemViewSchema: import("typebox").TUnsafe<ItemView & ViewerReactionSlot & ReactionCountsSlot>;
export declare const ErasedPlaceholderSchema: import("typebox").TObject<{
    id: import("typebox").TString;
    threadId: import("typebox").TString;
    route: import("typebox").TInteger;
    parentId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    removed: import("typebox").TLiteral<true>;
    availability: import("typebox").TLiteral<"erased">;
    restorableUntil: import("typebox").TOptional<import("typebox").TString>;
    body: import("typebox").TNull;
    sha256: import("typebox").TNull;
}>;
export declare const PostEntrySchema: import("typebox").TUnsafe<PostEntry & ViewerReactionSlot & ReactionCountsSlot>;
export declare const ThreadViewSchema: import("typebox").TUnsafe<Omit<Readonly<{
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
    firstPost: PostEntry;
}> & ViewerReactionSlot & ReactionCountsSlot & Readonly<{
    reviewContext?: FeedReviewContext;
}>>;
export declare const BoardRecordSchema: import("typebox").TObject<{
    id: import("typebox").TString;
    route: import("typebox").TInteger;
    visibility: import("typebox").TUnion<[import("typebox").TLiteral<"published">, import("typebox").TLiteral<"draft">, import("typebox").TLiteral<"protected">, import("typebox").TLiteral<"taken_down">]>;
    securityRevision: import("typebox").TString;
    createdAt: import("typebox").TString;
    realmId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    purpose: import("typebox").TUnion<[import("typebox").TLiteral<"discussion">, import("typebox").TLiteral<"reviews">]>;
    availability: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"erased">]>;
}>;
export declare const BoardViewSchema: import("typebox").TUnsafe<Readonly<{
    id: import("./model.ts").BoardId;
    realmId: string | null;
    community: import("./community-presentation-model.ts").CommunityPresentation | null;
    route: import("./model.ts").Route;
    title: string | null;
    purpose: 'discussion' | 'reviews';
    visibility: import("./model.ts").Visibility;
    securityRevision: import("./model.ts").SecurityRevision;
    availability: import("./model.ts").Availability;
    createdAt: string;
}>>;
export declare const ThreadInputSchema: import("typebox").TObject<{
    licence: import("typebox").TString;
    subjectIds: import("typebox").TArray<import("typebox").TString>;
    boardId: import("typebox").TString;
    kind: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"discussion">, import("typebox").TLiteral<"review">]>>;
    title: import("typebox").TString;
    body: import("typebox").TUnsafe<DocumentSnapshot>;
    visibility: import("typebox").TUnion<[import("typebox").TLiteral<"published">, import("typebox").TLiteral<"draft">, import("typebox").TLiteral<"protected">]>;
    mediaIds: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    voteCitation: import("typebox").TOptional<import("typebox").TObject<{
        questionId: import("typebox").TString;
        units: import("typebox").TInteger;
        revision: import("typebox").TInteger;
    }>>;
}>;
export declare const PostInputSchema: import("typebox").TObject<{
    visibility: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"published">, import("typebox").TLiteral<"draft">, import("typebox").TLiteral<"protected">]>>;
    body: import("typebox").TUnsafe<DocumentSnapshot>;
    licence: import("typebox").TString;
    parentId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
    subjectIds: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    boardId: import("typebox").TOptional<import("typebox").TString>;
    mediaIds: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
}>;
export declare const RevisionInputSchema: import("typebox").TObject<{
    title: import("typebox").TOptional<import("typebox").TString>;
    visibility: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"published">, import("typebox").TLiteral<"draft">]>>;
    body: import("typebox").TUnsafe<DocumentSnapshot>;
    licence: import("typebox").TOptional<import("typebox").TString>;
    subjectIds: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    boardId: import("typebox").TOptional<import("typebox").TString>;
    mediaIds: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    voteCitation: import("typebox").TOptional<import("typebox").TObject<{
        questionId: import("typebox").TString;
        units: import("typebox").TInteger;
        revision: import("typebox").TInteger;
    }>>;
}>;
export declare const ContentPageQuerySchema: import("typebox").TObject<{
    cursor: import("typebox").TOptional<import("typebox").TString>;
    limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
}>;
export declare const ReactionInputSchema: import("typebox").TObject<{
    kind: import("typebox").TUnsafe<"downvote" | "insightful" | "laugh" | "like" | "love" | "sad" | "upvote">;
}>;
export declare const ReactionResponseSchema: import("typebox").TObject<{
    kind: import("typebox").TUnsafe<"downvote" | "insightful" | "laugh" | "like" | "love" | "sad" | "upvote">;
}>;
export declare const SubjectReactionInputSchema: import("typebox").TObject<{
    kind: import("typebox").TUnsafe<"insightful" | "laugh" | "like" | "love" | "sad">;
}>;
export declare const SubjectReactionResponseSchema: import("typebox").TObject<{
    kind: import("typebox").TUnsafe<"insightful" | "laugh" | "like" | "love" | "sad">;
}>;
export declare const SubjectOwnReactionResponseSchema: import("typebox").TObject<{
    kind: import("typebox").TUnion<[import("typebox").TUnsafe<"insightful" | "laugh" | "like" | "love" | "sad">, import("typebox").TNull]>;
}>;
export declare const SubjectReactionRedirectResponseSchema: import("typebox").TObject<{
    redirect: import("typebox").TObject<{
        from: import("typebox").TString;
        to: import("typebox").TString;
    }>;
}>;
export declare const ThreadResponseSchema: import("typebox").TObject<{
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
        firstPost: PostEntry;
    }> & ViewerReactionSlot & ReactionCountsSlot & Readonly<{
        reviewContext?: FeedReviewContext;
    }>>;
    reactionsAsOf: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
        epoch: import("typebox").TInteger;
        position: import("typebox").TString;
    }>, import("typebox").TNull]>>;
    authorErasure: import("typebox").TOptional<import("typebox").TObject<{
        authorId: import("typebox").TString;
        mayErase: import("typebox").TBoolean;
    }>>;
}>;
export declare const PostResponseSchema: import("typebox").TObject<{
    post: import("typebox").TUnsafe<PostEntry & ViewerReactionSlot & ReactionCountsSlot>;
}>;
export declare const BoardResponseSchema: import("typebox").TObject<{
    board: import("typebox").TUnsafe<Readonly<{
        id: import("./model.ts").BoardId;
        realmId: string | null;
        community: import("./community-presentation-model.ts").CommunityPresentation | null;
        route: import("./model.ts").Route;
        title: string | null;
        purpose: 'discussion' | 'reviews';
        visibility: import("./model.ts").Visibility;
        securityRevision: import("./model.ts").SecurityRevision;
        availability: import("./model.ts").Availability;
        createdAt: string;
    }>>;
}>;
export declare const ReviewDestinationPageSchema: import("typebox").TObject<{
    state: import("typebox").TUnion<[import("typebox").TLiteral<"choices">, import("typebox").TLiteral<"sparse">, import("typebox").TLiteral<"no-destinations">, import("typebox").TLiteral<"exhausted">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"expired">]>;
    viewer: import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"denied">]>;
    }>;
    context: import("typebox").TUnion<[import("typebox").TObject<{
        subject: import("typebox").TObject<{
            id: import("typebox").TString;
            label: import("typebox").TUnion<[import("typebox").TObject<{
                value: import("typebox").TString;
                language: import("typebox").TString;
            }>, import("typebox").TNull]>;
            source: import("typebox").TObject<{
                partition: import("typebox").TInteger;
                epoch: import("typebox").TInteger;
                position: import("typebox").TString;
            }>;
        }>;
        realm: import("typebox").TObject<{
            id: import("typebox").TString;
            title: import("typebox").TString;
            spaceId: import("typebox").TString;
            headRevisionId: import("typebox").TString;
        }>;
    }>, import("typebox").TNull]>;
    items: import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        purpose: import("typebox").TLiteral<"reviews">;
        actions: import("typebox").TObject<{
            createReview: import("typebox").TLiteral<"allowed">;
        }>;
        native: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"review">;
            boardId: import("typebox").TString;
            subjectIds: import("typebox").TTuple<[import("typebox").TString]>;
            subjectSource: import("typebox").TObject<{
                partition: import("typebox").TInteger;
                epoch: import("typebox").TInteger;
                position: import("typebox").TString;
            }>;
            realmHeadRevisionId: import("typebox").TString;
            boardSecurityRevision: import("typebox").TString;
        }>;
    }>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare const GlobalBoardDirectoryQuerySchema: import("typebox").TObject<{
    purpose: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"discussion">, import("typebox").TLiteral<"reviews">]>>;
    cursor: import("typebox").TOptional<import("typebox").TString>;
    limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
}>;
export declare const GlobalBoardDirectoryResponseSchema: import("typebox").TObject<{
    boards: import("typebox").TArray<import("typebox").TUnsafe<Readonly<{
        id: import("./model.ts").BoardId;
        realmId: string | null;
        community: import("./community-presentation-model.ts").CommunityPresentation | null;
        route: import("./model.ts").Route;
        title: string | null;
        purpose: 'discussion' | 'reviews';
        visibility: import("./model.ts").Visibility;
        securityRevision: import("./model.ts").SecurityRevision;
        availability: import("./model.ts").Availability;
        createdAt: string;
    }>>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare const PostPageResponseSchema: import("typebox").TObject<{
    posts: import("typebox").TArray<import("typebox").TUnsafe<PostEntry & ViewerReactionSlot & ReactionCountsSlot>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    reactionsAsOf: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
        epoch: import("typebox").TInteger;
        position: import("typebox").TString;
    }>, import("typebox").TNull]>>;
}>;
export declare const AvatarSummarySchema: import("typebox").TUnion<[import("typebox").TObject<{
    media: import("typebox").TString;
    width: import("typebox").TInteger;
    height: import("typebox").TInteger;
    placeholder: import("typebox").TObject<{
        thumbhash: import("typebox").TString;
        color: import("typebox").TString;
    }>;
    variants: import("typebox").TArray<import("typebox").TObject<{
        format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
        width: import("typebox").TInteger;
    }>>;
    focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
        x: import("typebox").TNumber;
        y: import("typebox").TNumber;
    }>, import("typebox").TNull]>;
    credit: import("typebox").TNull;
}>, import("typebox").TNull]>;
export declare const HistoryPageContextSchema: import("typebox").TObject<{
    viewer: import("typebox").TUnion<[import("typebox").TObject<{
        kind: import("typebox").TLiteral<"account">;
        id: import("typebox").TString;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"anonymous">;
    }>]>;
    conversation: import("typebox").TObject<{
        id: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"discussion">, import("typebox").TLiteral<"review">]>;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        authorId: import("typebox").TString;
        boardId: import("typebox").TString;
        subjectIds: import("typebox").TArray<import("typebox").TString>;
        createdAt: import("typebox").TString;
    }>;
    board: import("typebox").TUnsafe<Readonly<{
        id: import("./model.ts").BoardId;
        realmId: string | null;
        community: import("./community-presentation-model.ts").CommunityPresentation | null;
        route: import("./model.ts").Route;
        title: string | null;
        purpose: 'discussion' | 'reviews';
        visibility: import("./model.ts").Visibility;
        securityRevision: import("./model.ts").SecurityRevision;
        availability: import("./model.ts").Availability;
        createdAt: string;
    }>>;
    place: import("typebox").TUnion<[import("typebox").TObject<{
        kind: import("typebox").TLiteral<"global">;
        id: import("typebox").TString;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"realm">;
        id: import("typebox").TString;
    }>]>;
    head: import("typebox").TObject<{
        postId: import("typebox").TString;
        revisionId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"erased">]>;
        authorId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        createdAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        revisedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
    authors: import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        retryable: import("typebox").TBoolean;
        items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
            id: import("typebox").TString;
            state: import("typebox").TLiteral<"available">;
            displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            avatar: import("typebox").TUnion<[import("typebox").TObject<{
                media: import("typebox").TString;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
                placeholder: import("typebox").TObject<{
                    thumbhash: import("typebox").TString;
                    color: import("typebox").TString;
                }>;
                variants: import("typebox").TArray<import("typebox").TObject<{
                    format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                    width: import("typebox").TInteger;
                }>>;
                focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                    x: import("typebox").TNumber;
                    y: import("typebox").TNumber;
                }>, import("typebox").TNull]>;
                credit: import("typebox").TNull;
            }>, import("typebox").TNull]>;
        }>, import("typebox").TObject<{
            id: import("typebox").TString;
            state: import("typebox").TLiteral<"concealed">;
        }>]>>;
    }>;
    mentions: import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        retryable: import("typebox").TBoolean;
        items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
            id: import("typebox").TString;
            state: import("typebox").TLiteral<"available">;
            handle: import("typebox").TString;
        }>, import("typebox").TObject<{
            id: import("typebox").TString;
            state: import("typebox").TLiteral<"concealed">;
        }>]>>;
    }>;
    subjects: import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        retryable: import("typebox").TBoolean;
        limit: import("typebox").TLiteral<4>;
        items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
            id: import("typebox").TString;
            state: import("typebox").TLiteral<"available">;
            summary: import("typebox").TObject<{
                id: import("typebox").TString;
                type: import("typebox").TString;
                types: import("typebox").TArray<import("typebox").TString>;
                label: import("typebox").TUnion<[import("typebox").TObject<{
                    value: import("typebox").TString;
                    language: import("typebox").TString;
                }>, import("typebox").TNull]>;
                creativeWork: import("typebox").TBoolean;
                cover: import("typebox").TUnion<[import("typebox").TObject<{
                    media: import("typebox").TString;
                    width: import("typebox").TInteger;
                    height: import("typebox").TInteger;
                    placeholder: import("typebox").TObject<{
                        thumbhash: import("typebox").TString;
                        color: import("typebox").TString;
                    }>;
                    variants: import("typebox").TArray<import("typebox").TObject<{
                        format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                        width: import("typebox").TInteger;
                    }>>;
                    focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                        x: import("typebox").TNumber;
                        y: import("typebox").TNumber;
                    }>, import("typebox").TNull]>;
                    credit: import("typebox").TUnion<[import("typebox").TObject<{
                        rightsHolder: import("typebox").TString;
                        via: import("typebox").TObject<{
                            name: import("typebox").TString;
                            url: import("typebox").TString;
                        }>;
                        license: import("typebox").TString;
                        obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                    }>, import("typebox").TNull]>;
                }>, import("typebox").TNull]>;
            }>;
        }>, import("typebox").TObject<{
            id: import("typebox").TString;
            state: import("typebox").TLiteral<"concealed">;
            summary: import("typebox").TNull;
        }>]>>;
    }>;
    reviewScores: import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        retryable: import("typebox").TBoolean;
        items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
            revisionId: import("typebox").TString;
            state: import("typebox").TLiteral<"available">;
            citation: import("typebox").TObject<{
                questionId: import("typebox").TString;
                units: import("typebox").TInteger;
                revision: import("typebox").TInteger;
            }>;
            question: import("typebox").TObject<{
                id: import("typebox").TString;
                revision: import("typebox").TInteger;
                label: import("typebox").TString;
                grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                scale: import("typebox").TObject<{
                    min: import("typebox").TInteger;
                    max: import("typebox").TInteger;
                    displayStep: import("typebox").TInteger;
                }>;
                realmId: import("typebox").TOptional<import("typebox").TString>;
                meaning: import("typebox").TOptional<import("typebox").TString>;
                canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
                labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
                lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                    revision: import("typebox").TInteger;
                }>>;
            }>;
        }>, import("typebox").TObject<{
            revisionId: import("typebox").TString;
            state: import("typebox").TLiteral<"unavailable">;
            citation: import("typebox").TNull;
            question: import("typebox").TNull;
        }>]>>;
    }>;
    media: import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        retryable: import("typebox").TBoolean;
        items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
            id: import("typebox").TString;
            state: import("typebox").TLiteral<"available">;
            image: import("typebox").TObject<{
                id: import("typebox").TString;
                containerId: import("typebox").TString;
                digest: import("typebox").TString;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
                variants: import("typebox").TArray<import("typebox").TObject<{
                    format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                    width: import("typebox").TInteger;
                    height: import("typebox").TInteger;
                }>>;
                placeholder: import("typebox").TUnion<[import("typebox").TObject<{
                    thumbhash: import("typebox").TString;
                    color: import("typebox").TString;
                }>, import("typebox").TNull]>;
                focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                    x: import("typebox").TNumber;
                    y: import("typebox").TNumber;
                }>, import("typebox").TNull]>;
                credit: import("typebox").TUnion<[import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                }>, import("typebox").TNull]>;
            }>;
        }>, import("typebox").TObject<{
            id: import("typebox").TString;
            state: import("typebox").TLiteral<"concealed">;
        }>]>>;
    }>;
    actions: import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        retryable: import("typebox").TBoolean;
        references: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
            type: import("typebox").TLiteral<"content.thread">;
            id: import("typebox").TString;
            state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"withheld">]>;
            operations: import("typebox").TArray<import("typebox").TObject<{
                action: import("typebox").TString;
                operationId: import("typebox").TString;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"sign_in_required">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"not_applicable">]>;
            }>>;
        }>, import("typebox").TObject<{
            type: import("typebox").TLiteral<"content.post">;
            id: import("typebox").TString;
            sourceRevisionId: import("typebox").TString;
            state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"withheld">]>;
            operations: import("typebox").TArray<import("typebox").TObject<{
                action: import("typebox").TString;
                operationId: import("typebox").TString;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"sign_in_required">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"not_applicable">]>;
            }>>;
        }>]>>;
    }>;
    navigation: import("typebox").TObject<{
        exact: import("typebox").TArray<import("typebox").TObject<{
            postId: import("typebox").TString;
            revisionId: import("typebox").TString;
        }>>;
        compareToHead: import("typebox").TArray<import("typebox").TObject<{
            postId: import("typebox").TString;
            fromRevisionId: import("typebox").TString;
            toRevisionId: import("typebox").TString;
        }>>;
    }>;
    currentness: import("typebox").TObject<{
        source: import("typebox").TLiteral<"current">;
        conversation: import("typebox").TLiteral<"current">;
        board: import("typebox").TLiteral<"current">;
        place: import("typebox").TLiteral<"current">;
        head: import("typebox").TLiteral<"current">;
        authors: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        mentions: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        subjects: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        reviewScores: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        media: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        actions: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
    }>;
    retry: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"same_cursor">;
        cursor: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"none">;
    }>]>;
}>;
export declare const RevisionPageResponseSchema: import("typebox").TObject<{
    revisions: import("typebox").TArray<import("typebox").TUnsafe<ItemView & ViewerReactionSlot & ReactionCountsSlot>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    page: import("typebox").TObject<{
        viewer: import("typebox").TUnion<[import("typebox").TObject<{
            kind: import("typebox").TLiteral<"account">;
            id: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"anonymous">;
        }>]>;
        conversation: import("typebox").TObject<{
            id: import("typebox").TString;
            kind: import("typebox").TUnion<[import("typebox").TLiteral<"discussion">, import("typebox").TLiteral<"review">]>;
            title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            authorId: import("typebox").TString;
            boardId: import("typebox").TString;
            subjectIds: import("typebox").TArray<import("typebox").TString>;
            createdAt: import("typebox").TString;
        }>;
        board: import("typebox").TUnsafe<Readonly<{
            id: import("./model.ts").BoardId;
            realmId: string | null;
            community: import("./community-presentation-model.ts").CommunityPresentation | null;
            route: import("./model.ts").Route;
            title: string | null;
            purpose: 'discussion' | 'reviews';
            visibility: import("./model.ts").Visibility;
            securityRevision: import("./model.ts").SecurityRevision;
            availability: import("./model.ts").Availability;
            createdAt: string;
        }>>;
        place: import("typebox").TUnion<[import("typebox").TObject<{
            kind: import("typebox").TLiteral<"global">;
            id: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"realm">;
            id: import("typebox").TString;
        }>]>;
        head: import("typebox").TObject<{
            postId: import("typebox").TString;
            revisionId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"erased">]>;
            authorId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            createdAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            revisedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>;
        authors: import("typebox").TObject<{
            state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
            retryable: import("typebox").TBoolean;
            items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                id: import("typebox").TString;
                state: import("typebox").TLiteral<"available">;
                displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                avatar: import("typebox").TUnion<[import("typebox").TObject<{
                    media: import("typebox").TString;
                    width: import("typebox").TInteger;
                    height: import("typebox").TInteger;
                    placeholder: import("typebox").TObject<{
                        thumbhash: import("typebox").TString;
                        color: import("typebox").TString;
                    }>;
                    variants: import("typebox").TArray<import("typebox").TObject<{
                        format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                        width: import("typebox").TInteger;
                    }>>;
                    focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                        x: import("typebox").TNumber;
                        y: import("typebox").TNumber;
                    }>, import("typebox").TNull]>;
                    credit: import("typebox").TNull;
                }>, import("typebox").TNull]>;
            }>, import("typebox").TObject<{
                id: import("typebox").TString;
                state: import("typebox").TLiteral<"concealed">;
            }>]>>;
        }>;
        mentions: import("typebox").TObject<{
            state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
            retryable: import("typebox").TBoolean;
            items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                id: import("typebox").TString;
                state: import("typebox").TLiteral<"available">;
                handle: import("typebox").TString;
            }>, import("typebox").TObject<{
                id: import("typebox").TString;
                state: import("typebox").TLiteral<"concealed">;
            }>]>>;
        }>;
        subjects: import("typebox").TObject<{
            state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
            retryable: import("typebox").TBoolean;
            limit: import("typebox").TLiteral<4>;
            items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                id: import("typebox").TString;
                state: import("typebox").TLiteral<"available">;
                summary: import("typebox").TObject<{
                    id: import("typebox").TString;
                    type: import("typebox").TString;
                    types: import("typebox").TArray<import("typebox").TString>;
                    label: import("typebox").TUnion<[import("typebox").TObject<{
                        value: import("typebox").TString;
                        language: import("typebox").TString;
                    }>, import("typebox").TNull]>;
                    creativeWork: import("typebox").TBoolean;
                    cover: import("typebox").TUnion<[import("typebox").TObject<{
                        media: import("typebox").TString;
                        width: import("typebox").TInteger;
                        height: import("typebox").TInteger;
                        placeholder: import("typebox").TObject<{
                            thumbhash: import("typebox").TString;
                            color: import("typebox").TString;
                        }>;
                        variants: import("typebox").TArray<import("typebox").TObject<{
                            format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                            width: import("typebox").TInteger;
                        }>>;
                        focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                            x: import("typebox").TNumber;
                            y: import("typebox").TNumber;
                        }>, import("typebox").TNull]>;
                        credit: import("typebox").TUnion<[import("typebox").TObject<{
                            rightsHolder: import("typebox").TString;
                            via: import("typebox").TObject<{
                                name: import("typebox").TString;
                                url: import("typebox").TString;
                            }>;
                            license: import("typebox").TString;
                            obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                        }>, import("typebox").TNull]>;
                    }>, import("typebox").TNull]>;
                }>;
            }>, import("typebox").TObject<{
                id: import("typebox").TString;
                state: import("typebox").TLiteral<"concealed">;
                summary: import("typebox").TNull;
            }>]>>;
        }>;
        reviewScores: import("typebox").TObject<{
            state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
            retryable: import("typebox").TBoolean;
            items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                revisionId: import("typebox").TString;
                state: import("typebox").TLiteral<"available">;
                citation: import("typebox").TObject<{
                    questionId: import("typebox").TString;
                    units: import("typebox").TInteger;
                    revision: import("typebox").TInteger;
                }>;
                question: import("typebox").TObject<{
                    id: import("typebox").TString;
                    revision: import("typebox").TInteger;
                    label: import("typebox").TString;
                    grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                    scale: import("typebox").TObject<{
                        min: import("typebox").TInteger;
                        max: import("typebox").TInteger;
                        displayStep: import("typebox").TInteger;
                    }>;
                    realmId: import("typebox").TOptional<import("typebox").TString>;
                    meaning: import("typebox").TOptional<import("typebox").TString>;
                    canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
                    labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
                    lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                        revision: import("typebox").TInteger;
                    }>>;
                }>;
            }>, import("typebox").TObject<{
                revisionId: import("typebox").TString;
                state: import("typebox").TLiteral<"unavailable">;
                citation: import("typebox").TNull;
                question: import("typebox").TNull;
            }>]>>;
        }>;
        media: import("typebox").TObject<{
            state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
            retryable: import("typebox").TBoolean;
            items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                id: import("typebox").TString;
                state: import("typebox").TLiteral<"available">;
                image: import("typebox").TObject<{
                    id: import("typebox").TString;
                    containerId: import("typebox").TString;
                    digest: import("typebox").TString;
                    width: import("typebox").TInteger;
                    height: import("typebox").TInteger;
                    variants: import("typebox").TArray<import("typebox").TObject<{
                        format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                        width: import("typebox").TInteger;
                        height: import("typebox").TInteger;
                    }>>;
                    placeholder: import("typebox").TUnion<[import("typebox").TObject<{
                        thumbhash: import("typebox").TString;
                        color: import("typebox").TString;
                    }>, import("typebox").TNull]>;
                    focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                        x: import("typebox").TNumber;
                        y: import("typebox").TNumber;
                    }>, import("typebox").TNull]>;
                    credit: import("typebox").TUnion<[import("typebox").TObject<{
                        rightsHolder: import("typebox").TString;
                        via: import("typebox").TObject<{
                            name: import("typebox").TString;
                            url: import("typebox").TString;
                        }>;
                        license: import("typebox").TString;
                        obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                    }>, import("typebox").TNull]>;
                }>;
            }>, import("typebox").TObject<{
                id: import("typebox").TString;
                state: import("typebox").TLiteral<"concealed">;
            }>]>>;
        }>;
        actions: import("typebox").TObject<{
            state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
            retryable: import("typebox").TBoolean;
            references: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                type: import("typebox").TLiteral<"content.thread">;
                id: import("typebox").TString;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"withheld">]>;
                operations: import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operationId: import("typebox").TString;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"sign_in_required">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"not_applicable">]>;
                }>>;
            }>, import("typebox").TObject<{
                type: import("typebox").TLiteral<"content.post">;
                id: import("typebox").TString;
                sourceRevisionId: import("typebox").TString;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"withheld">]>;
                operations: import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operationId: import("typebox").TString;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"sign_in_required">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"not_applicable">]>;
                }>>;
            }>]>>;
        }>;
        navigation: import("typebox").TObject<{
            exact: import("typebox").TArray<import("typebox").TObject<{
                postId: import("typebox").TString;
                revisionId: import("typebox").TString;
            }>>;
            compareToHead: import("typebox").TArray<import("typebox").TObject<{
                postId: import("typebox").TString;
                fromRevisionId: import("typebox").TString;
                toRevisionId: import("typebox").TString;
            }>>;
        }>;
        currentness: import("typebox").TObject<{
            source: import("typebox").TLiteral<"current">;
            conversation: import("typebox").TLiteral<"current">;
            board: import("typebox").TLiteral<"current">;
            place: import("typebox").TLiteral<"current">;
            head: import("typebox").TLiteral<"current">;
            authors: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
            mentions: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
            subjects: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
            reviewScores: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
            media: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
            actions: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        }>;
        retry: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"same_cursor">;
            cursor: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"none">;
        }>]>;
    }>;
}>;
export declare const MediaImportInputSchema: {
    '~standard': {
        version: 1;
        vendor: string;
        types: {
            input: {
                containerId: string;
                sourceUrl: string;
                crop?: string;
                focalPoint?: {
                    x: number;
                    y: number;
                };
                credit: {
                    rightsHolder: string;
                    via: {
                        name: string;
                        url: string;
                    };
                    license: string;
                    obligations: ("cc:Attribution" | "cc:Notice" | "cc:ShareAlike" | "cc:SourceCode")[];
                };
                provenance: {
                    source: string;
                    external_id: string;
                    record_revision: string;
                    digest: string;
                    converter_revision: string;
                    field_group: "cover";
                    references: {
                        parts: ({
                            property: {
                                id: string;
                            };
                            value: {
                                type: "value";
                                content: unknown;
                            };
                        } | {
                            property: {
                                id: string;
                            };
                            value: {
                                type: "somevalue";
                            } | {
                                type: "novalue";
                            };
                        })[];
                    }[];
                };
            };
            output: {
                containerId: string;
                sourceUrl: string;
                crop?: string;
                focalPoint?: {
                    x: number;
                    y: number;
                };
                credit: {
                    rightsHolder: string;
                    via: {
                        name: string;
                        url: string;
                    };
                    license: string;
                    obligations: ("cc:Attribution" | "cc:Notice" | "cc:ShareAlike" | "cc:SourceCode")[];
                };
                provenance: {
                    source: string;
                    external_id: string;
                    record_revision: string;
                    digest: string;
                    converter_revision: string;
                    field_group: "cover";
                    references: {
                        parts: ({
                            property: {
                                id: string;
                            };
                            value: {
                                type: "value";
                                content: unknown;
                            };
                        } | {
                            property: {
                                id: string;
                            };
                            value: {
                                type: "somevalue";
                            } | {
                                type: "novalue";
                            };
                        })[];
                    }[];
                };
            };
        } | undefined;
        validate(value: unknown): {
            value: {
                containerId: string;
                sourceUrl: string;
                crop?: string;
                focalPoint?: {
                    x: number;
                    y: number;
                };
                credit: {
                    rightsHolder: string;
                    via: {
                        name: string;
                        url: string;
                    };
                    license: string;
                    obligations: ("cc:Attribution" | "cc:Notice" | "cc:ShareAlike" | "cc:SourceCode")[];
                };
                provenance: {
                    source: string;
                    external_id: string;
                    record_revision: string;
                    digest: string;
                    converter_revision: string;
                    field_group: "cover";
                    references: {
                        parts: ({
                            property: {
                                id: string;
                            };
                            value: {
                                type: "value";
                                content: unknown;
                            };
                        } | {
                            property: {
                                id: string;
                            };
                            value: {
                                type: "somevalue";
                            } | {
                                type: "novalue";
                            };
                        })[];
                    }[];
                };
            };
            issues?: never;
        } | {
            value?: never;
            issues: {
                message: string;
            }[];
        };
        jsonSchema: {
            input: () => import("typebox").TObject<{
                containerId: import("typebox").TString;
                sourceUrl: import("typebox").TString;
                crop: import("typebox").TOptional<import("typebox").TString>;
                focalPoint: import("typebox").TOptional<import("typebox").TObject<{
                    x: import("typebox").TNumber;
                    y: import("typebox").TNumber;
                }>>;
                credit: import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                }>;
                provenance: import("typebox").TObject<{
                    source: import("typebox").TString;
                    external_id: import("typebox").TString;
                    record_revision: import("typebox").TString;
                    digest: import("typebox").TString;
                    converter_revision: import("typebox").TString;
                    field_group: import("typebox").TLiteral<"cover">;
                    references: import("typebox").TArray<import("typebox").TObject<{
                        parts: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                            property: import("typebox").TObject<{
                                id: import("typebox").TString;
                            }>;
                            value: import("typebox").TObject<{
                                type: import("typebox").TLiteral<"value">;
                                content: import("typebox").TUnknown;
                            }>;
                        }>, import("typebox").TObject<{
                            property: import("typebox").TObject<{
                                id: import("typebox").TString;
                            }>;
                            value: import("typebox").TUnion<[import("typebox").TObject<{
                                type: import("typebox").TLiteral<"somevalue">;
                            }>, import("typebox").TObject<{
                                type: import("typebox").TLiteral<"novalue">;
                            }>]>;
                        }>]>>;
                    }>>;
                }>;
            }>;
            output: () => import("typebox").TObject<{
                containerId: import("typebox").TString;
                sourceUrl: import("typebox").TString;
                crop: import("typebox").TOptional<import("typebox").TString>;
                focalPoint: import("typebox").TOptional<import("typebox").TObject<{
                    x: import("typebox").TNumber;
                    y: import("typebox").TNumber;
                }>>;
                credit: import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                }>;
                provenance: import("typebox").TObject<{
                    source: import("typebox").TString;
                    external_id: import("typebox").TString;
                    record_revision: import("typebox").TString;
                    digest: import("typebox").TString;
                    converter_revision: import("typebox").TString;
                    field_group: import("typebox").TLiteral<"cover">;
                    references: import("typebox").TArray<import("typebox").TObject<{
                        parts: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                            property: import("typebox").TObject<{
                                id: import("typebox").TString;
                            }>;
                            value: import("typebox").TObject<{
                                type: import("typebox").TLiteral<"value">;
                                content: import("typebox").TUnknown;
                            }>;
                        }>, import("typebox").TObject<{
                            property: import("typebox").TObject<{
                                id: import("typebox").TString;
                            }>;
                            value: import("typebox").TUnion<[import("typebox").TObject<{
                                type: import("typebox").TLiteral<"somevalue">;
                            }>, import("typebox").TObject<{
                                type: import("typebox").TLiteral<"novalue">;
                            }>]>;
                        }>]>>;
                    }>>;
                }>;
            }>;
        };
    };
};
export declare const MediaImportReceiptSchema: {
    '~standard': {
        version: 1;
        vendor: string;
        types: {
            input: {
                media: {
                    id: string;
                    containerId: string;
                    purpose: "cover";
                    state: "reserved";
                };
            };
            output: {
                media: {
                    id: string;
                    containerId: string;
                    purpose: "cover";
                    state: "reserved";
                };
            };
        } | undefined;
        validate(value: unknown): {
            value: {
                media: {
                    id: string;
                    containerId: string;
                    purpose: "cover";
                    state: "reserved";
                };
            };
            issues?: never;
        } | {
            value?: never;
            issues: {
                message: string;
            }[];
        };
        jsonSchema: {
            input: () => import("typebox").TObject<{
                media: import("typebox").TObject<{
                    id: import("typebox").TString;
                    containerId: import("typebox").TString;
                    purpose: import("typebox").TLiteral<"cover">;
                    state: import("typebox").TLiteral<"reserved">;
                }>;
            }>;
            output: () => import("typebox").TObject<{
                media: import("typebox").TObject<{
                    id: import("typebox").TString;
                    containerId: import("typebox").TString;
                    purpose: import("typebox").TLiteral<"cover">;
                    state: import("typebox").TLiteral<"reserved">;
                }>;
            }>;
        };
    };
};
export declare const MediaImportPollSchema: {
    '~standard': {
        version: 1;
        vendor: string;
        types: {
            input: {
                media: {
                    id: string;
                    containerId: string;
                    purpose: "cover";
                    crop?: string;
                    focalPoint?: {
                        x: number;
                        y: number;
                    };
                    credit: {
                        rightsHolder: string;
                        via: {
                            name: string;
                            url: string;
                        };
                        license: string;
                        obligations: ("cc:Attribution" | "cc:Notice" | "cc:ShareAlike" | "cc:SourceCode")[];
                    };
                    provenance: {
                        source: string;
                        external_id: string;
                        record_revision: string;
                        digest: string;
                        converter_revision: string;
                        field_group: "cover";
                        references: {
                            parts: ({
                                property: {
                                    id: string;
                                };
                                value: {
                                    type: "value";
                                    content: unknown;
                                };
                            } | {
                                property: {
                                    id: string;
                                };
                                value: {
                                    type: "somevalue";
                                } | {
                                    type: "novalue";
                                };
                            })[];
                        }[];
                    };
                    rejection?: {
                        code: string;
                    };
                    state: "rejected" | "reserved";
                    byteCount: number | null;
                    mediaType: string | null;
                    sha256: string | null;
                } | {
                    id: string;
                    containerId: string;
                    purpose: "cover";
                    byteCount: number;
                    mediaType: string;
                    sha256: string;
                    crop?: string;
                    focalPoint?: {
                        x: number;
                        y: number;
                    };
                    credit: {
                        rightsHolder: string;
                        via: {
                            name: string;
                            url: string;
                        };
                        license: string;
                        obligations: ("cc:Attribution" | "cc:Notice" | "cc:ShareAlike" | "cc:SourceCode")[];
                    };
                    provenance: {
                        source: string;
                        external_id: string;
                        record_revision: string;
                        digest: string;
                        converter_revision: string;
                        field_group: "cover";
                        references: {
                            parts: ({
                                property: {
                                    id: string;
                                };
                                value: {
                                    type: "value";
                                    content: unknown;
                                };
                            } | {
                                property: {
                                    id: string;
                                };
                                value: {
                                    type: "somevalue";
                                } | {
                                    type: "novalue";
                                };
                            })[];
                        }[];
                    };
                    rejection?: {
                        code: string;
                    };
                    state: "available" | "uploaded";
                };
            };
            output: {
                media: {
                    id: string;
                    containerId: string;
                    purpose: "cover";
                    crop?: string;
                    focalPoint?: {
                        x: number;
                        y: number;
                    };
                    credit: {
                        rightsHolder: string;
                        via: {
                            name: string;
                            url: string;
                        };
                        license: string;
                        obligations: ("cc:Attribution" | "cc:Notice" | "cc:ShareAlike" | "cc:SourceCode")[];
                    };
                    provenance: {
                        source: string;
                        external_id: string;
                        record_revision: string;
                        digest: string;
                        converter_revision: string;
                        field_group: "cover";
                        references: {
                            parts: ({
                                property: {
                                    id: string;
                                };
                                value: {
                                    type: "value";
                                    content: unknown;
                                };
                            } | {
                                property: {
                                    id: string;
                                };
                                value: {
                                    type: "somevalue";
                                } | {
                                    type: "novalue";
                                };
                            })[];
                        }[];
                    };
                    rejection?: {
                        code: string;
                    };
                    state: "rejected" | "reserved";
                    byteCount: number | null;
                    mediaType: string | null;
                    sha256: string | null;
                } | {
                    id: string;
                    containerId: string;
                    purpose: "cover";
                    byteCount: number;
                    mediaType: string;
                    sha256: string;
                    crop?: string;
                    focalPoint?: {
                        x: number;
                        y: number;
                    };
                    credit: {
                        rightsHolder: string;
                        via: {
                            name: string;
                            url: string;
                        };
                        license: string;
                        obligations: ("cc:Attribution" | "cc:Notice" | "cc:ShareAlike" | "cc:SourceCode")[];
                    };
                    provenance: {
                        source: string;
                        external_id: string;
                        record_revision: string;
                        digest: string;
                        converter_revision: string;
                        field_group: "cover";
                        references: {
                            parts: ({
                                property: {
                                    id: string;
                                };
                                value: {
                                    type: "value";
                                    content: unknown;
                                };
                            } | {
                                property: {
                                    id: string;
                                };
                                value: {
                                    type: "somevalue";
                                } | {
                                    type: "novalue";
                                };
                            })[];
                        }[];
                    };
                    rejection?: {
                        code: string;
                    };
                    state: "available" | "uploaded";
                };
            };
        } | undefined;
        validate(value: unknown): {
            value: {
                media: {
                    id: string;
                    containerId: string;
                    purpose: "cover";
                    crop?: string;
                    focalPoint?: {
                        x: number;
                        y: number;
                    };
                    credit: {
                        rightsHolder: string;
                        via: {
                            name: string;
                            url: string;
                        };
                        license: string;
                        obligations: ("cc:Attribution" | "cc:Notice" | "cc:ShareAlike" | "cc:SourceCode")[];
                    };
                    provenance: {
                        source: string;
                        external_id: string;
                        record_revision: string;
                        digest: string;
                        converter_revision: string;
                        field_group: "cover";
                        references: {
                            parts: ({
                                property: {
                                    id: string;
                                };
                                value: {
                                    type: "value";
                                    content: unknown;
                                };
                            } | {
                                property: {
                                    id: string;
                                };
                                value: {
                                    type: "somevalue";
                                } | {
                                    type: "novalue";
                                };
                            })[];
                        }[];
                    };
                    rejection?: {
                        code: string;
                    };
                    state: "rejected" | "reserved";
                    byteCount: number | null;
                    mediaType: string | null;
                    sha256: string | null;
                } | {
                    id: string;
                    containerId: string;
                    purpose: "cover";
                    byteCount: number;
                    mediaType: string;
                    sha256: string;
                    crop?: string;
                    focalPoint?: {
                        x: number;
                        y: number;
                    };
                    credit: {
                        rightsHolder: string;
                        via: {
                            name: string;
                            url: string;
                        };
                        license: string;
                        obligations: ("cc:Attribution" | "cc:Notice" | "cc:ShareAlike" | "cc:SourceCode")[];
                    };
                    provenance: {
                        source: string;
                        external_id: string;
                        record_revision: string;
                        digest: string;
                        converter_revision: string;
                        field_group: "cover";
                        references: {
                            parts: ({
                                property: {
                                    id: string;
                                };
                                value: {
                                    type: "value";
                                    content: unknown;
                                };
                            } | {
                                property: {
                                    id: string;
                                };
                                value: {
                                    type: "somevalue";
                                } | {
                                    type: "novalue";
                                };
                            })[];
                        }[];
                    };
                    rejection?: {
                        code: string;
                    };
                    state: "available" | "uploaded";
                };
            };
            issues?: never;
        } | {
            value?: never;
            issues: {
                message: string;
            }[];
        };
        jsonSchema: {
            input: () => import("typebox").TObject<{
                media: import("typebox").TUnion<[import("typebox").TObject<{
                    id: import("typebox").TString;
                    containerId: import("typebox").TString;
                    purpose: import("typebox").TLiteral<"cover">;
                    crop: import("typebox").TOptional<import("typebox").TString>;
                    focalPoint: import("typebox").TOptional<import("typebox").TObject<{
                        x: import("typebox").TNumber;
                        y: import("typebox").TNumber;
                    }>>;
                    credit: import("typebox").TObject<{
                        rightsHolder: import("typebox").TString;
                        via: import("typebox").TObject<{
                            name: import("typebox").TString;
                            url: import("typebox").TString;
                        }>;
                        license: import("typebox").TString;
                        obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                    }>;
                    provenance: import("typebox").TObject<{
                        source: import("typebox").TString;
                        external_id: import("typebox").TString;
                        record_revision: import("typebox").TString;
                        digest: import("typebox").TString;
                        converter_revision: import("typebox").TString;
                        field_group: import("typebox").TLiteral<"cover">;
                        references: import("typebox").TArray<import("typebox").TObject<{
                            parts: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                                property: import("typebox").TObject<{
                                    id: import("typebox").TString;
                                }>;
                                value: import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"value">;
                                    content: import("typebox").TUnknown;
                                }>;
                            }>, import("typebox").TObject<{
                                property: import("typebox").TObject<{
                                    id: import("typebox").TString;
                                }>;
                                value: import("typebox").TUnion<[import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"somevalue">;
                                }>, import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"novalue">;
                                }>]>;
                            }>]>>;
                        }>>;
                    }>;
                    rejection: import("typebox").TOptional<import("typebox").TObject<{
                        code: import("typebox").TString;
                    }>>;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"reserved">, import("typebox").TLiteral<"rejected">]>;
                    byteCount: import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>;
                    mediaType: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    sha256: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>, import("typebox").TObject<{
                    id: import("typebox").TString;
                    containerId: import("typebox").TString;
                    purpose: import("typebox").TLiteral<"cover">;
                    byteCount: import("typebox").TInteger;
                    mediaType: import("typebox").TString;
                    sha256: import("typebox").TString;
                    crop: import("typebox").TOptional<import("typebox").TString>;
                    focalPoint: import("typebox").TOptional<import("typebox").TObject<{
                        x: import("typebox").TNumber;
                        y: import("typebox").TNumber;
                    }>>;
                    credit: import("typebox").TObject<{
                        rightsHolder: import("typebox").TString;
                        via: import("typebox").TObject<{
                            name: import("typebox").TString;
                            url: import("typebox").TString;
                        }>;
                        license: import("typebox").TString;
                        obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                    }>;
                    provenance: import("typebox").TObject<{
                        source: import("typebox").TString;
                        external_id: import("typebox").TString;
                        record_revision: import("typebox").TString;
                        digest: import("typebox").TString;
                        converter_revision: import("typebox").TString;
                        field_group: import("typebox").TLiteral<"cover">;
                        references: import("typebox").TArray<import("typebox").TObject<{
                            parts: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                                property: import("typebox").TObject<{
                                    id: import("typebox").TString;
                                }>;
                                value: import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"value">;
                                    content: import("typebox").TUnknown;
                                }>;
                            }>, import("typebox").TObject<{
                                property: import("typebox").TObject<{
                                    id: import("typebox").TString;
                                }>;
                                value: import("typebox").TUnion<[import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"somevalue">;
                                }>, import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"novalue">;
                                }>]>;
                            }>]>>;
                        }>>;
                    }>;
                    rejection: import("typebox").TOptional<import("typebox").TObject<{
                        code: import("typebox").TString;
                    }>>;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"uploaded">, import("typebox").TLiteral<"available">]>;
                }>]>;
            }>;
            output: () => import("typebox").TObject<{
                media: import("typebox").TUnion<[import("typebox").TObject<{
                    id: import("typebox").TString;
                    containerId: import("typebox").TString;
                    purpose: import("typebox").TLiteral<"cover">;
                    crop: import("typebox").TOptional<import("typebox").TString>;
                    focalPoint: import("typebox").TOptional<import("typebox").TObject<{
                        x: import("typebox").TNumber;
                        y: import("typebox").TNumber;
                    }>>;
                    credit: import("typebox").TObject<{
                        rightsHolder: import("typebox").TString;
                        via: import("typebox").TObject<{
                            name: import("typebox").TString;
                            url: import("typebox").TString;
                        }>;
                        license: import("typebox").TString;
                        obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                    }>;
                    provenance: import("typebox").TObject<{
                        source: import("typebox").TString;
                        external_id: import("typebox").TString;
                        record_revision: import("typebox").TString;
                        digest: import("typebox").TString;
                        converter_revision: import("typebox").TString;
                        field_group: import("typebox").TLiteral<"cover">;
                        references: import("typebox").TArray<import("typebox").TObject<{
                            parts: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                                property: import("typebox").TObject<{
                                    id: import("typebox").TString;
                                }>;
                                value: import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"value">;
                                    content: import("typebox").TUnknown;
                                }>;
                            }>, import("typebox").TObject<{
                                property: import("typebox").TObject<{
                                    id: import("typebox").TString;
                                }>;
                                value: import("typebox").TUnion<[import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"somevalue">;
                                }>, import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"novalue">;
                                }>]>;
                            }>]>>;
                        }>>;
                    }>;
                    rejection: import("typebox").TOptional<import("typebox").TObject<{
                        code: import("typebox").TString;
                    }>>;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"reserved">, import("typebox").TLiteral<"rejected">]>;
                    byteCount: import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>;
                    mediaType: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    sha256: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>, import("typebox").TObject<{
                    id: import("typebox").TString;
                    containerId: import("typebox").TString;
                    purpose: import("typebox").TLiteral<"cover">;
                    byteCount: import("typebox").TInteger;
                    mediaType: import("typebox").TString;
                    sha256: import("typebox").TString;
                    crop: import("typebox").TOptional<import("typebox").TString>;
                    focalPoint: import("typebox").TOptional<import("typebox").TObject<{
                        x: import("typebox").TNumber;
                        y: import("typebox").TNumber;
                    }>>;
                    credit: import("typebox").TObject<{
                        rightsHolder: import("typebox").TString;
                        via: import("typebox").TObject<{
                            name: import("typebox").TString;
                            url: import("typebox").TString;
                        }>;
                        license: import("typebox").TString;
                        obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                    }>;
                    provenance: import("typebox").TObject<{
                        source: import("typebox").TString;
                        external_id: import("typebox").TString;
                        record_revision: import("typebox").TString;
                        digest: import("typebox").TString;
                        converter_revision: import("typebox").TString;
                        field_group: import("typebox").TLiteral<"cover">;
                        references: import("typebox").TArray<import("typebox").TObject<{
                            parts: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                                property: import("typebox").TObject<{
                                    id: import("typebox").TString;
                                }>;
                                value: import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"value">;
                                    content: import("typebox").TUnknown;
                                }>;
                            }>, import("typebox").TObject<{
                                property: import("typebox").TObject<{
                                    id: import("typebox").TString;
                                }>;
                                value: import("typebox").TUnion<[import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"somevalue">;
                                }>, import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"novalue">;
                                }>]>;
                            }>]>>;
                        }>>;
                    }>;
                    rejection: import("typebox").TOptional<import("typebox").TObject<{
                        code: import("typebox").TString;
                    }>>;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"uploaded">, import("typebox").TLiteral<"available">]>;
                }>]>;
            }>;
        };
    };
};
export declare const BoardThreadsQuerySchema: import("typebox").TObject<{
    cursor: import("typebox").TOptional<import("typebox").TString>;
    limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
    sort: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"newest">, import("typebox").TLiteral<"oldest">, import("typebox").TLiteral<"active">, import("typebox").TLiteral<"hot">]>>;
    query: import("typebox").TOptional<import("typebox").TString>;
}>;
export declare const BoardThreadsResponseSchema: import("typebox").TObject<{
    pinnedThreads: import("typebox").TArray<import("typebox").TUnsafe<Omit<Readonly<{
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
        firstPost: PostEntry;
    }> & ViewerReactionSlot & ReactionCountsSlot & Readonly<{
        reviewContext?: FeedReviewContext;
    }>>>;
    threads: import("typebox").TArray<import("typebox").TUnsafe<Omit<Readonly<{
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
        firstPost: PostEntry;
    }> & ViewerReactionSlot & ReactionCountsSlot & Readonly<{
        reviewContext?: FeedReviewContext;
    }>>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    rankRefreshedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare const BoardOpeningCardSchema: import("typebox").TObject<{
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
        firstPost: PostEntry;
    }> & ViewerReactionSlot & ReactionCountsSlot & Readonly<{
        reviewContext?: FeedReviewContext;
    }>>;
    target: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"thread">;
        id: import("typebox").TString;
        boardId: import("typebox").TString;
    }>;
    authors: import("typebox").TObject<{
        thread: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"available">;
            id: import("typebox").TString;
            kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
            handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            automated: import("typebox").TBoolean;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
        }>]>;
        openingPost: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"available">;
            id: import("typebox").TString;
            kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
            handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            automated: import("typebox").TBoolean;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
        }>]>;
    }>;
    media: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"none">;
        images: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            containerId: import("typebox").TString;
            digest: import("typebox").TString;
            width: import("typebox").TInteger;
            height: import("typebox").TInteger;
            variants: import("typebox").TArray<import("typebox").TObject<{
                format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
            }>>;
            placeholder: import("typebox").TUnion<[import("typebox").TObject<{
                thumbhash: import("typebox").TString;
                color: import("typebox").TString;
            }>, import("typebox").TNull]>;
            focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                x: import("typebox").TNumber;
                y: import("typebox").TNumber;
            }>, import("typebox").TNull]>;
            credit: import("typebox").TUnion<[import("typebox").TObject<{
                rightsHolder: import("typebox").TString;
                via: import("typebox").TObject<{
                    name: import("typebox").TString;
                    url: import("typebox").TString;
                }>;
                license: import("typebox").TString;
                obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
            }>, import("typebox").TNull]>;
        }>>;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"available">;
        images: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            containerId: import("typebox").TString;
            digest: import("typebox").TString;
            width: import("typebox").TInteger;
            height: import("typebox").TInteger;
            variants: import("typebox").TArray<import("typebox").TObject<{
                format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
            }>>;
            placeholder: import("typebox").TUnion<[import("typebox").TObject<{
                thumbhash: import("typebox").TString;
                color: import("typebox").TString;
            }>, import("typebox").TNull]>;
            focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                x: import("typebox").TNumber;
                y: import("typebox").TNumber;
            }>, import("typebox").TNull]>;
            credit: import("typebox").TUnion<[import("typebox").TObject<{
                rightsHolder: import("typebox").TString;
                via: import("typebox").TObject<{
                    name: import("typebox").TString;
                    url: import("typebox").TString;
                }>;
                license: import("typebox").TString;
                obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
            }>, import("typebox").TNull]>;
        }>>;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
        images: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            containerId: import("typebox").TString;
            digest: import("typebox").TString;
            width: import("typebox").TInteger;
            height: import("typebox").TInteger;
            variants: import("typebox").TArray<import("typebox").TObject<{
                format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
            }>>;
            placeholder: import("typebox").TUnion<[import("typebox").TObject<{
                thumbhash: import("typebox").TString;
                color: import("typebox").TString;
            }>, import("typebox").TNull]>;
            focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                x: import("typebox").TNumber;
                y: import("typebox").TNumber;
            }>, import("typebox").TNull]>;
            credit: import("typebox").TUnion<[import("typebox").TObject<{
                rightsHolder: import("typebox").TString;
                via: import("typebox").TObject<{
                    name: import("typebox").TString;
                    url: import("typebox").TString;
                }>;
                license: import("typebox").TString;
                obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
            }>, import("typebox").TNull]>;
        }>>;
    }>]>;
    interaction: import("typebox").TObject<{
        target: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"thread">;
            id: import("typebox").TString;
        }>;
        counts: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"as-of">;
            values: import("typebox").TObject<{
                upvote: import("typebox").TOptional<import("typebox").TInteger>;
                downvote: import("typebox").TOptional<import("typebox").TInteger>;
                like: import("typebox").TOptional<import("typebox").TInteger>;
                love: import("typebox").TOptional<import("typebox").TInteger>;
                laugh: import("typebox").TOptional<import("typebox").TInteger>;
                insightful: import("typebox").TOptional<import("typebox").TInteger>;
                sad: import("typebox").TOptional<import("typebox").TInteger>;
            }>;
            source: import("typebox").TObject<{
                epoch: import("typebox").TInteger;
                position: import("typebox").TString;
            }>;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
        }>]>;
        viewer: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"current">;
            reaction: import("typebox").TUnion<[import("typebox").TUnsafe<"downvote" | "insightful" | "laugh" | "like" | "love" | "sad" | "upvote">, import("typebox").TNull]>;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"not-applicable">;
        }>]>;
    }>;
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
    actions: import("typebox").TObject<{
        reply: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"sign-in">, import("typebox").TLiteral<"unavailable">]>;
        react: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"sign-in">, import("typebox").TLiteral<"unavailable">]>;
        share: import("typebox").TLiteral<"available">;
    }>;
}>;
export declare const BoardPageQuerySchema: import("typebox").TObject<{
    cursor: import("typebox").TOptional<import("typebox").TString>;
    sort: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"new">, import("typebox").TLiteral<"active">, import("typebox").TLiteral<"hot">]>>;
}>;
export declare const BoardPageResponseSchema: import("typebox").TObject<{
    board: import("typebox").TUnsafe<Readonly<{
        id: import("./model.ts").BoardId;
        realmId: string | null;
        community: import("./community-presentation-model.ts").CommunityPresentation | null;
        route: import("./model.ts").Route;
        title: string | null;
        purpose: 'discussion' | 'reviews';
        visibility: import("./model.ts").Visibility;
        securityRevision: import("./model.ts").SecurityRevision;
        availability: import("./model.ts").Availability;
        createdAt: string;
    }>>;
    pinRevision: import("typebox").TString;
    pinnedThreads: import("typebox").TArray<import("typebox").TObject<{
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
            firstPost: PostEntry;
        }> & ViewerReactionSlot & ReactionCountsSlot & Readonly<{
            reviewContext?: FeedReviewContext;
        }>>;
        target: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"thread">;
            id: import("typebox").TString;
            boardId: import("typebox").TString;
        }>;
        authors: import("typebox").TObject<{
            thread: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"available">;
                id: import("typebox").TString;
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
                handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                automated: import("typebox").TBoolean;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unavailable">;
            }>]>;
            openingPost: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"available">;
                id: import("typebox").TString;
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
                handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                automated: import("typebox").TBoolean;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unavailable">;
            }>]>;
        }>;
        media: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"none">;
            images: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                containerId: import("typebox").TString;
                digest: import("typebox").TString;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
                variants: import("typebox").TArray<import("typebox").TObject<{
                    format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                    width: import("typebox").TInteger;
                    height: import("typebox").TInteger;
                }>>;
                placeholder: import("typebox").TUnion<[import("typebox").TObject<{
                    thumbhash: import("typebox").TString;
                    color: import("typebox").TString;
                }>, import("typebox").TNull]>;
                focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                    x: import("typebox").TNumber;
                    y: import("typebox").TNumber;
                }>, import("typebox").TNull]>;
                credit: import("typebox").TUnion<[import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                }>, import("typebox").TNull]>;
            }>>;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"available">;
            images: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                containerId: import("typebox").TString;
                digest: import("typebox").TString;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
                variants: import("typebox").TArray<import("typebox").TObject<{
                    format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                    width: import("typebox").TInteger;
                    height: import("typebox").TInteger;
                }>>;
                placeholder: import("typebox").TUnion<[import("typebox").TObject<{
                    thumbhash: import("typebox").TString;
                    color: import("typebox").TString;
                }>, import("typebox").TNull]>;
                focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                    x: import("typebox").TNumber;
                    y: import("typebox").TNumber;
                }>, import("typebox").TNull]>;
                credit: import("typebox").TUnion<[import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                }>, import("typebox").TNull]>;
            }>>;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
            images: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                containerId: import("typebox").TString;
                digest: import("typebox").TString;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
                variants: import("typebox").TArray<import("typebox").TObject<{
                    format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                    width: import("typebox").TInteger;
                    height: import("typebox").TInteger;
                }>>;
                placeholder: import("typebox").TUnion<[import("typebox").TObject<{
                    thumbhash: import("typebox").TString;
                    color: import("typebox").TString;
                }>, import("typebox").TNull]>;
                focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                    x: import("typebox").TNumber;
                    y: import("typebox").TNumber;
                }>, import("typebox").TNull]>;
                credit: import("typebox").TUnion<[import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                }>, import("typebox").TNull]>;
            }>>;
        }>]>;
        interaction: import("typebox").TObject<{
            target: import("typebox").TObject<{
                kind: import("typebox").TLiteral<"thread">;
                id: import("typebox").TString;
            }>;
            counts: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"as-of">;
                values: import("typebox").TObject<{
                    upvote: import("typebox").TOptional<import("typebox").TInteger>;
                    downvote: import("typebox").TOptional<import("typebox").TInteger>;
                    like: import("typebox").TOptional<import("typebox").TInteger>;
                    love: import("typebox").TOptional<import("typebox").TInteger>;
                    laugh: import("typebox").TOptional<import("typebox").TInteger>;
                    insightful: import("typebox").TOptional<import("typebox").TInteger>;
                    sad: import("typebox").TOptional<import("typebox").TInteger>;
                }>;
                source: import("typebox").TObject<{
                    epoch: import("typebox").TInteger;
                    position: import("typebox").TString;
                }>;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unavailable">;
            }>]>;
            viewer: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"current">;
                reaction: import("typebox").TUnion<[import("typebox").TUnsafe<"downvote" | "insightful" | "laugh" | "like" | "love" | "sad" | "upvote">, import("typebox").TNull]>;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"not-applicable">;
            }>]>;
        }>;
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
        actions: import("typebox").TObject<{
            reply: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"sign-in">, import("typebox").TLiteral<"unavailable">]>;
            react: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"sign-in">, import("typebox").TLiteral<"unavailable">]>;
            share: import("typebox").TLiteral<"available">;
        }>;
    }>>;
    threads: import("typebox").TArray<import("typebox").TObject<{
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
            firstPost: PostEntry;
        }> & ViewerReactionSlot & ReactionCountsSlot & Readonly<{
            reviewContext?: FeedReviewContext;
        }>>;
        target: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"thread">;
            id: import("typebox").TString;
            boardId: import("typebox").TString;
        }>;
        authors: import("typebox").TObject<{
            thread: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"available">;
                id: import("typebox").TString;
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
                handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                automated: import("typebox").TBoolean;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unavailable">;
            }>]>;
            openingPost: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"available">;
                id: import("typebox").TString;
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
                handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                automated: import("typebox").TBoolean;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unavailable">;
            }>]>;
        }>;
        media: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"none">;
            images: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                containerId: import("typebox").TString;
                digest: import("typebox").TString;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
                variants: import("typebox").TArray<import("typebox").TObject<{
                    format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                    width: import("typebox").TInteger;
                    height: import("typebox").TInteger;
                }>>;
                placeholder: import("typebox").TUnion<[import("typebox").TObject<{
                    thumbhash: import("typebox").TString;
                    color: import("typebox").TString;
                }>, import("typebox").TNull]>;
                focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                    x: import("typebox").TNumber;
                    y: import("typebox").TNumber;
                }>, import("typebox").TNull]>;
                credit: import("typebox").TUnion<[import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                }>, import("typebox").TNull]>;
            }>>;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"available">;
            images: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                containerId: import("typebox").TString;
                digest: import("typebox").TString;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
                variants: import("typebox").TArray<import("typebox").TObject<{
                    format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                    width: import("typebox").TInteger;
                    height: import("typebox").TInteger;
                }>>;
                placeholder: import("typebox").TUnion<[import("typebox").TObject<{
                    thumbhash: import("typebox").TString;
                    color: import("typebox").TString;
                }>, import("typebox").TNull]>;
                focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                    x: import("typebox").TNumber;
                    y: import("typebox").TNumber;
                }>, import("typebox").TNull]>;
                credit: import("typebox").TUnion<[import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                }>, import("typebox").TNull]>;
            }>>;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
            images: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                containerId: import("typebox").TString;
                digest: import("typebox").TString;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
                variants: import("typebox").TArray<import("typebox").TObject<{
                    format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                    width: import("typebox").TInteger;
                    height: import("typebox").TInteger;
                }>>;
                placeholder: import("typebox").TUnion<[import("typebox").TObject<{
                    thumbhash: import("typebox").TString;
                    color: import("typebox").TString;
                }>, import("typebox").TNull]>;
                focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                    x: import("typebox").TNumber;
                    y: import("typebox").TNumber;
                }>, import("typebox").TNull]>;
                credit: import("typebox").TUnion<[import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"cc:Attribution">, import("typebox").TLiteral<"cc:ShareAlike">, import("typebox").TLiteral<"cc:Notice">, import("typebox").TLiteral<"cc:SourceCode">]>>;
                }>, import("typebox").TNull]>;
            }>>;
        }>]>;
        interaction: import("typebox").TObject<{
            target: import("typebox").TObject<{
                kind: import("typebox").TLiteral<"thread">;
                id: import("typebox").TString;
            }>;
            counts: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"as-of">;
                values: import("typebox").TObject<{
                    upvote: import("typebox").TOptional<import("typebox").TInteger>;
                    downvote: import("typebox").TOptional<import("typebox").TInteger>;
                    like: import("typebox").TOptional<import("typebox").TInteger>;
                    love: import("typebox").TOptional<import("typebox").TInteger>;
                    laugh: import("typebox").TOptional<import("typebox").TInteger>;
                    insightful: import("typebox").TOptional<import("typebox").TInteger>;
                    sad: import("typebox").TOptional<import("typebox").TInteger>;
                }>;
                source: import("typebox").TObject<{
                    epoch: import("typebox").TInteger;
                    position: import("typebox").TString;
                }>;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unavailable">;
            }>]>;
            viewer: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"current">;
                reaction: import("typebox").TUnion<[import("typebox").TUnsafe<"downvote" | "insightful" | "laugh" | "like" | "love" | "sad" | "upvote">, import("typebox").TNull]>;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"not-applicable">;
            }>]>;
        }>;
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
        actions: import("typebox").TObject<{
            reply: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"sign-in">, import("typebox").TLiteral<"unavailable">]>;
            react: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"sign-in">, import("typebox").TLiteral<"unavailable">]>;
            share: import("typebox").TLiteral<"available">;
        }>;
    }>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    rankRefreshedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    reactionsAsOf: import("typebox").TUnion<[import("typebox").TObject<{
        epoch: import("typebox").TInteger;
        position: import("typebox").TString;
    }>, import("typebox").TNull]>;
    viewer: import("typebox").TObject<{
        participation: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"sign-in">, import("typebox").TLiteral<"unavailable">]>;
    }>;
    actions: import("typebox").TObject<{
        createThread: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"sign-in">, import("typebox").TLiteral<"unavailable">]>;
    }>;
}>;
/** Private, exact selected inspection; it is not a Board page or command. */
export declare const BoardPinAdviceInputSchema: import("typebox").TObject<{
    selected: import("typebox").TArray<import("typebox").TObject<{
        threadId: import("typebox").TString;
        placeId: import("typebox").TString;
        sourceRevisionId: import("typebox").TString;
    }>>;
    pinRevision: import("typebox").TOptional<import("typebox").TString>;
}>;
export declare const BoardPinAdviceResponseSchema: import("typebox").TUnion<[import("typebox").TObject<{
    state: import("typebox").TLiteral<"stale">;
}>, import("typebox").TObject<{
    state: import("typebox").TLiteral<"ready">;
    viewer: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"account">;
        id: import("typebox").TString;
    }>;
    boardId: import("typebox").TString;
    pinRevision: import("typebox").TString;
    management: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">]>;
    threads: import("typebox").TArray<import("typebox").TObject<{
        threadId: import("typebox").TString;
        pinned: import("typebox").TBoolean;
        actions: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"pin">, import("typebox").TLiteral<"unpin">]>>;
    }>>;
}>]>;
export declare const BoardThreadPinInputSchema: import("typebox").TObject<{
    pinned: import("typebox").TBoolean;
}>;
export declare const BoardThreadPinResponseSchema: import("typebox").TObject<{
    boardId: import("typebox").TString;
    threadId: import("typebox").TString;
    pinned: import("typebox").TBoolean;
    pinPosition: import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>;
}>;
/** The shared sitemap feed shape: every feed pages with an opaque cursor and lists items that carry `lastModified`. */
export declare const SitemapQuerySchema: import("typebox").TObject<{
    cursor: import("typebox").TOptional<import("typebox").TString>;
    limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
}>;
export declare const sitemapLastModified: import("typebox").TString;
export declare function sitemapPageSchema<Item extends TSchema>(item: Item): import("typebox").TObject<{
    items: import("typebox").TArray<Item>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare const SitemapBoardItemSchema: import("typebox").TObject<{
    id: import("typebox").TString;
    lastModified: import("typebox").TString;
}>;
export declare const SitemapThreadItemSchema: import("typebox").TObject<{
    id: import("typebox").TString;
    title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    lastModified: import("typebox").TString;
}>;
export declare const SitemapBoardPageSchema: import("typebox").TObject<{
    items: import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        lastModified: import("typebox").TString;
    }>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare const SitemapThreadPageSchema: import("typebox").TObject<{
    items: import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        lastModified: import("typebox").TString;
    }>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare const SubjectThreadsQuerySchema: import("typebox").TObject<{
    place: import("typebox").TString;
    kind: import("typebox").TUnion<[import("typebox").TLiteral<"discussion">, import("typebox").TLiteral<"review">]>;
    board: import("typebox").TOptional<import("typebox").TString>;
    cursor: import("typebox").TOptional<import("typebox").TString>;
    limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
}>;
export declare const SubjectThreadCardSchema: import("typebox").TUnsafe<Readonly<{
    state: 'current' | 'erased';
    authors: Readonly<{
        thread: Readonly<{
            state: 'current';
            identity: import("./feed-contract.ts").FeedAuthor;
        }> | Readonly<{
            state: 'unavailable';
        }> | Readonly<{
            state: 'withheld';
        }>;
        openingPost: Readonly<{
            state: 'current';
            identity: import("./feed-contract.ts").FeedAuthor;
        }> | Readonly<{
            state: 'unavailable';
        }> | Readonly<{
            state: 'withheld';
        }>;
    }>;
    presentation: Readonly<{
        state: 'current';
        language: string | null;
        spoiler: boolean;
    }> | Readonly<{
        state: 'withheld';
    }>;
    media: Readonly<{
        state: 'none' | 'available' | 'unavailable' | 'withheld';
        images: readonly import("./media-presentation.ts").DocumentImagePresentation[];
    }>;
    comments: Readonly<{
        state: 'current';
        cohort: 'public';
        count: Readonly<{
            kind: 'exact' | 'lower-bound';
            value: number;
        }>;
        lastActivityAt: string | null;
        source: Readonly<{
            epoch: number;
            position: string;
        }>;
    }> | Readonly<{
        state: 'unavailable' | 'withheld';
    }>;
    actions: Readonly<{
        state: 'current' | 'unavailable' | 'not_applicable';
        retryable: boolean;
        references: import("./reading-page.ts").SelectedReadingCardBatchResult['actions']['references'];
    }>;
    reply: Readonly<{
        state: 'available' | 'sign_in_required' | 'denied' | 'withheld' | 'unavailable';
    }>;
    watch: Readonly<{
        state: 'current';
        watching: boolean;
    }> | Readonly<{
        state: 'sign_in_required';
    }> | Readonly<{
        state: 'unavailable';
        retryable: true;
    }> | Readonly<{
        state: 'withheld';
    }>;
    parentContext?: import("./model.ts").FeedParentContext;
    currentness: Readonly<{
        source: 'current';
        place: 'current';
        authors: 'current' | 'unavailable' | 'not_applicable';
        reactions: 'current' | 'unavailable' | 'not_applicable';
        actions: 'current' | 'unavailable' | 'not_applicable';
        watch: 'current' | 'sign_in_required' | 'unavailable' | 'not_applicable';
        media: 'current' | 'unavailable' | 'not_applicable';
        comments: 'current' | 'unavailable' | 'not_applicable';
    }>;
}>>;
export declare const SubjectThreadsResponseSchema: import("typebox").TObject<{
    entry: import("typebox").TUnsafe<SubjectThreadEntry>;
    threads: import("typebox").TArray<import("typebox").TUnsafe<SubjectThreadCardEntry>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    reactionsAsOf: import("typebox").TUnion<[import("typebox").TObject<{
        epoch: import("typebox").TInteger;
        position: import("typebox").TString;
    }>, import("typebox").TNull]>;
    context: import("typebox").TObject<{
        subject: import("typebox").TObject<{
            id: import("typebox").TString;
            label: import("typebox").TUnion<[import("typebox").TObject<{
                value: import("typebox").TString;
                language: import("typebox").TString;
            }>, import("typebox").TNull]>;
            source: import("typebox").TObject<{
                partition: import("typebox").TInteger;
                epoch: import("typebox").TInteger;
                position: import("typebox").TString;
            }>;
        }>;
        place: import("typebox").TUnion<[import("typebox").TObject<{
            kind: import("typebox").TLiteral<"global">;
            id: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"realm">;
            id: import("typebox").TString;
            title: import("typebox").TString;
            spaceId: import("typebox").TString;
            headRevisionId: import("typebox").TString;
        }>]>;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"discussion">, import("typebox").TLiteral<"review">]>;
    }>;
}>;
export declare const AuthorPostsQuerySchema: import("typebox").TObject<{
    cursor: import("typebox").TOptional<import("typebox").TString>;
    limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
}>;
export declare const AuthorThreadsQuerySchema: import("typebox").TObject<{
    cursor: import("typebox").TOptional<import("typebox").TString>;
    limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
    kind: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"discussion">, import("typebox").TLiteral<"review">]>>;
}>;
export declare const AuthorThreadsResponseSchema: import("typebox").TObject<{
    actionSelection: import("typebox").TOptional<import("typebox").TObject<{
        proof: import("typebox").TString;
        references: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
            type: import("typebox").TLiteral<"content.thread">;
            id: import("typebox").TString;
            placeId: import("typebox").TString;
            sourceRevisionId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>, import("typebox").TObject<{
            type: import("typebox").TLiteral<"content.post">;
            id: import("typebox").TString;
            threadId: import("typebox").TString;
            placeId: import("typebox").TString;
            threadRevisionId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            sourceRevisionId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>]>>;
    }>>;
    threads: import("typebox").TArray<import("typebox").TUnsafe<AuthorThreadEntry>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare const AuthorPostsResponseSchema: import("typebox").TObject<{
    actionSelection: import("typebox").TOptional<import("typebox").TObject<{
        proof: import("typebox").TString;
        references: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
            type: import("typebox").TLiteral<"content.thread">;
            id: import("typebox").TString;
            placeId: import("typebox").TString;
            sourceRevisionId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>, import("typebox").TObject<{
            type: import("typebox").TLiteral<"content.post">;
            id: import("typebox").TString;
            threadId: import("typebox").TString;
            placeId: import("typebox").TString;
            threadRevisionId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            sourceRevisionId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>]>>;
    }>>;
    posts: import("typebox").TArray<import("typebox").TUnsafe<AuthorPostEntry>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare const DocumentMediaInputSchema: import("typebox").TObject<{
    ids: import("typebox").TArray<import("typebox").TIntersect<[import("typebox").TString, import("typebox").TString]>>;
}>;
export declare const DocumentImagePresentationSchema: import("typebox").TUnsafe<Readonly<{
    id: string;
    containerId: string;
    digest: string;
    width: number;
    height: number;
    variants: readonly {
        format: 'avif' | 'webp';
        width: number;
        height: number;
    }[];
    placeholder: {
        thumbhash: string;
        color: string;
    } | null;
    focalPoint: {
        x: number;
        y: number;
    } | null;
    credit: import("@rezics/definitions/media-import").MediaImportRequest['credit'] | null;
}>>;
export declare const DocumentMediaPageSchema: import("typebox").TUnsafe<Readonly<{
    images: readonly import("./media-presentation.ts").DocumentImagePresentation[];
}>>;
export declare const MediaReservationInputSchema: import("typebox").TUnion<[import("typebox").TObject<{
    mediaType: import("typebox").TUnion<[import("typebox").TLiteral<"image/avif">, import("typebox").TLiteral<"image/gif">, import("typebox").TLiteral<"image/jpeg">, import("typebox").TLiteral<"image/png">, import("typebox").TLiteral<"image/webp">]>;
    byteCount: import("typebox").TInteger;
    sha256: import("typebox").TOptional<import("typebox").TString>;
    containerId: import("typebox").TString;
    purpose: import("typebox").TUnion<[import("typebox").TLiteral<"post-image">, import("typebox").TLiteral<"avatar">]>;
}>, import("typebox").TObject<{
    mediaType: import("typebox").TUnion<[import("typebox").TLiteral<"image/avif">, import("typebox").TLiteral<"image/gif">, import("typebox").TLiteral<"image/jpeg">, import("typebox").TLiteral<"image/png">, import("typebox").TLiteral<"image/webp">]>;
    byteCount: import("typebox").TInteger;
    sha256: import("typebox").TOptional<import("typebox").TString>;
    newThread: import("typebox").TObject<{
        boardId: import("typebox").TString;
        idempotencyKey: import("typebox").TString;
    }>;
    purpose: import("typebox").TLiteral<"post-image">;
}>]>;
export declare const RealmMediaReservationInputSchema: import("typebox").TObject<{
    mediaType: import("typebox").TUnion<[import("typebox").TLiteral<"image/avif">, import("typebox").TLiteral<"image/gif">, import("typebox").TLiteral<"image/jpeg">, import("typebox").TLiteral<"image/png">, import("typebox").TLiteral<"image/webp">]>;
    byteCount: import("typebox").TInteger;
    sha256: import("typebox").TOptional<import("typebox").TString>;
    purpose: import("typebox").TUnion<[import("typebox").TLiteral<"realm-icon">, import("typebox").TLiteral<"realm-banner">]>;
}>;
export declare const MediaCompletionInputSchema: import("typebox").TObject<{
    containerId: import("typebox").TString;
    reservationRequestId: import("typebox").TString;
    byteCount: import("typebox").TInteger;
    sha256: import("typebox").TString;
}>;
export declare const MediaReservationResponseSchema: import("typebox").TObject<{
    media: import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
        state: import("typebox").TUnion<[import("typebox").TLiteral<"reserved">, import("typebox").TLiteral<"uploaded">, import("typebox").TLiteral<"available">, import("typebox").TLiteral<"rejected">, import("typebox").TLiteral<"erased">]>;
        byteCount: import("typebox").TInteger;
        mediaType: import("typebox").TString;
        sha256: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        containerId: import("typebox").TString;
        uploaderId: import("typebox").TString;
        key: import("typebox").TString;
        reservationRequestId: import("typebox").TString;
    }>, import("typebox").TObject<{
        id: import("typebox").TString;
        state: import("typebox").TUnion<[import("typebox").TLiteral<"reserved">, import("typebox").TLiteral<"uploaded">, import("typebox").TLiteral<"available">, import("typebox").TLiteral<"rejected">, import("typebox").TLiteral<"erased">]>;
        byteCount: import("typebox").TInteger;
        mediaType: import("typebox").TString;
        sha256: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        containerId: import("typebox").TString;
        uploaderId: import("typebox").TString;
        key: import("typebox").TString;
        reservationRequestId: import("typebox").TString;
        purpose: import("typebox").TUnion<[import("typebox").TLiteral<"avatar">, import("typebox").TLiteral<"realm-icon">, import("typebox").TLiteral<"realm-banner">]>;
    }>]>;
}>;
export declare const MediaCompletionResponseSchema: import("typebox").TObject<{
    media: import("typebox").TObject<{
        id: import("typebox").TString;
        state: import("typebox").TLiteral<"uploaded">;
    }>;
}>;
export declare const MediaDownloadQuerySchema: import("typebox").TObject<{
    variant: import("typebox").TString;
}>;
export declare const MediaDownloadResponseSchema: import("typebox").TObject<{
    allowed: import("typebox").TLiteral<true>;
    key: import("typebox").TString;
    sha256: import("typebox").TString;
    mediaType: import("typebox").TString;
    byteCount: import("typebox").TInteger;
    publicCache: import("typebox").TLiteral<false>;
    cacheControl: import("typebox").TUnion<[import("typebox").TLiteral<"private, no-cache">, import("typebox").TLiteral<"private, no-store">]>;
}>;
export declare const AvatarUploadAdviceQuerySchema: import("typebox").TObject<{}>;
export declare const AvatarUploadAdviceResponseSchema: import("typebox").TObject<{
    viewerState: import("typebox").TLiteral<"signed_in">;
    viewer: import("typebox").TObject<{
        accountId: import("typebox").TString;
    }>;
    target: import("typebox").TObject<{
        containerId: import("typebox").TString;
        purpose: import("typebox").TLiteral<"avatar">;
    }>;
    constraints: import("typebox").TObject<{
        mediaTypes: import("typebox").TTuple<[import("typebox").TLiteral<"image/avif">, import("typebox").TLiteral<"image/gif">, import("typebox").TLiteral<"image/jpeg">, import("typebox").TLiteral<"image/png">, import("typebox").TLiteral<"image/webp">]>;
        maxByteCount: import("typebox").TLiteral<20971520>;
    }>;
    allowedActions: import("typebox").TUnion<[import("typebox").TTuple<[import("typebox").TLiteral<"upload">]>, import("typebox").TTuple<[]>]>;
}>;
export type AvatarUploadAdvice = Static<typeof AvatarUploadAdviceResponseSchema>;
export declare const OwnMediaInventoryQuerySchema: import("typebox").TObject<{
    cursor: import("typebox").TOptional<import("typebox").TString>;
}>;
export declare const OwnMediaInventoryEntrySchema: import("typebox").TObject<{
    id: import("typebox").TString;
    purpose: import("typebox").TUnion<[import("typebox").TLiteral<"post-image">, import("typebox").TLiteral<"avatar">, import("typebox").TLiteral<"realm-icon">, import("typebox").TLiteral<"realm-banner">, import("typebox").TLiteral<"cover">]>;
    state: import("typebox").TUnion<[import("typebox").TLiteral<"reserved">, import("typebox").TLiteral<"uploaded">, import("typebox").TLiteral<"available">, import("typebox").TLiteral<"rejected">, import("typebox").TLiteral<"erased">]>;
    declaredMediaType: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    actualMediaType: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    declaredByteCount: import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>;
    actualByteCount: import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>;
    createdAt: import("typebox").TString;
    claimedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    collectionPending: import("typebox").TBoolean;
    takenDown: import("typebox").TBoolean;
    container: import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"post">, import("typebox").TLiteral<"realm">, import("typebox").TLiteral<"account">]>;
    }>, import("typebox").TNull]>;
    actions: import("typebox").TObject<{
        read: import("typebox").TUnion<[import("typebox").TObject<{
            operationId: import("typebox").TLiteral<"media.authorize_download">;
            variants: import("typebox").TArray<import("typebox").TString>;
            recheckAtUse: import("typebox").TLiteral<true>;
        }>, import("typebox").TNull]>;
        remove: import("typebox").TUnion<[import("typebox").TObject<{
            operationId: import("typebox").TLiteral<string>;
        }>, import("typebox").TNull]>;
        resume: import("typebox").TUnion<[import("typebox").TObject<{
            operationId: import("typebox").TLiteral<"media.read_reservation">;
            mode: import("typebox").TUnion<[import("typebox").TLiteral<"same-reservation">, import("typebox").TLiteral<"processing">]>;
            requiresOriginalFile: import("typebox").TLiteral<true>;
        }>, import("typebox").TNull]>;
        retry: import("typebox").TUnion<[import("typebox").TObject<{
            operationId: import("typebox").TLiteral<"media.create">;
            guidance: import("typebox").TLiteral<"choose-new-file">;
        }>, import("typebox").TNull]>;
    }>;
}>;
export declare const OwnMediaInventoryPageSchema: import("typebox").TObject<{
    availability: import("typebox").TLiteral<"available">;
    entries: import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        purpose: import("typebox").TUnion<[import("typebox").TLiteral<"post-image">, import("typebox").TLiteral<"avatar">, import("typebox").TLiteral<"realm-icon">, import("typebox").TLiteral<"realm-banner">, import("typebox").TLiteral<"cover">]>;
        state: import("typebox").TUnion<[import("typebox").TLiteral<"reserved">, import("typebox").TLiteral<"uploaded">, import("typebox").TLiteral<"available">, import("typebox").TLiteral<"rejected">, import("typebox").TLiteral<"erased">]>;
        declaredMediaType: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        actualMediaType: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        declaredByteCount: import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>;
        actualByteCount: import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>;
        createdAt: import("typebox").TString;
        claimedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        collectionPending: import("typebox").TBoolean;
        takenDown: import("typebox").TBoolean;
        container: import("typebox").TUnion<[import("typebox").TObject<{
            id: import("typebox").TString;
            kind: import("typebox").TUnion<[import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"post">, import("typebox").TLiteral<"realm">, import("typebox").TLiteral<"account">]>;
        }>, import("typebox").TNull]>;
        actions: import("typebox").TObject<{
            read: import("typebox").TUnion<[import("typebox").TObject<{
                operationId: import("typebox").TLiteral<"media.authorize_download">;
                variants: import("typebox").TArray<import("typebox").TString>;
                recheckAtUse: import("typebox").TLiteral<true>;
            }>, import("typebox").TNull]>;
            remove: import("typebox").TUnion<[import("typebox").TObject<{
                operationId: import("typebox").TLiteral<string>;
            }>, import("typebox").TNull]>;
            resume: import("typebox").TUnion<[import("typebox").TObject<{
                operationId: import("typebox").TLiteral<"media.read_reservation">;
                mode: import("typebox").TUnion<[import("typebox").TLiteral<"same-reservation">, import("typebox").TLiteral<"processing">]>;
                requiresOriginalFile: import("typebox").TLiteral<true>;
            }>, import("typebox").TNull]>;
            retry: import("typebox").TUnion<[import("typebox").TObject<{
                operationId: import("typebox").TLiteral<"media.create">;
                guidance: import("typebox").TLiteral<"choose-new-file">;
            }>, import("typebox").TNull]>;
        }>;
    }>>;
    nextCursor: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export type OwnMediaInventoryPage = Static<typeof OwnMediaInventoryPageSchema>;
/** Only report lists accept these selectors; unrelated content pages remain unchanged. */
export declare const ReportPageQuerySchema: import("typebox").TObject<{
    cursor: import("typebox").TOptional<import("typebox").TString>;
    limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
    status: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"all">, import("typebox").TLiteral<"pending">, import("typebox").TLiteral<"resolved">]>>;
    targetKind: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"all">, import("typebox").TLiteral<"board">, import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"post">, import("typebox").TLiteral<"subject">, import("typebox").TLiteral<"space">, import("typebox").TLiteral<"realm">]>>;
    order: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"newest">, import("typebox").TLiteral<"oldest">]>>;
}>;
export declare const ReportPageResponseSchema: import("typebox").TObject<{
    reports: import("typebox").TArray<import("typebox").TUnsafe<Readonly<{
        id: import("./model.ts").ReportId;
        partition: number;
        target: import("./reports.ts").ReportTarget;
        revisionId: import("./model.ts").RevisionId | null;
        reason: string;
        evidence: string | null;
        createdAt: string;
        outcome: 'actioned' | 'dismissed' | null;
        resolvedAt: string | null;
        transactionId: string;
        reporterId: string | null;
    }>>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare const CatalogueReportPageQuerySchema: import("typebox").TObject<{
    cursor: import("typebox").TOptional<import("typebox").TString>;
    status: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"all">, import("typebox").TLiteral<"pending">, import("typebox").TLiteral<"resolved">]>>;
    targetKind: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"all">, import("typebox").TLiteral<"board">, import("typebox").TLiteral<"thread">, import("typebox").TLiteral<"post">, import("typebox").TLiteral<"subject">, import("typebox").TLiteral<"space">, import("typebox").TLiteral<"realm">]>>;
    order: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"newest">, import("typebox").TLiteral<"oldest">]>>;
    limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
}>;
export declare const CatalogueReportPageResponseSchema: import("typebox").TObject<{
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    reports: import("typebox").TArray<import("typebox").TUnsafe<Readonly<{
        id: import("./model.ts").ReportId;
        partition: number;
        target: import("./reports.ts").ReportTarget;
        revisionId: import("./model.ts").RevisionId | null;
        reason: string;
        evidence: string | null;
        createdAt: string;
        outcome: 'actioned' | 'dismissed' | null;
        resolvedAt: string | null;
        transactionId: string;
        reporterId: string | null;
    }>>>;
}>;
export declare const ModerationReasonSchema: import("typebox").TObject<{
    reason: import("typebox").TString;
}>;
export declare const ModerationResponseSchema: import("typebox").TObject<{
    securityRevision: import("typebox").TString;
}>;
export declare const AuthorErasureInputSchema: import("typebox").TObject<{
    authorId: import("typebox").TString;
}>;
/** Pending has no result; a completed AIP-151 operation has exactly one arm. */
export declare const OperationSchema: import("typebox").TUnsafe<Operation>;
export declare const ContentEditionInputSchema: import("typebox").TObject<{
    postId: import("typebox").TString;
    revisionId: import("typebox").TString;
    targetSubjectId: import("typebox").TString;
}>;
export declare const EditionSubjectIdentitySchema: import("typebox").TObject<{
    id: import("typebox").TString;
    kind: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"missing">, import("typebox").TLiteral<"withheld">]>;
    label: import("typebox").TUnion<[import("typebox").TObject<{
        value: import("typebox").TString;
        language: import("typebox").TString;
    }>, import("typebox").TNull]>;
}>;
export declare const EditionIdentitySchema: import("typebox").TObject<{
    subject: import("typebox").TObject<{
        id: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"missing">, import("typebox").TLiteral<"withheld">]>;
        label: import("typebox").TUnion<[import("typebox").TObject<{
            value: import("typebox").TString;
            language: import("typebox").TString;
        }>, import("typebox").TNull]>;
    }>;
    revisionCreatedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare const EditionSourceIdentitySchema: import("typebox").TObject<{
    postId: import("typebox").TString;
    revisionId: import("typebox").TString;
    sha256: import("typebox").TString;
    revisionCreatedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    subjects: import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"missing">, import("typebox").TLiteral<"withheld">]>;
        label: import("typebox").TUnion<[import("typebox").TObject<{
            value: import("typebox").TString;
            language: import("typebox").TString;
        }>, import("typebox").TNull]>;
    }>>;
}>;
export declare const ContentEditionSchema: import("typebox").TObject<{
    editionId: import("typebox").TString;
    identity: import("typebox").TOptional<import("typebox").TObject<{
        subject: import("typebox").TObject<{
            id: import("typebox").TString;
            kind: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"missing">, import("typebox").TLiteral<"withheld">]>;
            label: import("typebox").TUnion<[import("typebox").TObject<{
                value: import("typebox").TString;
                language: import("typebox").TString;
            }>, import("typebox").TNull]>;
        }>;
        revisionCreatedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>>;
    editionRevision: import("typebox").TString;
    state: import("typebox").TUnion<[import("typebox").TLiteral<"draft">, import("typebox").TLiteral<"published">, import("typebox").TLiteral<"withdrawn">]>;
    targetSubjectId: import("typebox").TString;
    creatorAccountId: import("typebox").TString;
    revisionId: import("typebox").TString;
    sha256: import("typebox").TString;
    licence: import("typebox").TString;
}>;
export declare const ContentEditionRevisionSchema: import("typebox").TObject<{
    editionId: import("typebox").TString;
    revisionId: import("typebox").TString;
    sha256: import("typebox").TString;
    licence: import("typebox").TString;
    body: import("typebox").TUnion<[TSchema, TSchema]>;
}>;
export declare const ContentEditionCommandSchema: import("typebox").TObject<{
    editionId: import("typebox").TString;
    editionRevision: import("typebox").TString;
}>;
/** Private account-home metadata; full document bytes are selected separately. */
export declare const OwnDraftQuerySchema: import("typebox").TObject<{
    cursor: import("typebox").TOptional<import("typebox").TString>;
    limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
}>;
export declare const OwnDraftEntrySchema: import("typebox").TUnsafe<OwnDraftEntry>;
export declare const OwnDraftResponseSchema: import("typebox").TObject<{
    state: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"preparing">]>;
    viewer: import("typebox").TObject<{
        accountId: import("typebox").TString;
        authnEpoch: import("typebox").TInteger;
    }>;
    drafts: import("typebox").TArray<import("typebox").TUnsafe<OwnDraftEntry>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
