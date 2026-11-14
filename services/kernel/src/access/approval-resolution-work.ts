import { MAX_CONSENTED_SCOPES, MAX_CONSENTED_SCOPE_OCTETS } from '@rezics/auth-contract';
import { AccessUnavailableError, throwAccessUnavailable } from './unavailable.ts';
import type { AccessWork, AccessWorkAccounting } from './work.ts';

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null');
const uuid = 'x'.repeat(36);
const timestamp = 'x'.repeat(64);
const bigint = '9'.repeat(19);
// The workflow_approval schema bounds JSONB operation text, scope octets and
// cardinality. Text columns need up to six JSON bytes per character; scope
// strings need up to six per source octet, plus array/null/separator overhead.
const approvalFields = {
  route: 65535,
  approvalId: uuid,
  actorId: uuid,
  clientId: '',
  scopes: [],
  requestedBy: '',
  authnEpoch: bigint,
  operationKey: '',
  operation: {},
  digest: 'x'.repeat(64),
  createdAt: timestamp,
  expiresAt: timestamp,
  jwtExpiresAt: timestamp,
  transactionId: uuid,
};
const approvalPayloadBytes =
  6 * (1024 + 100 + 255 + MAX_CONSENTED_SCOPE_OCTETS) +
  5 * MAX_CONSENTED_SCOPES +
  Math.max(16384, MAX_CONSENTED_SCOPE_OCTETS + 2 * MAX_CONSENTED_SCOPES + 4096);
const approvalBytes = bytes(approvalFields) + approvalPayloadBytes;

/** Policy for the public bounded-read primitive, preserving the first storage
 * failure rather than reclassifying it using a later wall-clock observation. */
export const approvalResolutionReadOptions = Object.freeze({
  deadlineError: () => new AccessUnavailableError('deadline'),
  mapError(error: unknown) {
    throwAccessUnavailable(error);
    return error;
  },
  isUncertainSettledQueryError: () => true,
});

type ResolutionRead =
  | 'approval'
  | 'creation-receipt'
  | 'consumed-credential'
  | 'client-anchor'
  | 'owners'
  | 'tombstone-operator'
  | 'operator-account'
  | 'operator-slot';

/** Declarations belong to the explicit native SQL call sites. Rows are finite
 * plan candidates/intermediates, including misses, never returned rowCount.
 * Receipt rotation contributes one exact key per retained version plus the raw
 * transitional key (at most five, supplied by nativeReceiptKeyCandidates).
 */
export function approvalResolutionDeclaration(operation: ResolutionRead, input: unknown, receiptKeys = 0) {
  let keys = 1;
  let seeks = 1;
  let rows = 1;
  let projection: number;
  switch (operation) {
    case 'approval':
      rows = 2; // scalar time input and the exact immutable approval
      projection = approvalBytes;
      break;
    case 'creation-receipt':
      keys = seeks = rows = receiptKeys;
      projection = bytes({
        requestDigest: Buffer.alloc(32, 255),
        epoch: 2147483647,
        position: bigint,
        transactionId: uuid,
        response: { reference: 'x'.repeat(4096), expiresAt: timestamp },
        payloadState: 'minimized',
      });
      break;
    case 'consumed-credential':
      rows = 2;
      // The existing reader also returns to_jsonb(workflow_approval), including
      // consumption and generated attribution columns; both projections count.
      projection =
        approvalBytes +
        approvalPayloadBytes +
        bytes({
          data: {
            route: 65535,
            approval_id: uuid,
            actor_id: uuid,
            client_id: '',
            scopes: [],
            requested_by: '',
            authn_epoch: Number.MAX_SAFE_INTEGER,
            operation_key: '',
            operation: {},
            digest: 'x'.repeat(64),
            created_at: timestamp,
            expires_at: timestamp,
            jwt_expires_at: timestamp,
            transaction_id: uuid,
            consumed_at: timestamp,
            consumed_transaction_id: uuid,
            erasure_subject_id: uuid,
            erasure_operator_id: uuid,
            erasure_member_id: uuid,
            erasure_previous_operator_id: uuid,
            erasure_previous_subject_id: uuid,
            erasure_principal_id: uuid,
          },
        });
      break;
    case 'client-anchor':
      projection = bytes({ context_id: uuid });
      break;
    case 'owners':
      keys = 3; // LIMIT 2 owner candidates and LIMIT 1 exact member
      seeks = 2;
      rows = 8; // scalar, two owners, member/filter, two counts and output
      projection = bytes({ owners: 2, target: 1 });
      break;
    case 'tombstone-operator':
      // Approval and rotated receipts, then one tombstone probe per possible
      // consumed transaction. Count both UNION branches in the finite ceiling.
      keys = seeks = 2 + 2 * receiptKeys;
      rows = 4 + 3 * receiptKeys; // scalar/approval, consumed union and fence joins
      projection = bytes({ priorOperatorAccountId: uuid });
      break;
    case 'operator-account':
      projection = bytes({
        accountId: uuid,
        kind: 'organization',
        state: 'suspended',
        operatorAccountId: uuid,
        minimumAuthnEpoch: bigint,
        fenced: false,
        version: bigint,
        reservationId: uuid,
        observedAt: timestamp,
      });
      break;
    case 'operator-slot':
      projection = bytes({ operatorAccountId: uuid, terminal: false });
      break;
  }
  const bound: AccessWork = Object.freeze({
    keys,
    points: seeks + 1,
    witnesses: 0,
    rows,
    bytes: bytes(input) + projection,
    emptySeeks: 1,
  });
  return {
    bound,
    actual(result: unknown): AccessWork {
      return {
        ...bound,
        bytes: bytes(input) + bytes(result),
        emptySeeks: result === null || result === undefined || (Array.isArray(result) && !result.length) ? 1 : 0,
      };
    },
  };
}

/** Uses the caller's accounting; no allowance or physical read helper is added. */
export function approvalResolutionNativeWork<T>(
  work: AccessWorkAccounting | undefined,
  operation: ResolutionRead,
  input: unknown,
  dispatch: () => Promise<T>,
  receiptKeys = 0,
): Promise<T> {
  if (!work) return dispatch();
  const declaration = approvalResolutionDeclaration(operation, input, receiptKeys);
  return work.run(`access.workflow-approval.${operation}`, declaration.bound, dispatch, declaration.actual);
}
