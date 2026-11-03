import { Type, type Static } from 'typebox';
export declare const REVIEW_DISCOVERY_OPENED = "com.rezics.content.review-discovery.opened.v1";
export declare const REVIEW_DISCOVERY_PROGRESS = "com.rezics.content.review-discovery.progress.v1";
export declare const REVIEW_DISCOVERY_CHANGED = "com.rezics.content.review-discovery.changed.v1";
declare const origin: Type.TObject<{
    partition: Type.TInteger;
    epoch: Type.TInteger;
    position: Type.TString;
    eventIndex: Type.TInteger;
    id: Type.TString;
    type: Type.TString;
}>;
export type ReviewDiscoveryOrigin = Static<typeof origin>;
export type ReviewDiscoveryWork = Readonly<Static<typeof work>>;
declare const work: Type.TObject<{
    route: Type.TInteger;
    id: Type.TString;
}>;
export declare const REVIEW_DISCOVERY_EVENTS: {
    readonly "com.rezics.content.review-discovery.opened.v1": Type.TObject<{
        route: Type.TInteger;
        id: Type.TString;
    }>;
    readonly "com.rezics.content.review-discovery.progress.v1": Type.TObject<{
        route: Type.TInteger;
        id: Type.TString;
        version: Type.TString;
        complete: Type.TBoolean;
    }>;
    readonly "com.rezics.content.review-discovery.changed.v1": Type.TObject<{
        partition: Type.TInteger;
        through: Type.TString;
        ids: Type.TArray<Type.TString>;
        origin: Type.TObject<{
            partition: Type.TInteger;
            epoch: Type.TInteger;
            position: Type.TString;
            eventIndex: Type.TInteger;
            id: Type.TString;
            type: Type.TString;
        }>;
    }>;
};
export {};
