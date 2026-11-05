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
/** The Access assertion is checked before the enrollment body is read. */
export const KIND_CONSENT_ENROLLMENT_ACCESS_TOKEN_MAX_BYTES = 16_384;
/** Fixed request, including the trusted JWKS URL and its bounded headers. */
export const KIND_CONSENT_ENROLLMENT_JWKS_REQUEST_MAX_BYTES = 4_096;
/** Maximum streamed JWKS JSON received during a cache miss or refresh. */
export const KIND_CONSENT_ENROLLMENT_JWKS_RESPONSE_MAX_BYTES = 65_536;
/** Auth-side HTTP control and header ceiling, excluding the separately bounded Access JWT. */
export const KIND_CONSENT_ENROLLMENT_HTTP_CONTROL_MAX_BYTES = 8_192;
/** Kernel-side private request URL, method and explicit headers. */
export const KIND_CONSENT_ENROLLMENT_KERNEL_CONTROL_MAX_BYTES = 8_192;
export const KIND_CONSENT_ENROLLMENT_VERIFICATION_MAX_BYTES =
  KIND_CONSENT_ENROLLMENT_ACCESS_TOKEN_MAX_BYTES +
  KIND_CONSENT_ENROLLMENT_JWKS_REQUEST_MAX_BYTES +
  KIND_CONSENT_ENROLLMENT_JWKS_RESPONSE_MAX_BYTES +
  KIND_CONSENT_ENROLLMENT_HTTP_CONTROL_MAX_BYTES;

/** Maximum database result rows along one admitted enrollment path. */
export const KIND_CONSENT_ENROLLMENT_MAX_STATEMENTS = 11;
export const KIND_CONSENT_ENROLLMENT_MAX_POINTS = 4;
export const KIND_CONSENT_ENROLLMENT_MAX_WITNESSES = 3;
export const KIND_CONSENT_ENROLLMENT_MAX_EMPTY_SEEKS = 3;
export const KIND_CONSENT_ENROLLMENT_MAX_NATIVE_ROWS = 2;

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).byteLength;
const jsonByteLength = (value: unknown): number => byteLength(JSON.stringify(value) ?? '');
const maxScopeArray = Object.freeze(Array.from({ length: MAX_CONSENTED_SCOPES }, () => 'x'.repeat(128)));
const maxIdentifier = '\\'.repeat(1024);
const maxReferenceId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const maxCurrentRow = {
  client_id: maxIdentifier,
  client_scopes: maxScopeArray,
  first_party: false,
  ready: true,
  reducing: false,
  consent_scopes: maxScopeArray,
  pending_scopes: maxScopeArray,
  revision: '9223372036854775807',
};
// The nullable left-join consent arrays and revision are smaller than their maximum admitted values above.
const maxCurrentRefusalRow = { ...maxCurrentRow, ready: false };
const maxExistingRow = {
  reference_id: maxReferenceId,
  account_id: maxIdentifier,
  client_id: maxIdentifier,
  requested_scopes: maxScopeArray,
  effective_scopes: maxScopeArray,
  consumer_route: maxIdentifier,
  owner_account_id: maxIdentifier,
  collection_id: maxIdentifier,
  preparation_id: maxIdentifier,
  origin_id: maxIdentifier,
  active: false,
};
const emptyRowsBytes = jsonByteLength([]);
const maxCurrentRowResultBytes = jsonByteLength([maxCurrentRow]);
const maxCurrentRefusalRowResultBytes = jsonByteLength([maxCurrentRefusalRow]);
const maxExistingRowResultBytes = jsonByteLength([maxExistingRow]);
const maxInsertRowResultBytes = jsonByteLength([{ reference_id: maxReferenceId }]);
const closedFrontierResultBytes = jsonByteLength([{ '?column?': 1 }]);
const maxNativeReturnedBytes = Math.max(
  // New insert: empty frontier and existing lookups, followed by current and INSERT rows.
  2 * emptyRowsBytes + maxCurrentRowResultBytes + maxInsertRowResultBytes,
  // A suppressed INSERT RETURNING row adds a third empty result to the new path.
  3 * emptyRowsBytes + maxCurrentRowResultBytes,
  // Duplicate, inactive or refused consumer: current and existing metadata each return one row.
  emptyRowsBytes + maxCurrentRowResultBytes + maxExistingRowResultBytes,
  // A current-client refusal stops after its one returned current row.
  2 * emptyRowsBytes + maxCurrentRefusalRowResultBytes,
  // A closed frontier stops before current client/consent metadata is read.
  closedFrontierResultBytes,
);
/** Canonical JSON bytes of the largest admitted metadata result path. */
export const KIND_CONSENT_ENROLLMENT_NATIVE_RESULT_MAX_BYTES = maxNativeReturnedBytes;

