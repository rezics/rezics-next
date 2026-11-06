import { Type, type Static } from 'typebox';
export declare const MAX_SOURCE_CLASSIFICATION_BATCH = 32;
export declare const SOURCE_CLASSIFICATION_CHANGED = "com.rezics.rating.source_classification.changed.v1";
/** Exact Semantic identity. Labels never participate in association resolution. */
export declare const ClassificationAssociationSchema: Type.TObject<{
    subjectId: Type.TString;
    candidateId: Type.TString;
    contextId: Type.TString;
    targetId: Type.TString;
    property: Type.TString;
    revision: Type.TInteger;
    release: Type.TString;
    qualifiersDigest: Type.TString;
}>;
export type ClassificationAssociation = Static<typeof ClassificationAssociationSchema>;
export declare const ClassificationSourceVersionSchema: Type.TUnion<[Type.TObject<{
    kind: Type.TLiteral<"revision">;
    revision: Type.TString;
}>, Type.TObject<{
    kind: Type.TLiteral<"unversioned">;
    digest: Type.TString;
}>]>;
/** This is an admitted aggregate, never a provider response or an arbitrary property bag.
 * Imports owns extraction, permission and the meaning of independently supplied counts.
 */
export declare const ClassificationObservationSchema: Type.TObject<{
    sourceAlias: Type.TString;
    sourceRecordId: Type.TString;
    sourceAssociationId: Type.TString;
    asOf: Type.TString;
    confidence: Type.TOptional<Type.TNumber>;
    lie: Type.TOptional<Type.TBoolean>;
    confidenceCount: Type.TOptional<Type.TInteger>;
    lieCount: Type.TOptional<Type.TInteger>;
    sourceVersion: Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"revision">;
        revision: Type.TString;
    }>, Type.TObject<{
        kind: Type.TLiteral<"unversioned">;
        digest: Type.TString;
    }>]>;
    attribution: Type.TString;
    licence: Type.TString;
}>;
export type ClassificationObservation = Static<typeof ClassificationObservationSchema>;
export declare const ClassificationClearSchema: Type.TObject<{
    sourceAlias: Type.TString;
    sourceRecordId: Type.TString;
    sourceAssociationId: Type.TString;
    asOf: Type.TString;
    cleared: Type.TLiteral<true>;
}>;
export type ClassificationClear = Static<typeof ClassificationClearSchema>;
export type ClassificationPayload = ClassificationObservation | ClassificationClear;
export type ImmutableClassificationObservation = Readonly<{
    digest: string;
    payload: ClassificationPayload;
}>;
export declare function validateClassificationAssociation(value: unknown): asserts value is ClassificationAssociation;
export declare function validateClassificationObservation(value: unknown): asserts value is ClassificationObservation;
export declare function validateClassificationClear(value: unknown): asserts value is ClassificationClear;
export declare function classificationDigest(value: unknown): string;
export declare function classificationAssociationKey(association: ClassificationAssociation): string;
export declare function classificationObservation(association: ClassificationAssociation, payload: ClassificationPayload): ImmutableClassificationObservation;
export type ClassificationUnavailableReason = 'not_found' | 'not_observed' | 'provenance_unavailable' | 'authority_unavailable' | 'changed';
export type SourceClassificationFigure = Readonly<{
    provider: 'vndb';
    association: ClassificationAssociation;
    observation: {
        digest: string;
        sourceVersion: ClassificationObservation['sourceVersion'];
    };
    sourceAlias: string;
    sourceRecordId: string;
    sourceAssociationId: string;
    confidence: {
        state: 'available';
        value: number;
        unit: 'vndb-tag-rating';
        minExclusive: 0;
        max: 3;
    } | {
        state: 'unavailable';
        reason: 'not_supplied';
    };
    lie: {
        state: 'available';
        value: boolean;
        unit: 'boolean';
    } | {
        state: 'unavailable';
        reason: 'not_supplied';
    };
    confidenceCount?: number;
    lieCount?: number;
    asOf: string;
    ageSeconds: number;
    attribution: string;
    licence: string;
}>;
export type SourceClassificationRead = {
    state: 'available';
    value: SourceClassificationFigure;
} | {
    state: 'unavailable';
    reason: ClassificationUnavailableReason;
};
/** Hash public Semantic qualifier snaks without presentation datatype fields. */
export declare function classificationQualifiersDigest(qualifiers: readonly {
    property: string | {
        id: string;
    };
    value: unknown;
}[]): string;
