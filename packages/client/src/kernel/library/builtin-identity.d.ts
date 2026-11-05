export type BuiltinCollectionKey = Readonly<{
    kind: 'everything';
}> | Readonly<{
    kind: 'liked';
}> | Readonly<{
    kind: 'state';
    profileId: string;
    stateSetId: string;
    stateId: string;
}>;
export declare function builtinCollectionId(ownerAccountId: string, key: BuiltinCollectionKey): string;
