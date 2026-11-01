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

/** Shared consent ceilings used by Auth and the bounded Kernel transport. */
export const MAX_CONSENTED_SCOPES = 512;
/** Maximum joined ASCII scope bytes, including single-space separators. */
export const MAX_CONSENTED_SCOPE_OCTETS = 66_047;

/** The native enrollment producer admits this many canonical input bytes. */
export const KIND_CONSENT_ENROLLMENT_INPUT_MAX_BYTES = 80_000;
/** Includes worst-case JSON escaping for the seven visible-ASCII identifiers. */
export const KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES = 90_000;
/** Includes the original bounded scopes, opaque reference, and native charge. */
export const KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES = 80_000;
export const KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS = 3_000;

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && /^[\x21-\x7e]+$/.test(value);
const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const sourceAxes = [
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'emptySeeks',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
] as const;
const accessAxes = ['keys', 'points', 'witnesses', 'rows', 'bytes', 'emptySeeks'] as const;

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

/** Pure canonical bound for the installed Auth native enrollment. */
export function kindConsentOperationBound(input: KindConsentEnrollmentInput): KindConsentWorkDeclaration | undefined {
  if (
    !exactRecord(input, ['accountId', 'clientId', 'requestedScopes', 'consumer']) ||
    !identifier(input.accountId) ||
    !identifier(input.clientId) ||
    !Array.isArray(input.requestedScopes) ||
    input.requestedScopes.length > MAX_CONSENTED_SCOPES ||
    !input.requestedScopes.every(
      (scope) => typeof scope === 'string' && scope.length <= 128 && scopePattern.test(scope),
    ) ||
    !exactRecord(input.consumer, ['route', 'ownerAccountId', 'collectionId', 'preparationId', 'originId']) ||
    !identifier(input.consumer.route) ||
    !identifier(input.consumer.ownerAccountId) ||
    !identifier(input.consumer.collectionId) ||
    !identifier(input.consumer.preparationId) ||
    !identifier(input.consumer.originId)
  )
    return undefined;

  const inputBytes =
    128 +
    [
      input.accountId,
      input.clientId,
      input.consumer.route,
      input.consumer.ownerAccountId,
      input.consumer.collectionId,
      input.consumer.preparationId,
      input.consumer.originId,
      ...input.requestedScopes,
    ].reduce((sum, value) => sum + new TextEncoder().encode(value).byteLength, 0);
  if (inputBytes > KIND_CONSENT_ENROLLMENT_INPUT_MAX_BYTES) return undefined;

  // One keyed owner/client closure plus the exact dependency insert. These are
  // the installed Auth producer's established Source/Access axes.
  const bytes = inputBytes + input.requestedScopes.length * 128;
  return Object.freeze({
    source: Object.freeze({
      candidateKeys: 1,
      nativeRows: 3,
      identityMetadataRows: 0,
      emptySeeks: 1,
      nativePoints: 2,
      witnessKeys: 1,
      statements: 9,
      bytes: bytes + 128,
    }),
    access: Object.freeze({ keys: 1, points: 4, witnesses: 1, rows: 4, bytes: bytes + 128, emptySeeks: 1 }),
  });
}

/** Complete reservation for one private request and its bounded Auth call. */
export function kindConsentTransportBound(input: KindConsentEnrollmentInput): KindConsentWorkDeclaration | undefined {
  const native = kindConsentOperationBound(input);
  if (!native) return undefined;
  const transportBytes = KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES + KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES;
  return Object.freeze({
    source: Object.freeze({ ...native.source, bytes: native.source.bytes + transportBytes }),
    access: Object.freeze({ ...native.access, bytes: native.access.bytes + transportBytes }),
  });
}

export function kindConsentWorkWithin(
  work: unknown,
  bound: KindConsentWorkDeclaration,
): work is KindConsentWorkDeclaration {
  if (!exactRecord(work, ['source', 'access'])) return false;
  const source = work.source;
  const access = work.access;
  return (
    exactRecord(source, sourceAxes) &&
    exactRecord(access, accessAxes) &&
    sourceAxes.every((axis) => workAxisWithin(source[axis], bound.source[axis])) &&
    accessAxes.every((axis) => workAxisWithin(access[axis], bound.access[axis]))
  );
}

function workAxisWithin(value: unknown, maximum: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** Check an Auth response against the original request before exposing it. */
export function kindConsentEnrollmentResultValid(
  input: KindConsentEnrollmentInput,
  result: unknown,
): result is KindConsentEnrollmentResult {
  if (!kindConsentOperationBound(input)) return false;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  if (record.status === 'unavailable') return exactRecord(record, ['status']);
  if (record.status !== 'enrolled' || !exactRecord(record, ['status', 'reference', 'effectiveScopes'])) return false;
  const referenceValue = record.reference;
  if (!exactRecord(referenceValue, ['kind', 'id'])) return false;
  const reference = referenceValue;
  const scopes = record.effectiveScopes;
  if (
    reference.kind !== 'auth-kind-consent' ||
    !identifier(reference.id) ||
    !Array.isArray(scopes) ||
    scopes.length > MAX_CONSENTED_SCOPES ||
    !scopes.every((scope) => typeof scope === 'string' && scope.length <= 128 && scopePattern.test(scope))
  )
    return false;
  const requested = new Set(input.requestedScopes);
  return scopes.every((scope, index) => requested.has(scope) && (index === 0 || scopes[index - 1]! < scope));
}

/** Add measured wire-body bytes to the native receipt without changing axes. */
export function kindConsentTransportActual(
  input: KindConsentEnrollmentInput,
  native: unknown,
  requestBytes: number,
  responseBytes: number,
): KindConsentWorkDeclaration | undefined {
  const nativeBound = kindConsentOperationBound(input);
  if (
    !nativeBound ||
    !kindConsentWorkWithin(native, nativeBound) ||
    !Number.isSafeInteger(requestBytes) ||
    requestBytes < 0 ||
    requestBytes > KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES ||
    !Number.isSafeInteger(responseBytes) ||
    responseBytes < 0 ||
    responseBytes > KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES
  )
    return undefined;
  const bytes = requestBytes + responseBytes;
  return Object.freeze({
    source: Object.freeze({ ...native.source, bytes: native.source.bytes + bytes }),
    access: Object.freeze({ ...native.access, bytes: native.access.bytes + bytes }),
  });
}

/** A callable operation also carries pure declaration and exact actual-charge
 * functions, so consumers can reserve and settle the existing shared ledger.
 */
export interface KindConsentOperation<Input, Result> {
  (input: Input): Promise<Result>;
  bound(input: Input): KindConsentWorkDeclaration | undefined;
  actual(input: Input, result: Result): KindConsentWorkDeclaration | undefined;
}
