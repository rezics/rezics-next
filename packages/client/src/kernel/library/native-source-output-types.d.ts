export type NativeOutputActivation = Readonly<{
    transactionId: string;
    position: string;
    sourceGeneration: string;
}>;
export type NativePublicOutputIdentity = Readonly<{
    scope: 'public_output';
    route: number;
    collectionId: string;
    incarnation: string;
    generation: string;
    ownerEpoch: number;
    receivingEpoch: string;
    effectKey: string;
    outputGeneration: string;
    activation: NativeOutputActivation;
}>;
