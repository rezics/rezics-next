import { Type, type Static } from 'typebox';
/** An invalidation is not an eligible document or permission to disclose one. */
export declare const SpaceDiscoveryInvalidation: Type.TObject<{
    target: Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"context" | "media" | "space">;
        id: Type.TString;
    }>, Type.TObject<{
        kind: Type.TLiteral<"context" | "media" | "space">;
        id: Type.TString;
    }>, Type.TObject<{
        kind: Type.TLiteral<"context" | "media" | "space">;
        id: Type.TString;
    }>, Type.TObject<{
        kind: Type.TLiteral<"source-fence">;
        route: Type.TInteger;
        source: Type.TString;
        externalId: Type.TString;
        fieldGroup: Type.TUnion<[Type.TLiteral<"facts">, Type.TLiteral<"summary">, Type.TLiteral<"cover">]>;
    }>, Type.TObject<{
        kind: Type.TLiteral<"exposure">;
        group: Type.TString;
    }>]>;
    origin: Type.TObject<{
        partition: Type.TInteger;
        epoch: Type.TInteger;
        position: Type.TString;
        eventId: Type.TString;
        resourceId: Type.TUnion<[Type.TString, Type.TNull]>;
        type: Type.TString;
    }>;
    revisionId: Type.TUnion<[Type.TString, Type.TNull]>;
    nativeVersion: Type.TUnion<[Type.TString, Type.TNull]>;
}>;
export type SpaceDiscoveryInvalidation = Static<typeof SpaceDiscoveryInvalidation>;
export declare const SPACE_DISCOVERY_INVALIDATED = "com.rezics.community.space-discovery.invalidated.v1";
