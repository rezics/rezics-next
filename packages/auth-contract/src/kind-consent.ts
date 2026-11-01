/** Native Auth/Source boundary for Collection Kind currentness.
 * These values are trusted server composition data. They are never accepted
 * from an HTTP request and the reference is only a lookup key.
 */
export type KindConsentConsumer = Readonly<{
  route: string;
  ownerAccountId: string;
  collectionId: string;
  preparationId: string;
  originId: string;
}>;

export type KindConsentReference = Readonly<{
  kind: 'auth-kind-consent';
  id: string;
}>;

export type KindConsentEnrollmentInput = Readonly<{
  accountId: string;
  clientId: string;
  requestedScopes: readonly string[];
  consumer: KindConsentConsumer;
}>;

export type KindConsentEnrollmentResult =
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{
      status: 'enrolled';
      reference: KindConsentReference;
      /** Intersection of the original request and current native ceilings. */
      effectiveScopes: readonly string[];
    }>;

/** Auth's immutable transition identity plus the exact consumer reference.
 * Locator fields must match the body retained under the Auth reference.
 */
export type KindConsentInvalidationInput = Readonly<{
  reference: KindConsentReference;
  consumer: KindConsentConsumer;
  transitionId: string;
}>;

export type KindConsentInvalidationResult =
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'committed'; receiptReference: string }>;

export type KindConsentVerificationResult =
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'verified'; receiptReference: string }>;

/** Implemented by the native owner of the receiving Source home. `verify`
 * resolves its own receipt and current local fence; returning caller JSON or
 * echoing the supplied reference is not verification.
 */
export interface KindConsentInvalidationReceiver {
  invalidate: KindConsentOperation<KindConsentInvalidationInput, KindConsentInvalidationResult>;
  verify: KindConsentOperation<
    KindConsentInvalidationInput & Readonly<{ receiptReference: string }>,
    KindConsentVerificationResult
  >;
}

/** Auth owns enrollment and the dependency reference's native meaning. */
export interface KindConsentParticipant {
  enroll: KindConsentOperation<KindConsentEnrollmentInput, KindConsentEnrollmentResult>;
}

/** The axes deliberately keep the established Source and Access meanings.
 * This shape is a declaration inside the caller's SAME reservation; it is not
 * an independent budget or another work ledger.
 */
export type KindConsentSourceWork = Readonly<{
  candidateKeys: number;
  nativeRows: number;
  identityMetadataRows: number;
  emptySeeks: number;
  nativePoints: number;
  witnessKeys: number;
  statements: number;
  bytes: number;
}>;
export type KindConsentAccessWork = Readonly<{
  keys: number;
  points: number;
  witnesses: number;
  rows: number;
  bytes: number;
  emptySeeks: number;
}>;
export type KindConsentWorkDeclaration = Readonly<{
  source: KindConsentSourceWork;
  access: KindConsentAccessWork;
}>;

/** A callable operation also carries pure declaration and exact actual-charge
 * functions, so consumers can reserve and settle the existing shared ledger.
 */
export interface KindConsentOperation<Input, Result> {
  (input: Input): Promise<Result>;
  bound(input: Input): KindConsentWorkDeclaration | undefined;
  actual(input: Input, result: Result): KindConsentWorkDeclaration | undefined;
}
