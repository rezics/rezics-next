export declare function CollectionDiscoverySummarySchema(): import("typebox").TObject<{
    id: import("typebox").TString;
    title: import("typebox").TString;
    description: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    card: import("typebox").TUnion<[import("typebox").TObject<{
        kind: import("typebox").TLiteral<"collection">;
        id: import("typebox").TString;
        destination: import("typebox").TString;
        title: import("typebox").TString;
        description: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        visibility: import("typebox").TLiteral<"public">;
        revision: import("typebox").TInteger;
        sourceGeneration: import("typebox").TString;
        presentationKind: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        presentationKindSource: import("typebox").TUnion<[import("typebox").TLiteral<"mixed">, import("typebox").TLiteral<"owner">]>;
        cover: import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TObject<{
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
        }>, import("typebox").TNull]>, import("typebox").TNull]>;
        coverSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"member">, import("typebox").TLiteral<"none">, import("typebox").TLiteral<"pending">]>;
        curator: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"available">;
            id: import("typebox").TString;
            label: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            destination: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
            reason: import("typebox").TUnion<[import("typebox").TLiteral<"deidentified">, import("typebox").TLiteral<"withheld">, import("typebox").TLiteral<"native_projection">]>;
        }>]>;
        preview: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"available">;
            members: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                subject: import("typebox").TObject<{
                    id: import("typebox").TString;
                    type: import("typebox").TString;
                    types: import("typebox").TArray<import("typebox").TString>;
                    label: import("typebox").TUnion<[import("typebox").TObject<{
                        value: import("typebox").TString;
                        language: import("typebox").TString;
                    }>, import("typebox").TNull]>;
                }>;
            }>>;
            partial: import("typebox").TBoolean;
            truncated: import("typebox").TBoolean;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"empty">;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"withheld">;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
        }>]>;
        membershipKind: import("typebox").TLiteral<"curated">;
        memberCount: import("typebox").TInteger;
        orderEpoch: import("typebox").TInteger;
        createdAt: import("typebox").TString;
        updatedAt: import("typebox").TString;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"collection">;
        id: import("typebox").TString;
        destination: import("typebox").TString;
        title: import("typebox").TString;
        description: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        visibility: import("typebox").TLiteral<"public">;
        revision: import("typebox").TInteger;
        sourceGeneration: import("typebox").TString;
        presentationKind: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        presentationKindSource: import("typebox").TUnion<[import("typebox").TLiteral<"mixed">, import("typebox").TLiteral<"owner">]>;
        cover: import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TObject<{
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
        }>, import("typebox").TNull]>, import("typebox").TNull]>;
        coverSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"member">, import("typebox").TLiteral<"none">, import("typebox").TLiteral<"pending">]>;
        curator: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"available">;
            id: import("typebox").TString;
            label: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            destination: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
            reason: import("typebox").TUnion<[import("typebox").TLiteral<"deidentified">, import("typebox").TLiteral<"withheld">, import("typebox").TLiteral<"native_projection">]>;
        }>]>;
        preview: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"available">;
            members: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                subject: import("typebox").TObject<{
                    id: import("typebox").TString;
                    type: import("typebox").TString;
                    types: import("typebox").TArray<import("typebox").TString>;
                    label: import("typebox").TUnion<[import("typebox").TObject<{
                        value: import("typebox").TString;
                        language: import("typebox").TString;
                    }>, import("typebox").TNull]>;
                }>;
            }>>;
            partial: import("typebox").TBoolean;
            truncated: import("typebox").TBoolean;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"empty">;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"withheld">;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
        }>]>;
        membershipKind: import("typebox").TLiteral<"dynamic">;
        outputGeneration: import("typebox").TString;
    }>]>;
}>;
