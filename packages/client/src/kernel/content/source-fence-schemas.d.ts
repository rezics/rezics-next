export declare const SourceFenceQuerySchema: import("typebox").TObject<{
    source: import("typebox").TString;
    externalId: import("typebox").TString;
    fieldGroup: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
}>;
export declare const SourceFenceResponseSchema: import("typebox").TObject<{
    fenced: import("typebox").TBoolean;
    securityRevision: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
