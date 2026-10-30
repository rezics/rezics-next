export type RealmPresentation = Readonly<{
    avatarMediaId: string | null;
    bannerMediaId: string | null;
    rules: Readonly<{
        postId: string;
        revisionId: string;
    }> | null;
}>;
export declare const RealmPresentationSchema: import("typebox").TObject<{
    avatarMediaId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    bannerMediaId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    rules: import("typebox").TUnion<[import("typebox").TObject<{
        postId: import("typebox").TString;
        revisionId: import("typebox").TString;
    }>, import("typebox").TNull]>;
}>;
export declare const emptyRealmPresentation: RealmPresentation;
export declare function realmPresentation(value: unknown): RealmPresentation;
