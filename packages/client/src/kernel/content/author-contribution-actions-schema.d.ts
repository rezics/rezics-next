import type { Static } from 'typebox';
export declare const AuthorContributionSelectionSchema: import("typebox").TObject<{
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
}>;
export declare const AuthorContributionActionsInputSchema: import("typebox").TObject<{
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
    view: import("typebox").TUnion<[import("typebox").TLiteral<"posts">, import("typebox").TLiteral<"reviews">, import("typebox").TLiteral<"discussion">]>;
    cursor: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export type AuthorContributionActionsInput = Static<typeof AuthorContributionActionsInputSchema>;
export type AuthorContributionSelection = Static<typeof AuthorContributionSelectionSchema>;
export declare const AuthorContributionActionsResponseSchema: import("typebox").TObject<{
    viewer: import("typebox").TUnion<[import("typebox").TObject<{
        kind: import("typebox").TLiteral<"anonymous">;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"account">;
        id: import("typebox").TString;
    }>]>;
    selected: import("typebox").TArray<import("typebox").TObject<{
        reference: import("typebox").TUnion<[import("typebox").TObject<{
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
        }>]>;
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"erased">, import("typebox").TLiteral<"withheld">]>;
        reply: import("typebox").TObject<{
            state: import("typebox").TUnion<[import("typebox").TLiteral<"available">, import("typebox").TLiteral<"sign_in_required">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"withheld">, import("typebox").TLiteral<"unavailable">]>;
        }>;
    }>>;
    reactions: import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        retryable: import("typebox").TBoolean;
        items: import("typebox").TArray<import("typebox").TObject<{
            type: import("typebox").TUnion<[import("typebox").TLiteral<"content.thread">, import("typebox").TLiteral<"content.post">]>;
            id: import("typebox").TString;
            state: import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>, import("typebox").TLiteral<"not_applicable">]>;
            counts: import("typebox").TOptional<import("typebox").TObject<{
                upvote: import("typebox").TOptional<import("typebox").TInteger>;
                downvote: import("typebox").TOptional<import("typebox").TInteger>;
                like: import("typebox").TOptional<import("typebox").TInteger>;
                love: import("typebox").TOptional<import("typebox").TInteger>;
                laugh: import("typebox").TOptional<import("typebox").TInteger>;
                insightful: import("typebox").TOptional<import("typebox").TInteger>;
                sad: import("typebox").TOptional<import("typebox").TInteger>;
            }>>;
            viewerSelection: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        }>>;
        reactionsAsOf: import("typebox").TUnion<[import("typebox").TObject<{
            epoch: import("typebox").TInteger;
            position: import("typebox").TString;
        }>, import("typebox").TNull]>;
    }>;
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
    }>;
    watch: import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>, import("typebox").TLiteral<"sign_in_required">]>;
        retryable: import("typebox").TBoolean;
        items: import("typebox").TArray<import("typebox").TObject<{
            threadId: import("typebox").TString;
            state: import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>, import("typebox").TLiteral<"sign_in_required">]>;
            watching: import("typebox").TOptional<import("typebox").TBoolean>;
        }>>;
    }>;
    currentness: import("typebox").TObject<{
        source: import("typebox").TLiteral<"current">;
        place: import("typebox").TLiteral<"current">;
        reactions: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        authors: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        actions: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>;
        watch: import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"unavailable">]>, import("typebox").TLiteral<"sign_in_required">]>;
    }>;
}>;
