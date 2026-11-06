export declare const QuestionManagementQuerySchema: import("typebox").TObject<{
    selectedQuestionId: import("typebox").TOptional<import("typebox").TString>;
    cursor: import("typebox").TOptional<import("typebox").TString>;
}>;
export declare function QuestionManagementResponseSchema(): import("typebox").TObject<{
    viewer: import("typebox").TObject<{
        accountId: import("typebox").TString;
    }>;
    realmId: import("typebox").TString;
    directory: import("typebox").TObject<{
        ratingQuestions: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            revision: import("typebox").TInteger;
            label: import("typebox").TString;
            scale: import("typebox").TObject<{
                min: import("typebox").TInteger;
                max: import("typebox").TInteger;
                displayStep: import("typebox").TInteger;
            }>;
            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
            realmId: import("typebox").TString;
            meaning: import("typebox").TString;
            canonicalLabel: import("typebox").TString;
            labelRevision: import("typebox").TInteger;
            lifecycle: import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                revision: import("typebox").TInteger;
            }>;
        }>>;
        next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
    actions: import("typebox").TObject<{
        create: import("typebox").TUnion<[import("typebox").TObject<{
            method: import("typebox").TLiteral<"POST">;
            href: import("typebox").TString;
        }>, import("typebox").TNull]>;
    }>;
    selected: import("typebox").TUnion<[import("typebox").TObject<{
        question: import("typebox").TObject<{
            id: import("typebox").TString;
            revision: import("typebox").TInteger;
            label: import("typebox").TString;
            scale: import("typebox").TObject<{
                min: import("typebox").TInteger;
                max: import("typebox").TInteger;
                displayStep: import("typebox").TInteger;
            }>;
            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
            realmId: import("typebox").TString;
            meaning: import("typebox").TString;
            canonicalLabel: import("typebox").TString;
            labelRevision: import("typebox").TInteger;
            lifecycle: import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                revision: import("typebox").TInteger;
            }>;
        }>;
        readback: import("typebox").TString;
        history: import("typebox").TString;
        actions: import("typebox").TObject<{
            caption: import("typebox").TUnion<[import("typebox").TObject<{
                method: import("typebox").TLiteral<"PUT">;
                href: import("typebox").TString;
                expectedLabelRevision: import("typebox").TInteger;
            }>, import("typebox").TNull]>;
            lifecycle: import("typebox").TUnion<[import("typebox").TObject<{
                method: import("typebox").TLiteral<"POST">;
                href: import("typebox").TString;
                expectedLifecycleRevision: import("typebox").TInteger;
            }>, import("typebox").TNull]>;
        }>;
    }>, import("typebox").TNull]>;
}>;
export declare const RatingQuestionLabelResultSchema: import("typebox").TObject<{
    questionId: import("typebox").TString;
    labelRevision: import("typebox").TInteger;
    label: import("typebox").TString;
}>;
export declare const RatingQuestionLabelSchema: import("typebox").TObject<{
    questionId: import("typebox").TString;
    labelRevision: import("typebox").TInteger;
    label: import("typebox").TString;
    at: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    author: import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
        state: import("typebox").TLiteral<"deleted">;
    }>, import("typebox").TObject<{
        id: import("typebox").TString;
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
        state: import("typebox").TLiteral<"active">;
        handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        automated: import("typebox").TBoolean;
        operatorId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>, import("typebox").TNull]>;
}>;
export declare const RatingQuestionLabelHistoryQuerySchema: import("typebox").TObject<{
    limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
    cursor: import("typebox").TOptional<import("typebox").TString>;
}>;
export declare const RatingQuestionLabelHistorySchema: import("typebox").TObject<{
    labels: import("typebox").TArray<import("typebox").TObject<{
        questionId: import("typebox").TString;
        labelRevision: import("typebox").TInteger;
        label: import("typebox").TString;
        at: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        author: import("typebox").TUnion<[import("typebox").TObject<{
            id: import("typebox").TString;
            kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
            state: import("typebox").TLiteral<"deleted">;
        }>, import("typebox").TObject<{
            id: import("typebox").TString;
            kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
            state: import("typebox").TLiteral<"active">;
            handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            automated: import("typebox").TBoolean;
            operatorId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>, import("typebox").TNull]>;
    }>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
