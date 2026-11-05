import { readAccountDiscoverySummaries } from '../access/account-discovery-source.ts';
import { type ViewerActionBindings } from '../access/viewer-actions.ts';
import type { Access, Actor } from '../request/access.ts';
import type { ContentReadDependencies, PostEntry } from './reads.ts';
import type { AnchoredPosition } from './model.ts';
import type { ViewerActionResources } from '../access/viewer-actions.ts';
export declare const READING_PAGE_REPLY_LIMIT = 20;
export declare const READING_PAGE_REQUEST_BYTES: number;
export declare const READING_CARD_REFERENCE_LIMIT = 20;
export declare const READING_PAGE_RESPONSE_BYTES: number;
export declare const ReadingPageQuerySchema: import("typebox").TObject<{
    cursor: import("typebox").TOptional<import("typebox").TString>;
}>;
export declare const ReadingPageResponseSchema: import("typebox").TObject<{
    target: import("typebox").TObject<{
        threadId: import("typebox").TString;
        boardId: import("typebox").TString;
        boardSecurityRevision: import("typebox").TString;
    }>;
    viewer: import("typebox").TUnion<[import("typebox").TObject<{
        kind: import("typebox").TLiteral<"anonymous">;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"account">;
        id: import("typebox").TString;
    }>]>;
    query: import("typebox").TObject<{
        cursor: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        limit: import("typebox").TLiteral<20>;
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
        firstPost: PostEntry;
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
    conversationActivity: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"current">;
        cohort: import("typebox").TLiteral<"public">;
        count: import("typebox").TObject<{
            kind: import("typebox").TUnion<[import("typebox").TLiteral<"exact">, import("typebox").TLiteral<"lower-bound">]>;
            value: import("typebox").TInteger;
        }>;
        lastActivityAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"withheld">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
        retryable: import("typebox").TLiteral<true>;
    }>]>;
    documentMedia: import("typebox").TUnsafe<Readonly<{
        state: 'available' | 'unavailable' | 'overflow';
        documents: readonly import("./reading-page-documents.ts").ReadingPageDocument[];
    }>>;
    replies: import("typebox").TObject<{
        items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TUnsafe<import("./reads.ts").ItemView & {
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
        }>, import("typebox").TObject<{
            id: import("typebox").TString;
            threadId: import("typebox").TString;
            route: import("typebox").TInteger;
            parentId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            removed: import("typebox").TLiteral<true>;
            availability: import("typebox").TLiteral<"erased">;
            restorableUntil: import("typebox").TOptional<import("typebox").TString>;
            body: import("typebox").TNull;
            sha256: import("typebox").TNull;
        }>, import("typebox").TObject<{
            id: import("typebox").TString;
            threadId: import("typebox").TString;
            route: import("typebox").TInteger;
            parentId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            removed: import("typebox").TLiteral<true>;
            availability: import("typebox").TLiteral<"withheld">;
            body: import("typebox").TNull;
            sha256: import("typebox").TNull;
        }>]>>;
        next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
    authors: import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        retryable: import("typebox").TBoolean;
        items: import("typebox").TArray<import("typebox").TUnsafe<AuthorView>>;
    }>;
    mentions: import("typebox").TOptional<import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        retryable: import("typebox").TBoolean;
        overflow: import("typebox").TBoolean;
        sources: import("typebox").TArray<import("typebox").TObject<{
            postId: import("typebox").TString;
            threadId: import("typebox").TString;
            revisionId: import("typebox").TString;
            sha256: import("typebox").TString;
            pageIndex: import("typebox").TInteger;
            references: import("typebox").TArray<import("typebox").TString>;
            overflow: import("typebox").TBoolean;
        }>>;
        identities: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
            id: import("typebox").TString;
            state: import("typebox").TLiteral<"active">;
            handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>, import("typebox").TObject<{
            id: import("typebox").TString;
            state: import("typebox").TLiteral<"concealed">;
        }>, import("typebox").TObject<{
            id: import("typebox").TString;
            state: import("typebox").TLiteral<"erased">;
        }>]>>;
    }>>;
    actions: import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        retryable: import("typebox").TBoolean;
        references: import("typebox").TArray<import("typebox").TObject<{
            type: import("typebox").TUnion<[import("typebox").TLiteral<"content.thread">, import("typebox").TLiteral<"content.post">]>;
            id: import("typebox").TString;
            sourceRevisionId: import("typebox").TOptional<import("typebox").TString>;
            state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"withheld">]>;
            operations: import("typebox").TArray<import("typebox").TObject<{
                action: import("typebox").TString;
                operationId: import("typebox").TString;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"sign_in_required">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"withheld">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"not_applicable">]>;
            }>>;
        }>>;
        reply: import("typebox").TObject<{
            state: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"sign_in_required">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"withheld">, import("typebox").TLiteral<"unavailable">]>;
        }>;
    }>;
    watch: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"current">;
        watching: import("typebox").TBoolean;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"sign_in_required">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
        retryable: import("typebox").TLiteral<true>;
    }>]>;
    slowMode: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"current">;
        intervalSeconds: import("typebox").TInteger;
        retryAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        nextEligibleAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        canChange: import("typebox").TBoolean;
        exempt: import("typebox").TBoolean;
        admissionState: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"interval">, import("typebox").TLiteral<"pending">]>;
        retryAfterSeconds: import("typebox").TInteger;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
        retryable: import("typebox").TLiteral<true>;
    }>]>;
    currentness: import("typebox").TObject<{
        source: import("typebox").TLiteral<"current">;
        place: import("typebox").TLiteral<"current">;
        reactions: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        authors: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        actions: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        watch: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"sign_in_required">, import("typebox").TLiteral<"unavailable">]>;
        slowMode: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
    }>;
    reactionsAsOf: import("typebox").TUnion<[import("typebox").TObject<{
        epoch: import("typebox").TInteger;
        position: import("typebox").TString;
    }>, import("typebox").TNull]>;
    reviewContext: import("typebox").TOptional<import("typebox").TObject<{
        source: import("typebox").TObject<{
            threadId: import("typebox").TString;
            postId: import("typebox").TString;
            revisionId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>;
        target: import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"available">;
            subject: import("typebox").TObject<{
                id: import("typebox").TString;
                kind: import("typebox").TString;
                label: import("typebox").TUnion<[import("typebox").TObject<{
                    value: import("typebox").TString;
                    language: import("typebox").TString;
                }>, import("typebox").TNull]>;
            }>;
        }>, import("typebox").TObject<{
            state: import("typebox").TUnion<[import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
        }>]>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
        }>]>;
        citations: import("typebox").TObject<{
            state: import("typebox").TLiteral<"current">;
            items: import("typebox").TArray<import("typebox").TObject<{
                postId: import("typebox").TString;
                sourceRevisionId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                citation: import("typebox").TUnion<[import("typebox").TObject<{
                    state: import("typebox").TLiteral<"available">;
                    questionId: import("typebox").TString;
                    units: import("typebox").TInteger;
                    voteRevision: import("typebox").TInteger;
                    metadata: import("typebox").TObject<{
                        state: import("typebox").TLiteral<"unavailable">;
                    }>;
                }>, import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
                }>]>;
            }>>;
        }>;
    }>>;
    authorErasure: import("typebox").TOptional<import("typebox").TObject<{
        authorId: import("typebox").TString;
        mayErase: import("typebox").TBoolean;
    }>>;
}>;
export type ReadingPageViewerActionRuntime = Readonly<{
    access: Access;
    resources: ViewerActionResources;
    bindings: ViewerActionBindings;
    guestSecurity: ReadonlyMap<string, 'anonymous' | 'authenticated' | 'unknown'>;
    clock: () => Date;
}>;
export type ReadingPageDependencies = ContentReadDependencies & Readonly<{
    routeKey: Uint8Array;
    viewerActionRuntime?: () => ReadingPageViewerActionRuntime;
}>;
/** A consumer-selected, exact native reference. Subject selections retain their Subject key and place. */
export type SelectedReadingCardReference = Readonly<{
    type: 'content.thread';
    id: string;
    placeId: string;
    sourceRevisionId: string | null;
    subjectId?: string;
}> | Readonly<{
    type: 'content.post';
    id: string;
    threadId: string;
    placeId: string;
    threadRevisionId: string | null;
    sourceRevisionId: string | null;
}>;
export type SelectedReadingCardBatchResult = Readonly<{
    viewer: {
        kind: 'anonymous';
    } | {
        kind: 'account';
        id: string;
    };
    selected: readonly Readonly<{
        reference: SelectedReadingCardReference;
        state: 'current' | 'erased' | 'withheld';
        reply: Readonly<{
            state: 'available' | 'sign_in_required' | 'denied' | 'withheld' | 'unavailable';
        }>;
        source?: Readonly<{
            threadId: string;
            placeId: string;
            sourceRevisionId: string | null;
            threadSecurityRevision: string;
            sourceSecurityRevision: string | null;
            placeSecurityRevision: string;
        }>;
    }>[];
    authors: Readonly<{
        state: 'current' | 'unavailable';
        retryable: boolean;
        items: readonly AuthorView[];
    }>;
    reactions: Readonly<{
        state: 'current' | 'unavailable';
        retryable: boolean;
        items: readonly SelectedReadingCardReaction[];
        reactionsAsOf: Readonly<{
            epoch: number;
            position: string;
        }> | null;
    }>;
    actions: Readonly<{
        state: 'current' | 'unavailable';
        retryable: boolean;
        references: readonly ReadingReference[];
    }>;
    watch: Readonly<{
        state: 'current' | 'sign_in_required' | 'unavailable';
        retryable: boolean;
        items: readonly Readonly<{
            threadId: string;
            state: 'current' | 'sign_in_required' | 'unavailable';
            watching?: boolean;
        }>[];
    }>;
    currentness: Readonly<{
        source: 'current';
        place: 'current';
        reactions: 'current' | 'unavailable';
        authors: 'current' | 'unavailable';
        actions: 'current' | 'unavailable';
        watch: 'current' | 'sign_in_required' | 'unavailable';
    }>;
    anchors: readonly AnchoredPosition[];
}>;
export type SelectedReadingCardReaction = Readonly<{
    type: 'content.thread' | 'content.post';
    id: string;
    state: 'current' | 'unavailable' | 'not_applicable';
    counts?: Readonly<Partial<Record<string, number>>>;
    viewerSelection?: string | null;
}>;
export type ContentReadingCardBatch = Readonly<{
    selected: readonly SelectedReadingCardReference[];
    finish(): Promise<SelectedReadingCardBatchResult>;
}>;
type AccountSummaryMap = Awaited<ReturnType<typeof readAccountDiscoverySummaries>>;
type AccountSummaryValue = AccountSummaryMap extends ReadonlyMap<string, infer Value> ? Value : never;
type AccountSummary = NonNullable<AccountSummaryValue>;
type AuthorView = Pick<AccountSummary, 'id' | 'displayName' | 'handle' | 'avatar'>;
type ControlState = 'available' | 'sign_in_required' | 'denied' | 'withheld' | 'unavailable' | 'not_applicable';
type OperationState = Exclude<ControlState, 'withheld'>;
type ReadingOperation = {
    action: string;
    operationId: string;
    state: OperationState;
};
type ReadingReference = {
    type: 'content.thread' | 'content.post';
    id: string;
    sourceRevisionId?: string;
    state: 'current' | 'withheld';
    operations: ReadingOperation[];
};
export declare function readingPageEntryWitness(entry: PostEntry): string;
export declare function readingPageOperationState(actor: Actor, operationId: string, allowed: ReadonlySet<string>, guestSecurity: ReadonlyMap<string, 'anonymous' | 'authenticated' | 'unknown'>, watch: {
    state: 'current';
    watching: boolean;
} | {
    state: 'sign_in_required';
} | {
    state: 'unavailable';
    retryable: true;
}): OperationState;
/** Validate the raw selection before any native reads; exact duplicates collapse in first-seen order. */
export declare function normalizeSelectedReadingCardReferences(selected: readonly SelectedReadingCardReference[]): readonly SelectedReadingCardReference[];
/** A missing native total row is unknown coverage, not an exact zero. */
export declare function readingPageReactionCoverageState(targetIds: readonly string[], coveredTargetIds: ReadonlySet<string>): 'current' | 'unavailable';
/**
 * Select up to twenty exact thread/post cards, hydrate their shared personal state once, then let
 * the owner append its parent/Subject context before calling the returned final currentness seam.
 */
