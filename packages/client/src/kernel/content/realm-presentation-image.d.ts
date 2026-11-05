export type RealmPresentationOptional<T> = Readonly<{
    state: 'available';
    value: T;
}> | Readonly<{
    state: 'none' | 'unavailable';
    value: null;
}>;
export type RealmPresentationImage = Readonly<{
    id: string;
    containerId: string;
    digest: string;
    width: number;
    height: number;
    variants: readonly Readonly<{
        format: 'avif' | 'webp';
        width: number;
        height: number;
    }>[];
    placeholder: Readonly<{
        thumbhash: string;
        color: string;
    }> | null;
    focalPoint: Readonly<{
        x: number;
        y: number;
    }> | null;
    credit: import('@rezics/definitions/media-import').MediaImportRequest['credit'] | null;
}>;
export declare const RealmPresentationImageSchema: import("typebox").TObject<{
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
