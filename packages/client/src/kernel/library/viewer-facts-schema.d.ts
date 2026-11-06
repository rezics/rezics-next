export declare const MAX_VIEWER_FACTS_ROWS = 100;
export declare const MAX_VIEWER_FACTS_INPUT_BYTES = 16384;
export declare const MAX_VIEWER_FACTS_RESPONSE_BYTES = 65536;
export declare const viewerFactSchema: import("typebox").TObject<{
    rowKey: import("typebox").TString;
    subjectId: import("typebox").TString;
    entry: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"present">;
        incarnationId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        entryState: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        revision: import("typebox").TInteger;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"absent">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
        reason: import("typebox").TLiteral<"scope">;
    }>]>;
    vote: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"present">;
        questionId: import("typebox").TString;
        questionRevision: import("typebox").TInteger;
        units: import("typebox").TInteger;
        revision: import("typebox").TInteger;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"absent">;
        questionId: import("typebox").TString;
        questionRevision: import("typebox").TInteger;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
        reason: import("typebox").TUnion<[import("typebox").TLiteral<"scope">, import("typebox").TLiteral<"question">]>;
    }>]>;
}>;
/** Wire type for admitted Library and Collection rows; unavailable authority remains explicit and value-free. */
export declare const viewerFactsResponseSchema: import("typebox").TUnion<[import("typebox").TObject<{
    state: import("typebox").TLiteral<"current">;
    question: import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
        revision: import("typebox").TInteger;
        grain: import("typebox").TString;
        scale: import("typebox").TObject<{
            min: import("typebox").TInteger;
            max: import("typebox").TInteger;
            displayStep: import("typebox").TInteger;
        }>;
        meaning: import("typebox").TString;
    }>, import("typebox").TNull]>;
    rows: import("typebox").TArray<import("typebox").TObject<{
        rowKey: import("typebox").TString;
        subjectId: import("typebox").TString;
        entry: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"present">;
            incarnationId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            entryState: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            revision: import("typebox").TInteger;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"absent">;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
            reason: import("typebox").TLiteral<"scope">;
        }>]>;
        vote: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"present">;
            questionId: import("typebox").TString;
            questionRevision: import("typebox").TInteger;
            units: import("typebox").TInteger;
            revision: import("typebox").TInteger;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"absent">;
            questionId: import("typebox").TString;
            questionRevision: import("typebox").TInteger;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
            reason: import("typebox").TUnion<[import("typebox").TLiteral<"scope">, import("typebox").TLiteral<"question">]>;
        }>]>;
    }>>;
}>, import("typebox").TObject<{
    state: import("typebox").TLiteral<"unavailable">;
    reason: import("typebox").TUnion<[import("typebox").TLiteral<"identity">, import("typebox").TLiteral<"currentness">, import("typebox").TLiteral<"response_limit">]>;
    retryable: import("typebox").TBoolean;
}>]>;
