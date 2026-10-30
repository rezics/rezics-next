export type NativeOutputActivation = Readonly<{
  transactionId: string;
  position: string; // actual canonical decimal native Core position, never Number
  sourceGeneration: string; // immutable activation source generation
}>;
export type NativePublicOutputIdentity = Readonly<{
  scope: 'public_output';
  route: number;
  collectionId: string;
  incarnation: string;
  generation: string; // CURRENT native source generation; not activation generation
  ownerEpoch: number;
  receivingEpoch: string;
  effectKey: string;
  outputGeneration: string;
  activation: NativeOutputActivation;
}>;
