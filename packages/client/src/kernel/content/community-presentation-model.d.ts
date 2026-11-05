import type { DocumentSnapshot } from '@rezics/document';
import { type RealmPresentationImage, type RealmPresentationOptional } from './realm-presentation-image.ts';
export type CommunityPresentation = Readonly<{
    realmId: string;
    spaceId: string;
    contextId: string;
    name: string;
    description: string;
    avatar: RealmPresentationOptional<RealmPresentationImage>;
    banner: RealmPresentationOptional<RealmPresentationImage>;
    members: Readonly<{
        state: 'current';
        count: number;
        version: string;
    }> | Readonly<{
        state: 'unknown';
        count: null;
        version: null;
    }>;
    rules: RealmPresentationOptional<Readonly<{
        postId: string;
        revisionId: string;
        body: DocumentSnapshot;
        licence: string;
        sha256: string;
    }>>;
    join: Readonly<{
        membership: 'member' | 'nonmember' | 'unknown';
        action: 'join' | 'leave' | 'sign-in' | null;
    }>;
}>;
export declare const CommunityPresentationSchema: import("typebox").TObject<{
    realmId: import("typebox").TString;
    spaceId: import("typebox").TString;
    contextId: import("typebox").TString;
    name: import("typebox").TString;
    description: import("typebox").TString;
    avatar: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"available">;
        value: import("typebox").TObject<{
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
    }>, import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"none">, import("typebox").TLiteral<"unavailable">]>;
        value: import("typebox").TNull;
    }>]>;
    banner: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"available">;
        value: import("typebox").TObject<{
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
    }>, import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"none">, import("typebox").TLiteral<"unavailable">]>;
        value: import("typebox").TNull;
    }>]>;
    members: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"current">;
        count: import("typebox").TInteger;
        version: import("typebox").TString;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unknown">;
        count: import("typebox").TNull;
        version: import("typebox").TNull;
    }>]>;
    rules: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"available">;
        value: import("typebox").TObject<{
            postId: import("typebox").TString;
            revisionId: import("typebox").TString;
            body: import("typebox").TUnion<[import("typebox").TSchema, import("typebox").TSchema]>;
            licence: import("typebox").TString;
            sha256: import("typebox").TString;
        }>;
    }>, import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"none">, import("typebox").TLiteral<"unavailable">]>;
        value: import("typebox").TNull;
    }>]>;
    join: import("typebox").TObject<{
        membership: import("typebox").TUnion<[import("typebox").TLiteral<"member">, import("typebox").TLiteral<"nonmember">, import("typebox").TLiteral<"unknown">]>;
        action: import("typebox").TUnion<[import("typebox").TLiteral<"join">, import("typebox").TLiteral<"leave">, import("typebox").TLiteral<"sign-in">, import("typebox").TNull]>;
    }>;
}>;
/** Materialize readonly derivative collections for the HTTP schema's JSON DTO. */
export declare function communityPresentationResponse(value: CommunityPresentation): import('typebox').Static<typeof CommunityPresentationSchema>;
