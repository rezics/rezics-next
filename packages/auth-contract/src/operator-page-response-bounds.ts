import { securityJsonStringBytes, securityResponseLimits } from './security-response-bounds';

/** Shared native fields for the separate operator opening and transfer pages.
 * Selected IDs are lowercase routed UUIDs. Relation versions come from
 * access.account.operator_relation_version bigint via ::text, never Number.
 */
export const OPERATOR_PAGE_ID_BYTES = 36;
export const OPERATOR_PAGE_MAX_VERSION = '9223372036854775807';
export const OPERATOR_PAGE_MAX_VERSION_BYTES = OPERATOR_PAGE_MAX_VERSION.length;
export function isOperatorPageVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]*)$/.exec(value)?.[0] === value &&
    value.length <= OPERATOR_PAGE_MAX_VERSION_BYTES &&
    (value.length < OPERATOR_PAGE_MAX_VERSION_BYTES || value <= OPERATOR_PAGE_MAX_VERSION)
  );
}
export function isOperatorPageId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === OPERATOR_PAGE_ID_BYTES &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

// Empty fields count every key, quote and punctuation. The only variable text
// is UUID36 or canonical nonnegative bigint decimal19: both are ASCII without
// JSON escapes. All other values are closed literals, not arbitrary TS strings.
// Source is largest; readiness, viewer continuation and every terminal branch
// are included explicitly so these remain independent of catalogue size C.
const source = {
  viewer: { kind: 'ready' },
  review: {
    kind: 'source',
    relation: { previous: { operatorAccountId: '', subjectAccountId: '', reservationId: '' }, expectedVersion: '' },
    action: 'allowed',
  },
};
const destination = {
  viewer: { kind: 'ready' },
  review: { kind: 'destination', destinationAccountId: '', action: 'allowed' },
};
const terminal = ['readiness', 'missing', 'refused', 'changed', 'unavailable'].map(
  (kind) => JSON.stringify({ viewer: { kind: 'ready' }, review: { kind } }).length,
);
const viewer = [
  { kind: 'authentication-required', continuation: 'operator-transfer' },
  { kind: 'signed-out' },
  { kind: 'refused' },
].map((viewer) => JSON.stringify({ viewer, review: { kind: 'unavailable' } }).length);
export const OPERATOR_TRANSFER_PAGE_MAX_RESPONSE_BYTES = Math.max(
  JSON.stringify(source).length + 3 * OPERATOR_PAGE_ID_BYTES + OPERATOR_PAGE_MAX_VERSION_BYTES,
  JSON.stringify(destination).length + OPERATOR_PAGE_ID_BYTES,
  ...terminal,
  ...viewer,
);
// This endpoint's non-200 bodies are the same closed page DTO, not command
// errors. No third-party message, identifier, exception or Retry-After is echoed.
export const OPERATOR_TRANSFER_PAGE_MAX_ERROR_BYTES = Math.max(
  JSON.stringify({ viewer: { kind: 'refused' }, review: { kind: 'refused' } }).length,
  JSON.stringify({ viewer: { kind: 'ready' }, review: { kind: 'unavailable' } }).length,
);

// Opening uses an opaque native SessionProof viewer ID (1,024 UTF-16 units),
// not a selected UUID. Three selected/relation UUIDs and bigint19 are ASCII.
// The manage-only profile emits no labels, human proof, scopes or catalogue.
const opening = {
  stage: 'current',
  viewer: { accountId: '' },
  subject: { id: '', kind: 'actor' },
  operator: { id: '', kind: 'organization' },
  relation: { reservationId: '', version: '' },
  disclosure: 'unavailable',
  allowedActions: ['opening'],
};
export const OPERATOR_OPENING_PAGE_MAX_ERROR_BYTES = Math.max(
  ...['step-up', 'refused', 'unavailable'].map((stage) => JSON.stringify({ stage }).length),
);
export const OPERATOR_OPENING_PAGE_MAX_RESPONSE_BYTES = Math.max(
  JSON.stringify(opening).length +
    securityJsonStringBytes(securityResponseLimits.id) -
    2 +
    3 * OPERATOR_PAGE_ID_BYTES +
    OPERATOR_PAGE_MAX_VERSION_BYTES,
  OPERATOR_OPENING_PAGE_MAX_ERROR_BYTES,
);