export type KindConsentEnrollmentNativeUsage = Readonly<{
  candidateKeys: number;
  nativeRows: number;
  emptySeeks: number;
  nativePoints: number;
  witnessKeys: number;
  statements: number;
  returnedMetadataBytes: number;
}>;

export type KindConsentEnrollmentVerificationUsage = Readonly<{
  accessTokenBytes: number;
  jwksRequestBytes: number;
  jwksResponseBytes: number;
  httpControlBytes: number;
}>;

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

function enrollmentInputBytes(input: KindConsentEnrollmentInput): number {
  return (
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
    ].reduce((sum, value) => sum + byteLength(value), 0)
  );
}

function enrollmentInputValid(input: KindConsentEnrollmentInput): boolean {
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
    return false;
  return enrollmentInputBytes(input) <= KIND_CONSENT_ENROLLMENT_INPUT_MAX_BYTES;
}

/** Pure canonical bound for every installed Auth enrollment path. */
export function kindConsentOperationBound(input: KindConsentEnrollmentInput): KindConsentWorkDeclaration | undefined {
  if (!enrollmentInputValid(input)) return undefined;
  const bytes = enrollmentInputBytes(input) + maxNativeReturnedBytes;
  return Object.freeze({
    source: Object.freeze({
      candidateKeys: 1,
      nativeRows: KIND_CONSENT_ENROLLMENT_MAX_NATIVE_ROWS,
      identityMetadataRows: 0,
      emptySeeks: KIND_CONSENT_ENROLLMENT_MAX_EMPTY_SEEKS,
      nativePoints: KIND_CONSENT_ENROLLMENT_MAX_POINTS,
      witnessKeys: KIND_CONSENT_ENROLLMENT_MAX_WITNESSES,
      statements: KIND_CONSENT_ENROLLMENT_MAX_STATEMENTS,
      bytes,
    }),
    access: Object.freeze({
      keys: 1,
      points: KIND_CONSENT_ENROLLMENT_MAX_POINTS,
      witnesses: KIND_CONSENT_ENROLLMENT_MAX_WITNESSES,
      rows: KIND_CONSENT_ENROLLMENT_MAX_NATIVE_ROWS,
      bytes,
      emptySeeks: KIND_CONSENT_ENROLLMENT_MAX_EMPTY_SEEKS,
    }),
  });
}

/** One-use charge from the Auth query trace after a committed native attempt. */
export function kindConsentOperationActual(
  input: KindConsentEnrollmentInput,
  usage: KindConsentEnrollmentNativeUsage,
): KindConsentWorkDeclaration | undefined {
  const bound = kindConsentOperationBound(input);
  if (
    !bound ||
    !usage ||
    !Number.isSafeInteger(usage.candidateKeys) ||
    !Number.isSafeInteger(usage.nativeRows) ||
    !Number.isSafeInteger(usage.emptySeeks) ||
    !Number.isSafeInteger(usage.nativePoints) ||
    !Number.isSafeInteger(usage.witnessKeys) ||
    !Number.isSafeInteger(usage.statements) ||
    !Number.isSafeInteger(usage.returnedMetadataBytes) ||
    usage.candidateKeys < 0 ||
    usage.nativeRows < 0 ||
    usage.emptySeeks < 0 ||
    usage.nativePoints < 0 ||
    usage.witnessKeys < 0 ||
    usage.statements < 0 ||
    usage.returnedMetadataBytes < 0
  )
    return undefined;
  const bytes = enrollmentInputBytes(input) + usage.returnedMetadataBytes;
  const work: KindConsentWorkDeclaration = Object.freeze({
    source: Object.freeze({
      candidateKeys: usage.candidateKeys,
      nativeRows: usage.nativeRows,
      identityMetadataRows: 0,
      emptySeeks: usage.emptySeeks,
      nativePoints: usage.nativePoints,
      witnessKeys: usage.witnessKeys,
      statements: usage.statements,
      bytes,
    }),
    access: Object.freeze({
      keys: usage.candidateKeys,
      points: usage.nativePoints,
      witnesses: usage.witnessKeys,
      rows: usage.nativeRows,
      bytes,
      emptySeeks: usage.emptySeeks,
    }),
  });
  return kindConsentWorkWithin(work, bound) ? work : undefined;
}

