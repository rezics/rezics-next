export declare const EmptyRecoveryActionSchema: import("typebox").TUnion<[import("typebox").TObject<{
    kind: import("typebox").TLiteral<"edit-query">;
}>, import("typebox").TObject<{
    kind: import("typebox").TLiteral<"remove-type">;
}>, import("typebox").TObject<{
    kind: import("typebox").TLiteral<"remove-kind">;
    value: import("typebox").TString;
}>, import("typebox").TObject<{
    kind: import("typebox").TLiteral<"remove-facet">;
    property: import("typebox").TString;
    value: import("typebox").TString;
}>, import("typebox").TObject<{
    kind: import("typebox").TLiteral<"remove-range">;
    property: import("typebox").TString;
}>]>;
export declare const EmptyRecoverySchema: import("typebox").TObject<{
    status: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"preparing">, import("typebox").TLiteral<"unavailable">]>;
    alternatives: import("typebox").TArray<import("typebox").TObject<{
        query: import("typebox").TString;
        label: import("typebox").TString;
    }>>;
    actions: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
        kind: import("typebox").TLiteral<"edit-query">;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"remove-type">;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"remove-kind">;
        value: import("typebox").TString;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"remove-facet">;
        property: import("typebox").TString;
        value: import("typebox").TString;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"remove-range">;
        property: import("typebox").TString;
    }>]>>;
}>;
export declare const EmptyRecoveryActionsSchema: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
    kind: import("typebox").TLiteral<"edit-query">;
}>, import("typebox").TObject<{
    kind: import("typebox").TLiteral<"remove-type">;
}>, import("typebox").TObject<{
    kind: import("typebox").TLiteral<"remove-kind">;
    value: import("typebox").TString;
}>, import("typebox").TObject<{
    kind: import("typebox").TLiteral<"remove-facet">;
    property: import("typebox").TString;
    value: import("typebox").TString;
}>, import("typebox").TObject<{
    kind: import("typebox").TLiteral<"remove-range">;
    property: import("typebox").TString;
}>]>>>;
