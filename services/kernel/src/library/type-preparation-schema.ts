import { Type, type Static } from 'typebox';

/** Bounded internal workflow identity. Neither a source proof nor an authorization token. */
export const TypePreparationBindingSchema = Type.Object({
  accountId: Type.String(),
  subjectId: Type.String(),
  requestKey: Type.String(),
  sourceId: Type.String(),
  sourcePartition: Type.Number(),
  sourceEpoch: Type.Number(),
  sourcePosition: Type.String(),
  ownerEpoch: Type.String(),
});
export type TypePreparationBinding = Readonly<Static<typeof TypePreparationBindingSchema>>;

/** Requested-source binding retained even if it redirects to the resolved source in binding. */
export const TypePreparationOriginSchema = Type.Object({
  sourceId: Type.String(),
  partition: Type.Number(),
  epoch: Type.Number(),
  position: Type.String(),
  survivorId: Type.Union([Type.String(), Type.Null()]),
});
export type TypePreparationOrigin = Readonly<Static<typeof TypePreparationOriginSchema>>;

/** Fixed visible create/identity version; partition position is ordering, not an item version or Access proof. */
export const TypePreparationIdentitySchema = Type.Object({
  sourceId: Type.String(),
  partition: Type.Number(),
  epoch: Type.Number(),
  revision: Type.Number(),
  transactionId: Type.String(),
  redirect: Type.Union([Type.String(), Type.Null()]),
});
export type TypePreparationIdentity = Readonly<Static<typeof TypePreparationIdentitySchema>>;