/** Auth's verified receipt adds the bounded verifier and HTTP control it owned. */
export function kindConsentEnrollmentVerifiedBound(
  input: KindConsentEnrollmentInput,
): KindConsentWorkDeclaration | undefined {
  const native = kindConsentOperationBound(input);
  if (!native) return undefined;
  const bytes = native.source.bytes + KIND_CONSENT_ENROLLMENT_VERIFICATION_MAX_BYTES;
  return Object.freeze({
    source: Object.freeze({ ...native.source, bytes }),
    access: Object.freeze({ ...native.access, bytes }),
  });
}

/** Exact Auth-side verifier and incoming/outgoing control charge for one call. */
export function kindConsentEnrollmentVerifiedActual(
  input: KindConsentEnrollmentInput,
  native: unknown,
  usage: KindConsentEnrollmentVerificationUsage,
): KindConsentWorkDeclaration | undefined {
  const nativeBound = kindConsentOperationBound(input);
  const verifiedBound = kindConsentEnrollmentVerifiedBound(input);
  if (
    !nativeBound ||
    !verifiedBound ||
    !kindConsentWorkWithin(native, nativeBound) ||
    !usage ||
    !Number.isSafeInteger(usage.accessTokenBytes) ||
    usage.accessTokenBytes < 0 ||
    usage.accessTokenBytes > KIND_CONSENT_ENROLLMENT_ACCESS_TOKEN_MAX_BYTES ||
    !Number.isSafeInteger(usage.jwksRequestBytes) ||
    usage.jwksRequestBytes < 0 ||
    usage.jwksRequestBytes > KIND_CONSENT_ENROLLMENT_JWKS_REQUEST_MAX_BYTES ||
    !Number.isSafeInteger(usage.jwksResponseBytes) ||
    usage.jwksResponseBytes < 0 ||
    usage.jwksResponseBytes > KIND_CONSENT_ENROLLMENT_JWKS_RESPONSE_MAX_BYTES ||
    !Number.isSafeInteger(usage.httpControlBytes) ||
    usage.httpControlBytes < 0 ||
    usage.httpControlBytes > KIND_CONSENT_ENROLLMENT_HTTP_CONTROL_MAX_BYTES
  )
    return undefined;
  const verifierBytes =
    usage.accessTokenBytes + usage.jwksRequestBytes + usage.jwksResponseBytes + usage.httpControlBytes;
  const bytes = native.source.bytes + verifierBytes;
  const actual: KindConsentWorkDeclaration = Object.freeze({
    source: Object.freeze({ ...native.source, bytes }),
    access: Object.freeze({ ...native.access, bytes }),
  });
  return kindConsentWorkWithin(actual, verifiedBound) ? actual : undefined;
}

/** Complete reservation for one private request and its bounded Auth call. */
export function kindConsentTransportBound(input: KindConsentEnrollmentInput): KindConsentWorkDeclaration | undefined {
  const native = kindConsentOperationBound(input);
  if (!native) return undefined;
  const transportBytes =
    KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES +
    KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES +
    KIND_CONSENT_ENROLLMENT_VERIFICATION_MAX_BYTES +
    KIND_CONSENT_ENROLLMENT_KERNEL_CONTROL_MAX_BYTES;
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
  verified: unknown,
  requestBytes: number,
  responseBytes: number,
  kernelControlBytes: number,
): KindConsentWorkDeclaration | undefined {
  const verifiedBound = kindConsentEnrollmentVerifiedBound(input);
  if (
    !verifiedBound ||
    !kindConsentWorkWithin(verified, verifiedBound) ||
    !Number.isSafeInteger(requestBytes) ||
    requestBytes < 0 ||
    requestBytes > KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES ||
    !Number.isSafeInteger(responseBytes) ||
    responseBytes < 0 ||
    responseBytes > KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES ||
    !Number.isSafeInteger(kernelControlBytes) ||
    kernelControlBytes < 0 ||
    kernelControlBytes > KIND_CONSENT_ENROLLMENT_KERNEL_CONTROL_MAX_BYTES
  )
    return undefined;
  const bytes = requestBytes + responseBytes + kernelControlBytes;
  const actual: KindConsentWorkDeclaration = Object.freeze({
    source: Object.freeze({ ...verified.source, bytes: verified.source.bytes + bytes }),
    access: Object.freeze({ ...verified.access, bytes: verified.access.bytes + bytes }),
  });
  const bound = kindConsentTransportBound(input);
  return bound && kindConsentWorkWithin(actual, bound) ? actual : undefined;
}

/** A callable operation also carries pure declaration and exact actual-charge
 * functions, so consumers can reserve and settle the existing shared ledger.
 */
export interface KindConsentOperation<Input, Result> {
  (input: Input): Promise<Result>;
  bound(input: Input): KindConsentWorkDeclaration | undefined;
  actual(input: Input, result: Result): KindConsentWorkDeclaration | undefined;
}