export declare function createContentReadingCardBatch(dependencies: ReadingPageDependencies, selected: readonly SelectedReadingCardReference[], actor: Actor, deadline: number): Promise<ContentReadingCardBatch>;
/** Opening consumes one list slot only on the first page; continuations are already past it. */
export declare function readingPageRawLimit(cursor?: string): number;
/** One disclosed opening plus the next raw native reply interval, with bounded personal state. */
export declare function readContentReadingPage(dependencies: ReadingPageDependencies, threadId: string, actor: Actor, deadline: number, cursor?: string): Promise<{
    value: {
        target: {
            threadId: string;
            boardId: string;
            boardSecurityRevision: string;
        };
        viewer: {
            kind: "anonymous";
        } | {
            kind: "account";
            id: string;
        };
        query: {
            cursor: string | null;
            limit: 20;
        };
        thread: Omit<Readonly<{
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
        }>;
        conversationActivity: {
            state: "current";
            cohort: "public";
            count: {
                kind: "exact" | "lower-bound";
                value: number;
            };
            lastActivityAt: string | null;
        } | {
            state: "withheld";
        } | {
            state: "unavailable";
            retryable: true;
        };
        documentMedia: Readonly<{
            state: 'available' | 'unavailable' | 'overflow';
            documents: readonly import("./reading-page-documents.ts").ReadingPageDocument[];
        }>;
        replies: {
            items: ({
                id: string;
                threadId: string;
                route: number;
                parentId: string | null;
                removed: true;
                availability: "withheld";
                body: null;
                sha256: null;
            } | {
                id: string;
                threadId: string;
                route: number;
                parentId: string | null;
                removed: true;
                availability: "erased";
                restorableUntil?: string;
                body: null;
                sha256: null;
            } | (import("./reads.ts").ItemView & {
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
            }))[];
            next: string | null;
        };
        authors: {
            state: "current" | "unavailable";
            retryable: boolean;
            items: AuthorView[];
        };
        mentions?: {
            state: "current" | "unavailable";
            retryable: boolean;
            overflow: boolean;
            sources: {
                postId: string;
                threadId: string;
                revisionId: string;
                sha256: string;
                pageIndex: number;
                references: string[];
                overflow: boolean;
            }[];
            identities: ({
                id: string;
                state: "active";
                handle: string | null;
            } | {
                id: string;
                state: "concealed";
            } | {
                id: string;
                state: "erased";
            })[];
        };
        actions: {
            state: "current" | "unavailable";
            retryable: boolean;
            references: {
                type: "content.post" | "content.thread";
                id: string;
                sourceRevisionId?: string;
                state: "current" | "withheld";
                operations: {
                    action: string;
                    operationId: string;
                    state: "available" | "denied" | "not_applicable" | "sign_in_required" | "unavailable" | "withheld";
                }[];
            }[];
            reply: {
                state: "available" | "denied" | "sign_in_required" | "unavailable" | "withheld";
            };
        };
        watch: {
            state: "current";
            watching: boolean;
        } | {
            state: "sign_in_required";
        } | {
            state: "unavailable";
            retryable: true;
        };
        slowMode: {
            state: "current";
            intervalSeconds: number;
            retryAt: string | null;
            nextEligibleAt: string | null;
            canChange: boolean;
            exempt: boolean;
            admissionState: "interval" | "pending" | "ready";
            retryAfterSeconds: number;
        } | {
            state: "unavailable";
            retryable: true;
        };
        currentness: {
            source: "current";
            place: "current";
            reactions: "current" | "unavailable";
            authors: "current" | "unavailable";
            actions: "current" | "unavailable";
            watch: "current" | "sign_in_required" | "unavailable";
            slowMode: "current" | "unavailable";
        };
        reactionsAsOf: {
            epoch: number;
            position: string;
        } | null;
        reviewContext?: {
            source: {
                threadId: string;
                postId: string;
                revisionId: string | null;
            };
            target: {
                state: "available";
                subject: {
                    id: string;
                    kind: string;
                    label: {
                        value: string;
                        language: string;
                    } | null;
                };
            } | {
                state: "absent" | "withheld";
            } | {
                state: "unavailable";
            };
            citations: {
                state: "current";
                items: {
                    postId: string;
                    sourceRevisionId: string | null;
                    citation: {
                        state: "available";
                        questionId: string;
                        units: number;
                        voteRevision: number;
                        metadata: {
                            state: "unavailable";
                        };
                    } | {
                        state: "absent" | "withheld";
                    };
                }[];
            };
        };
        authorErasure?: {
            authorId: string;
            mayErase: boolean;
        };
    };
    anchors: Readonly<{
        partition: import("../partition/partition.ts").Partition;
        epoch: number;
        position: bigint;
    }>[];
}>;
export {};
