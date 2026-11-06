import { Type, type Static } from 'typebox';
/** Bounded internal workflow identity. Neither a source proof nor an authorization token. */
export declare const TypePreparationBindingSchema: Type.TObject<{
    accountId: Type.TString;
    subjectId: Type.TString;
    requestKey: Type.TString;
    sourceId: Type.TString;
    sourcePartition: Type.TNumber;
    sourceEpoch: Type.TNumber;
    sourcePosition: Type.TString;
    ownerEpoch: Type.TString;
}>;
export type TypePreparationBinding = Readonly<Static<typeof TypePreparationBindingSchema>>;
/** Requested-source binding retained even if it redirects to the resolved source in binding. */
export declare const TypePreparationOriginSchema: Type.TObject<{
    sourceId: Type.TString;
    partition: Type.TNumber;
    epoch: Type.TNumber;
    position: Type.TString;
    survivorId: Type.TUnion<[Type.TString, Type.TNull]>;
}>;
export type TypePreparationOrigin = Readonly<Static<typeof TypePreparationOriginSchema>>;
/** Fixed visible create/identity version; partition position is ordering, not an item version or Access proof. */
export declare const TypePreparationIdentitySchema: Type.TObject<{
    sourceId: Type.TString;
    partition: Type.TNumber;
    epoch: Type.TNumber;
    revision: Type.TNumber;
    transactionId: Type.TString;
    redirect: Type.TUnion<[Type.TString, Type.TNull]>;
}>;
export type TypePreparationIdentity = Readonly<Static<typeof TypePreparationIdentitySchema>>;
