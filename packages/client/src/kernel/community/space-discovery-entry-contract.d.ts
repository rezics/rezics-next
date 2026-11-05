import type { Static } from 'typebox';
import type { FollowingSpaceActions, FollowingSpaceDestination } from '../library/following-space-contract.ts';
export declare const SpaceEntryAvatarSchema: import("typebox").TUnion<[import("typebox").TObject<{
    state: import("typebox").TLiteral<"available">;
    mediaId: import("typebox").TString;
    realmId: import("typebox").TString;
    format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
    width: import("typebox").TInteger;
}>, import("typebox").TObject<{
    state: import("typebox").TUnion<[import("typebox").TLiteral<"none">, import("typebox").TLiteral<"withheld">, import("typebox").TLiteral<"unavailable">]>;
}>]>;
export declare const SpaceEntryPresentationSchema: import("typebox").TObject<{
    identity: import("typebox").TObject<{
        kind: import("typebox").TUnion<[import("typebox").TLiteral<"space">, import("typebox").TLiteral<"realm">]>;
        id: import("typebox").TString;
        name: import("typebox").TString;
    }>;
    avatar: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"available">;
        mediaId: import("typebox").TString;
        realmId: import("typebox").TString;
        format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
        width: import("typebox").TInteger;
    }>, import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"none">, import("typebox").TLiteral<"withheld">, import("typebox").TLiteral<"unavailable">]>;
    }>]>;
}>;
export declare const SpaceEntryFollowSchema: import("typebox").TUnion<[import("typebox").TObject<{
    state: import("typebox").TLiteral<"current">;
    following: import("typebox").TBoolean;
    action: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"disabled">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"sign-in">]>;
}>, import("typebox").TObject<{
    state: import("typebox").TUnion<[import("typebox").TLiteral<"sign-in">, import("typebox").TLiteral<"unavailable">]>;
}>]>;
export declare const SpaceEntryRowSchema: import("typebox").TObject<{
    id: import("typebox").TString;
    destination: import("typebox").TUnion<[import("typebox").TObject<{
        kind: import("typebox").TLiteral<"space">;
        spaceId: import("typebox").TString;
        address: import("typebox").TString;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"realm">;
        realmId: import("typebox").TString;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"unavailable">;
    }>]>;
    entry: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"disabled">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"sign-in">]>;
    admission: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"disabled">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"sign-in">]>;
    follow: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"current">;
        following: import("typebox").TBoolean;
        action: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"disabled">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"sign-in">]>;
    }>, import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"sign-in">, import("typebox").TLiteral<"unavailable">]>;
    }>]>;
}>;
export declare const SpaceEntryPageSchema: import("typebox").TObject<{
    reader: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    rows: import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        destination: import("typebox").TUnion<[import("typebox").TObject<{
            kind: import("typebox").TLiteral<"space">;
            spaceId: import("typebox").TString;
            address: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"realm">;
            realmId: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"unavailable">;
        }>]>;
        entry: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"disabled">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"sign-in">]>;
        admission: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"disabled">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"sign-in">]>;
        follow: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"current">;
            following: import("typebox").TBoolean;
            action: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"disabled">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"sign-in">]>;
        }>, import("typebox").TObject<{
            state: import("typebox").TUnion<[import("typebox").TLiteral<"sign-in">, import("typebox").TLiteral<"unavailable">]>;
        }>]>;
    }>>;
}>;
export type SpaceEntryPresentation = Static<typeof SpaceEntryPresentationSchema>;
export type SpaceEntryFollow = Static<typeof SpaceEntryFollowSchema>;
export type SpaceEntryRow = Static<typeof SpaceEntryRowSchema>;
export type SpaceEntryPage = Static<typeof SpaceEntryPageSchema>;
/** Native observations stay inside the request. Bindings are never response fields. */
export type SpaceEntryCard = Readonly<{
    id: string;
    address: string | null;
    title: string;
    description: string;
    realmId: string | null;
    realmTitle: string | null;
    binding: string;
    presentation: SpaceEntryPresentation;
    destination: FollowingSpaceDestination;
    actions: FollowingSpaceActions;
}>;
