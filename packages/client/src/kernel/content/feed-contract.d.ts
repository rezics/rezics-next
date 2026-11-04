import type { Static } from 'typebox';
import type { ThreadView } from './reads.ts';
import type { ItemView } from './model.ts';
import type { AccountDiscoverySummary } from '../search/discovery.ts';
import type { CollectionResourceView } from '../library/collection-reads.ts';
import type { ViewerReactionKind } from './reads.ts';
import type { ReactionTarget } from './reactions.ts';
import type { FeedParentContext, FeedReviewContext } from './model.ts';
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
};
export type FeedConversationActivity = Readonly<{
    state: 'current';
    cohort: 'public';
    count: ConversationActivityReplyCount;
    lastActivityAt: string | null;
}> | Readonly<{
    state: 'withheld';
}>;
export type ConversationActivityReplyCount = Readonly<{
    kind: 'exact';
    value: number;
} | {
    kind: 'lower-bound';
    value: number;
}>;
export declare const FeedItemSchema: import("typebox").TUnion<[import("typebox").TObject<{
    id: import("typebox").TString;
    occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    source: import("typebox").TLiteral<"discovery">;
    key: import("typebox").TObject<{
        owner: import("typebox").TLiteral<"semantic">;
        kind: import("typebox").TString;
        route: import("typebox").TInteger;
        id: import("typebox").TString;
    }>;
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
            credit: import("typebox").TObject<{
                rightsHolder: import("typebox").TString;
                via: import("typebox").TObject<{
                    name: import("typebox").TString;
                    url: import("typebox").TString;
                }>;
                license: import("typebox").TString;
                obligations: import("typebox").TArray<import("typebox").TString>;
            }>;
        }>, import("typebox").TNull]>;
        subjectReactions: import("typebox").TOptional<import("typebox").TObject<{
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
        }>>;
    }>;
    destination: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"subject">;
        id: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    source: import("typebox").TLiteral<"discovery">;
    key: import("typebox").TObject<{
        owner: import("typebox").TLiteral<"accounts">;
        kind: import("typebox").TLiteral<"account">;
        route: import("typebox").TInteger;
        id: import("typebox").TString;
    }>;
    summary: import("typebox").TUnsafe<AccountDiscoverySummary>;
    destination: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"account">;
        id: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    source: import("typebox").TLiteral<"discovery">;
    key: import("typebox").TObject<{
        owner: import("typebox").TLiteral<"commerce">;
        kind: import("typebox").TLiteral<"collection">;
        route: import("typebox").TInteger;
        id: import("typebox").TString;
    }>;
    summary: import("typebox").TUnsafe<Readonly<{
        id: string;
        title: string;
        description: string | null;
        card: import("../library/collection-discovery-summaries.ts").PublicCollectionDiscoverySummary;
    }>>;
    destination: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"collection">;
        id: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    source: import("typebox").TLiteral<"discovery">;
    key: import("typebox").TObject<{
        owner: import("typebox").TLiteral<"content">;
        kind: import("typebox").TLiteral<"review">;
        route: import("typebox").TInteger;
        id: import("typebox").TString;
    }>;
    summary: import("typebox").TUnsafe<Readonly<{
        id: string;
        kind: 'review';
        title: string | null;
        author?: Readonly<{
            displayName: string | null;
            handle: string | null;
        }>;
        excerpt?: string;
        subject?: Readonly<{
            id: string;
            title: string | null;
        }> | null;
    }> & Pick<FeedContentSummary, "conversationActivity" | "reactionTarget" | "reactions" | "reviewContext" | "viewerReaction">>;
    destination: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"thread">;
        id: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    source: import("typebox").TLiteral<"discovery">;
    key: import("typebox").TObject<{
        owner: import("typebox").TLiteral<"content">;
        kind: import("typebox").TLiteral<"space">;
        route: import("typebox").TInteger;
        id: import("typebox").TString;
    }>;
    summary: import("typebox").TUnsafe<Readonly<{
        id: string;
        title: string;
        address: string;
        summary?: string;
        realm?: Readonly<{
            id: string;
            title: string | null;
        }> | null;
    }>>;
    destination: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"space">;
        id: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        address: import("typebox").TString;
    }>;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    source: import("typebox").TLiteral<"continue">;
    key: import("typebox").TObject<{
        owner: import("typebox").TLiteral<"semantic">;
        kind: import("typebox").TString;
        route: import("typebox").TInteger;
        id: import("typebox").TString;
    }>;
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
            credit: import("typebox").TObject<{
                rightsHolder: import("typebox").TString;
                via: import("typebox").TObject<{
                    name: import("typebox").TString;
                    url: import("typebox").TString;
                }>;
                license: import("typebox").TString;
                obligations: import("typebox").TArray<import("typebox").TString>;
            }>;
        }>, import("typebox").TNull]>;
        subjectReactions: import("typebox").TOptional<import("typebox").TObject<{
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
        }>>;
    }>;
    destination: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"subject">;
        id: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
    continue: import("typebox").TObject<{
        subjectId: import("typebox").TString;
        state: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        lastActivityAt: import("typebox").TString;
        activeProgressSession: import("typebox").TUnion<[import("typebox").TObject<{
            id: import("typebox").TString;
            subjectId: import("typebox").TString;
            versionSubjectId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            mode: import("typebox").TUnion<[import("typebox").TLiteral<"scalar_amount">, import("typebox").TLiteral<"cursor_position">, import("typebox").TLiteral<"completed_units">]>;
            unit: import("typebox").TString;
            total: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            amount: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            locator: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            position: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            completedUnitCount: import("typebox").TInteger;
            state: import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"completed">, import("typebox").TLiteral<"abandoned">]>, import("typebox").TLiteral<"retired">]>;
            revision: import("typebox").TInteger;
            startedAt: import("typebox").TString;
            completedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            measures: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                unit: import("typebox").TString;
                amount: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                total: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                presentation: import("typebox").TOptional<import("typebox").TUnsafe<Readonly<{
                    meaning: 'known' | 'unknown' | 'unavailable';
                    unitLabel?: string;
                    unitLabelLanguage?: string;
                    unitCountForms?: Readonly<import("@rezics/definitions").LibraryCountForms>;
                    dimension?: string;
                    structure: 'unverified';
                    recording: Readonly<{
                        state: 'supported';
                        inputRules: import("../library/progress-model.ts").ProgressInputRules;
                    } | {
                        state: 'unsupported' | 'unavailable';
                    }>;
                }>>>;
            }>>>;
        }>, import("typebox").TNull]>;
        subject: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
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
                credit: import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TString>;
                }>;
            }>, import("typebox").TNull]>;
        }>, import("typebox").TNull]>>;
    }>;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    source: import("typebox").TLiteral<"following">;
    key: import("typebox").TObject<{
        owner: import("typebox").TLiteral<"semantic">;
        kind: import("typebox").TString;
        route: import("typebox").TInteger;
        id: import("typebox").TString;
    }>;
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
            credit: import("typebox").TObject<{
                rightsHolder: import("typebox").TString;
                via: import("typebox").TObject<{
                    name: import("typebox").TString;
                    url: import("typebox").TString;
                }>;
                license: import("typebox").TString;
                obligations: import("typebox").TArray<import("typebox").TString>;
            }>;
        }>, import("typebox").TNull]>;
        subjectReactions: import("typebox").TOptional<import("typebox").TObject<{
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
        }>>;
    }>;
    destination: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"subject">;
        id: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    source: import("typebox").TLiteral<"following">;
    key: import("typebox").TObject<{
        owner: import("typebox").TLiteral<"content">;
        kind: import("typebox").TLiteral<"thread">;
        route: import("typebox").TInteger;
        id: import("typebox").TString;
    }>;
    summary: import("typebox").TUnsafe<Pick<ThreadView, "createdAt" | "id" | "kind" | "title"> & FeedContentSummary>;
    destination: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"thread">;
        id: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    source: import("typebox").TLiteral<"following">;
    key: import("typebox").TObject<{
        owner: import("typebox").TLiteral<"content">;
        kind: import("typebox").TLiteral<"post">;
        route: import("typebox").TInteger;
        id: import("typebox").TString;
    }>;
    summary: import("typebox").TUnsafe<Pick<ItemView, "createdAt" | "id" | "threadId"> & Pick<ThreadView, "title"> & FeedContentSummary & {
        parentContext?: FeedParentContext;
    }>;
    destination: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"post">;
        id: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        threadId: import("typebox").TString;
        postId: import("typebox").TString;
    }>;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    source: import("typebox").TLiteral<"following">;
    key: import("typebox").TObject<{
        owner: import("typebox").TLiteral<"library">;
        kind: import("typebox").TLiteral<"collection">;
        route: import("typebox").TInteger;
        id: import("typebox").TString;
    }>;
    summary: import("typebox").TUnsafe<Pick<CollectionResourceView, "description" | "id" | "title">>;
    destination: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"collection">;
        id: import("typebox").TString;
        title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
}>]>;
export declare const FeedSourceStateSchema: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"preparing">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"not_requested">]>;
export declare const FeedPageSchema: import("typebox").TObject<{
    feedItems: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
        occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        source: import("typebox").TLiteral<"discovery">;
        key: import("typebox").TObject<{
            owner: import("typebox").TLiteral<"semantic">;
            kind: import("typebox").TString;
            route: import("typebox").TInteger;
            id: import("typebox").TString;
        }>;
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
                credit: import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TString>;
                }>;
            }>, import("typebox").TNull]>;
            subjectReactions: import("typebox").TOptional<import("typebox").TObject<{
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
            }>>;
        }>;
        destination: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"subject">;
            id: import("typebox").TString;
            title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>;
    }>, import("typebox").TObject<{
        id: import("typebox").TString;
        occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        source: import("typebox").TLiteral<"discovery">;
        key: import("typebox").TObject<{
            owner: import("typebox").TLiteral<"accounts">;
            kind: import("typebox").TLiteral<"account">;
            route: import("typebox").TInteger;
            id: import("typebox").TString;
        }>;
        summary: import("typebox").TUnsafe<AccountDiscoverySummary>;
        destination: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"account">;
            id: import("typebox").TString;
            title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>;
    }>, import("typebox").TObject<{
        id: import("typebox").TString;
        occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        source: import("typebox").TLiteral<"discovery">;
        key: import("typebox").TObject<{
            owner: import("typebox").TLiteral<"commerce">;
            kind: import("typebox").TLiteral<"collection">;
            route: import("typebox").TInteger;
            id: import("typebox").TString;
        }>;
        summary: import("typebox").TUnsafe<Readonly<{
            id: string;
            title: string;
            description: string | null;
            card: import("../library/collection-discovery-summaries.ts").PublicCollectionDiscoverySummary;
        }>>;
        destination: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"collection">;
            id: import("typebox").TString;
            title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>;
    }>, import("typebox").TObject<{
        id: import("typebox").TString;
        occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        source: import("typebox").TLiteral<"discovery">;
        key: import("typebox").TObject<{
            owner: import("typebox").TLiteral<"content">;
            kind: import("typebox").TLiteral<"review">;
            route: import("typebox").TInteger;
            id: import("typebox").TString;
        }>;
        summary: import("typebox").TUnsafe<Readonly<{
            id: string;
            kind: 'review';
            title: string | null;
            author?: Readonly<{
                displayName: string | null;
                handle: string | null;
            }>;
            excerpt?: string;
            subject?: Readonly<{
                id: string;
                title: string | null;
            }> | null;
        }> & Pick<FeedContentSummary, "conversationActivity" | "reactionTarget" | "reactions" | "reviewContext" | "viewerReaction">>;
        destination: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"thread">;
            id: import("typebox").TString;
            title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>;
    }>, import("typebox").TObject<{
        id: import("typebox").TString;
        occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        source: import("typebox").TLiteral<"discovery">;
        key: import("typebox").TObject<{
            owner: import("typebox").TLiteral<"content">;
            kind: import("typebox").TLiteral<"space">;
            route: import("typebox").TInteger;
            id: import("typebox").TString;
        }>;
        summary: import("typebox").TUnsafe<Readonly<{
            id: string;
            title: string;
            address: string;
            summary?: string;
            realm?: Readonly<{
                id: string;
                title: string | null;
            }> | null;
        }>>;
        destination: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"space">;
            id: import("typebox").TString;
            title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            address: import("typebox").TString;
        }>;
    }>, import("typebox").TObject<{
        id: import("typebox").TString;
        occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        source: import("typebox").TLiteral<"continue">;
        key: import("typebox").TObject<{
            owner: import("typebox").TLiteral<"semantic">;
            kind: import("typebox").TString;
            route: import("typebox").TInteger;
            id: import("typebox").TString;
        }>;
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
                credit: import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TString>;
                }>;
            }>, import("typebox").TNull]>;
            subjectReactions: import("typebox").TOptional<import("typebox").TObject<{
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
            }>>;
        }>;
        destination: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"subject">;
            id: import("typebox").TString;
            title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>;
        continue: import("typebox").TObject<{
            subjectId: import("typebox").TString;
            state: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            lastActivityAt: import("typebox").TString;
            activeProgressSession: import("typebox").TUnion<[import("typebox").TObject<{
                id: import("typebox").TString;
                subjectId: import("typebox").TString;
                versionSubjectId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                mode: import("typebox").TUnion<[import("typebox").TLiteral<"scalar_amount">, import("typebox").TLiteral<"cursor_position">, import("typebox").TLiteral<"completed_units">]>;
                unit: import("typebox").TString;
                total: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                amount: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                locator: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                position: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                completedUnitCount: import("typebox").TInteger;
                state: import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"completed">, import("typebox").TLiteral<"abandoned">]>, import("typebox").TLiteral<"retired">]>;
                revision: import("typebox").TInteger;
                startedAt: import("typebox").TString;
                completedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                measures: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    unit: import("typebox").TString;
                    amount: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    total: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    presentation: import("typebox").TOptional<import("typebox").TUnsafe<Readonly<{
                        meaning: 'known' | 'unknown' | 'unavailable';
                        unitLabel?: string;
                        unitLabelLanguage?: string;
                        unitCountForms?: Readonly<import("@rezics/definitions").LibraryCountForms>;
                        dimension?: string;
                        structure: 'unverified';
                        recording: Readonly<{
                            state: 'supported';
                            inputRules: import("../library/progress-model.ts").ProgressInputRules;
                        } | {
                            state: 'unsupported' | 'unavailable';
                        }>;
                    }>>>;
                }>>>;
            }>, import("typebox").TNull]>;
            subject: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
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
                    credit: import("typebox").TObject<{
                        rightsHolder: import("typebox").TString;
                        via: import("typebox").TObject<{
                            name: import("typebox").TString;
                            url: import("typebox").TString;
                        }>;
                        license: import("typebox").TString;
                        obligations: import("typebox").TArray<import("typebox").TString>;
                    }>;
                }>, import("typebox").TNull]>;
            }>, import("typebox").TNull]>>;
        }>;
    }>, import("typebox").TObject<{
        id: import("typebox").TString;
        occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        source: import("typebox").TLiteral<"following">;
        key: import("typebox").TObject<{
            owner: import("typebox").TLiteral<"semantic">;
            kind: import("typebox").TString;
            route: import("typebox").TInteger;
            id: import("typebox").TString;
        }>;
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
                credit: import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TString>;
                }>;
            }>, import("typebox").TNull]>;
            subjectReactions: import("typebox").TOptional<import("typebox").TObject<{
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
            }>>;
        }>;
        destination: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"subject">;
            id: import("typebox").TString;
            title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>;
    }>, import("typebox").TObject<{
        id: import("typebox").TString;
        occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        source: import("typebox").TLiteral<"following">;
        key: import("typebox").TObject<{
            owner: import("typebox").TLiteral<"content">;
            kind: import("typebox").TLiteral<"thread">;
            route: import("typebox").TInteger;
            id: import("typebox").TString;
        }>;
        summary: import("typebox").TUnsafe<Pick<ThreadView, "createdAt" | "id" | "kind" | "title"> & FeedContentSummary>;
        destination: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"thread">;
            id: import("typebox").TString;
            title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>;
    }>, import("typebox").TObject<{
        id: import("typebox").TString;
        occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        source: import("typebox").TLiteral<"following">;
        key: import("typebox").TObject<{
            owner: import("typebox").TLiteral<"content">;
            kind: import("typebox").TLiteral<"post">;
            route: import("typebox").TInteger;
            id: import("typebox").TString;
        }>;
        summary: import("typebox").TUnsafe<Pick<ItemView, "createdAt" | "id" | "threadId"> & Pick<ThreadView, "title"> & FeedContentSummary & {
            parentContext?: FeedParentContext;
        }>;
        destination: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"post">;
            id: import("typebox").TString;
            title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            threadId: import("typebox").TString;
            postId: import("typebox").TString;
        }>;
    }>, import("typebox").TObject<{
        id: import("typebox").TString;
        occurredAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        source: import("typebox").TLiteral<"following">;
        key: import("typebox").TObject<{
            owner: import("typebox").TLiteral<"library">;
            kind: import("typebox").TLiteral<"collection">;
            route: import("typebox").TInteger;
            id: import("typebox").TString;
        }>;
        summary: import("typebox").TUnsafe<Pick<CollectionResourceView, "description" | "id" | "title">>;
        destination: import("typebox").TObject<{
            kind: import("typebox").TLiteral<"collection">;
            id: import("typebox").TString;
            title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>;
    }>]>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    asOf: import("typebox").TString;
    reactionsAsOf: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TUnsafe<Readonly<{
        epoch: number;
        position: string;
    }>>, import("typebox").TNull]>>;
    sources: import("typebox").TObject<{
        discovery: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"preparing">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"not_requested">]>;
        following: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"preparing">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"not_requested">]>;
        continue: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"preparing">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"not_requested">]>;
    }>;
}>;
export type FeedItem = Static<typeof FeedItemSchema>;
export type FeedPage = Static<typeof FeedPageSchema>;
export type FeedSourceState = Static<typeof FeedSourceStateSchema>;
export {};
