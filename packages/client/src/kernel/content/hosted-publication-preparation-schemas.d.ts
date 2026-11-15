export declare function HostedPublicationPreparationStartSchema(): import("typebox").TObject<{
    stageId: import("typebox").TString;
    expectedRevisionId: import("typebox").TString;
    expectedPublicationId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    mode: import("typebox").TUnion<[import("typebox").TLiteral<"whole">, import("typebox").TLiteral<"selection">]>;
}>;
export declare function HostedPublicationPreparationBatchSchema(): import("typebox").TObject<{
    batchId: import("typebox").TString;
    occurrenceIds: import("typebox").TArray<import("typebox").TString>;
}>;
export declare function HostedPublicationPreparationAdvanceSchema(): import("typebox").TObject<{
    stepId: import("typebox").TString;
}>;
export declare function HostedPublicationPreparationEmptySchema(): import("typebox").TObject<{}>;
/** New progress adds only immutable source/publication IDs; optional binding fields keep older receipts replayable. */
export declare function HostedPublicationPreparationProgressSchema(): import("typebox").TObject<{
    catalogueId: import("typebox").TString;
    stageId: import("typebox").TString;
    stage: import("typebox").TObject<{
        locator: import("typebox").TObject<{
            catalogueId: import("typebox").TString;
            stageId: import("typebox").TString;
        }>;
        state: import("typebox").TUnion<[import("typebox").TLiteral<"collecting">, import("typebox").TLiteral<"building">, import("typebox").TLiteral<"closing">, import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"sealed">, import("typebox").TLiteral<"cancelled">, import("typebox").TLiteral<"expired">, import("typebox").TLiteral<"failed">]>;
        mode: import("typebox").TUnion<[import("typebox").TLiteral<"whole">, import("typebox").TLiteral<"selection">]>;
        sourceRevisionId: import("typebox").TOptional<import("typebox").TString>;
        expectedHeadRevisionId: import("typebox").TOptional<import("typebox").TString>;
        expectedPublicationId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        inputVersion: import("typebox").TString;
        inputCount: import("typebox").TString;
        settledInputCount: import("typebox").TString;
        candidateCount: import("typebox").TString;
        sourceFrontier: import("typebox").TString;
        sourceExhausted: import("typebox").TBoolean;
        closureFrontier: import("typebox").TString;
        closureCheckedCount: import("typebox").TString;
        closureMissingCount: import("typebox").TString;
        failure: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
    batch: import("typebox").TOptional<import("typebox").TObject<{
        replayed: import("typebox").TBoolean;
        inputVersion: import("typebox").TString;
        firstInputPosition: import("typebox").TString;
        itemCount: import("typebox").TInteger;
    }>>;
    candidate: import("typebox").TUnion<[import("typebox").TObject<{
        candidateId: import("typebox").TString;
        generationId: import("typebox").TString;
        afterSourceOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        placementCount: import("typebox").TString;
        rootCount: import("typebox").TString;
        chapterCount: import("typebox").TString;
        coverageComplete: import("typebox").TBoolean;
        sealed: import("typebox").TBoolean;
    }>, import("typebox").TNull]>;
    candidateReady: import("typebox").TBoolean;
}>;
/** Exact native activation progress; `publicationId` stays null until the pointer CAS commits. */
export declare function HostedPublicationActivationProgressSchema(): import("typebox").TObject<{
    catalogueId: import("typebox").TString;
    stageId: import("typebox").TString;
    state: import("typebox").TUnion<[import("typebox").TLiteral<"checking">, import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"restart">, import("typebox").TLiteral<"activated">]>;
    passId: import("typebox").TString;
    checkedTargetCount: import("typebox").TString;
    totalTargetCount: import("typebox").TString;
    candidateGenerationId: import("typebox").TString;
    publicationId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    restartRequired: import("typebox").TBoolean;
}>;
