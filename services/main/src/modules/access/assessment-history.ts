import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { MAX_STAGED_CHANGE_BYTES } from './protected-set-schema.ts';

const ACTION = 'verification.claim-assess';
const SCOPE = 'verification:assess:global';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NATIVE_PREFIX = 'https://rezics.com/id/';
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ZERO = '00000000-0000-0000-0000-000000000000';
export const ASSESSMENT_HISTORY_PAGE_SIZE = 32;
export class AssessmentHistoryUnavailable extends Error {}

// Bound transport before decoding. A corrupt text value still yields its UUID,
// but cannot make the owner fetch an unbounded value into the caller process.
const oversized = `(octet_length(a.acting_subject)::bigint + octet_length(a.scope_id)
  + octet_length(a.action) + octet_length(a.idempotency_key) + octet_length(a.request_digest)
  + COALESCE(octet_length(a.graph_receipt), 0) + COALESCE(octet_length(a.graph_outcome), 0)
  + COALESCE(octet_length(a.graph_data_epoch), 0) + COALESCE(octet_length(a.graph_sequence), 0)
  + octet_length(a.state)) > ${MAX_STAGED_CHANGE_BYTES}`;
const bounded = (field: string) =>
  `CASE WHEN ${oversized} THEN NULL ELSE a.${field} END AS ${field}`;
const projection = `SELECT a.id, a.principal_id,
  ${[
    'acting_subject',
    'scope_id',
    'action',
    'idempotency_key',
    'request_digest',
    'state',
    'graph_receipt',
    'graph_outcome',
    'graph_data_epoch',
    'graph_sequence',
  ]
    .map(bounded)
    .join(',\n  ')},
  a.authority_epoch::text AS authority_epoch, a.registered_at, a.expires_at,
  a.claimed_at, a.sealed_at, ${oversized} AS oversized_fields
  FROM access.admission AS a
  WHERE a.action = '${ACTION}'`;
export const ASSESSMENT_HISTORY_SQL = {
  initial: `${projection} AND a.id >= $1::uuid ORDER BY a.id LIMIT 33 FOR SHARE OF a`,
  continuation: `${projection} AND a.id > $1::uuid ORDER BY a.id LIMIT 33 FOR SHARE OF a`,
} as const;

export interface AssessmentAdmissionFacts {
  principalId: string;
  actingSubject: string;
  scope: string;
  action: string;
  idempotencyKey: string;
  requestDigest: string;
  authorityEpoch: string;
  registeredAt: string;
  expiresAt: string;
  claimedAt: string | null;
  state: 'registered' | 'claimed' | 'sealed';
  graphReceipt: string | null;
  graphOutcome: 'succeeded' | 'cancelled' | null;
  graphDataEpoch: string | null;
  graphSequence: string | null;
  sealedAt: string | null;
}
type Unresolved = 'malformed-fields' | 'oversized-fields' | 'unexpected-scope' | 'in-flight';
export interface AssessmentHistoryRow {
  id: string;
  facts: AssessmentAdmissionFacts | null;
  unresolved: Unresolved[];
  /** Access never retained the original C/R, input, expected summary or tail. */
  originalCustody: 'unknown';
  /** Lookup identity, including when Access has no graph acknowledgement. */
  nativeReceipt: string;
}
export interface AssessmentHistoryPage {
  rows: AssessmentHistoryRow[];
  next: AssessmentHistoryCursor | null;
  windowExhausted: boolean;
  cut:
    | { state: 'held'; recoveryGeneration: string }
    | { state: 'unresolved'; reason: 'access-not-quiesced' };
  /** Admission population only; never original-input or native completeness. */
  endOfHistory: boolean;
}

/** Existing cut facts bind the seek; this is not a custody or completion seal. */
export interface AssessmentHistoryCursor {
  after: string;
  recoveryGeneration: string | null;
}
export type AssessmentHistoryRequest =
  | { cursor?: never; recoveryGeneration?: string }
  | { cursor: AssessmentHistoryCursor; recoveryGeneration?: never };

const instant = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());
const nullableInstant = (value: unknown) => value === null || instant(value);
const nullableText = (value: unknown) =>
  value === null || (typeof value === 'string' && value.length > 0);

function decode(row: QueryResultRow): AssessmentHistoryRow {
  const nativeReceipt = `urn:rezics:receipt:${createHash('sha256').update(`${row.id}\0claim-assess`).digest('hex')}`;
  const base = { id: row.id as string, originalCustody: 'unknown' as const, nativeReceipt };
  if (row.oversized_fields === true)
    return { ...base, facts: null, unresolved: ['oversized-fields'] };
  if (
    typeof row.principal_id !== 'string' ||
    !UUID.test(row.principal_id) ||
    typeof row.acting_subject !== 'string' ||
    !row.acting_subject.startsWith(NATIVE_PREFIX) ||
    !UUID.test(row.acting_subject.slice(NATIVE_PREFIX.length)) ||
    typeof row.scope_id !== 'string' ||
    !row.scope_id ||
    row.scope_id.length > 256 ||
    row.action !== ACTION ||
    typeof row.idempotency_key !== 'string' ||
    row.idempotency_key.length < 1 ||
    row.idempotency_key.length > 128 ||
    typeof row.request_digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.request_digest) ||
    typeof row.authority_epoch !== 'string' ||
    !DECIMAL.test(row.authority_epoch) ||
    !instant(row.registered_at) ||
    !instant(row.expires_at) ||
    !nullableInstant(row.claimed_at) ||
    !nullableInstant(row.sealed_at) ||
    !['registered', 'claimed', 'sealed'].includes(row.state) ||
    ![row.graph_receipt, row.graph_data_epoch, row.graph_sequence].every(nullableText) ||
    ![null, 'succeeded', 'cancelled'].includes(row.graph_outcome) ||
    (row.graph_sequence !== null && !/^[0-9]+$/.test(row.graph_sequence)) ||
    (row.state === 'claimed' && !instant(row.claimed_at)) ||
    (row.state === 'sealed'
      ? row.graph_receipt !== nativeReceipt ||
        row.graph_outcome === null ||
        row.graph_data_epoch === null ||
        row.graph_sequence === null ||
        !instant(row.sealed_at)
      : [
          row.graph_receipt,
          row.graph_outcome,
          row.graph_data_epoch,
          row.graph_sequence,
          row.sealed_at,
        ].some((value) => value !== null))
  ) {
    return { ...base, facts: null, unresolved: ['malformed-fields'] };
  }
  const facts: AssessmentAdmissionFacts = {
    principalId: row.principal_id,
    actingSubject: row.acting_subject,
    scope: row.scope_id,
    action: row.action,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    authorityEpoch: row.authority_epoch,
    registeredAt: row.registered_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    claimedAt: row.claimed_at?.toISOString() ?? null,
    state: row.state,
    graphReceipt: row.graph_receipt,
    graphOutcome: row.graph_outcome,
    graphDataEpoch: row.graph_data_epoch,
    graphSequence: row.graph_sequence,
    sealedAt: row.sealed_at?.toISOString() ?? null,
  };
  if (Buffer.byteLength(JSON.stringify(facts)) > MAX_STAGED_CHANGE_BYTES) {
    return { ...base, facts: null, unresolved: ['oversized-fields'] };
  }
  const unresolved: Unresolved[] = [];
  if (facts.scope !== SCOPE) unresolved.push('unexpected-scope');
  if (facts.state !== 'sealed') unresolved.push('in-flight');
  return { ...base, facts, unresolved };
}

/** Private operator/kernel boundary, with the caller's one real RC transaction.
 * No checkout, lifecycle or timeout changes. The existing global recovery fence
 * waits for ordinary Access writers and blocks their registration/claim/ack;
 * operator repair writers must remain quiesced for the traversal. A scope-only
 * closure or Content closure cannot substitute for that action-wide cut.
 * Retain/recheck earlier unresolved IDs if scanning without the held cut.
 */
export async function readVerificationAssessmentHistory(
  client: PoolClient,
  request: AssessmentHistoryRequest = {},
): Promise<AssessmentHistoryPage> {
  const cursor = request.cursor;
  const recoveryGeneration =
    cursor?.recoveryGeneration ?? (cursor ? null : request.recoveryGeneration);
  if (
    (cursor !== undefined &&
      (cursor === null ||
        typeof cursor.after !== 'string' ||
        !UUID.test(cursor.after) ||
        (cursor.recoveryGeneration !== null &&
          (typeof cursor.recoveryGeneration !== 'string' ||
            !DECIMAL.test(cursor.recoveryGeneration))) ||
        request.recoveryGeneration !== undefined)) ||
    (recoveryGeneration !== undefined &&
      recoveryGeneration !== null &&
      (typeof recoveryGeneration !== 'string' || !DECIMAL.test(recoveryGeneration)))
  ) {
    throw new AssessmentHistoryUnavailable('Invalid assessment history position');
  }
  // SAVEPOINT fails in autocommit without starting or ending a transaction.
  await client.query('SAVEPOINT assessment_history_transaction');
  await client.query('RELEASE SAVEPOINT assessment_history_transaction');
  const isolation = (await client.query('SHOW transaction_isolation')).rows[0]
    ?.transaction_isolation;
  if (isolation !== 'read committed') {
    throw new AssessmentHistoryUnavailable(
      'Assessment history requires a caller READ COMMITTED transaction',
    );
  }
  let cut: AssessmentHistoryPage['cut'] = { state: 'unresolved', reason: 'access-not-quiesced' };
  if (recoveryGeneration !== undefined && recoveryGeneration !== null) {
    const fence = (
      await client.query(`SELECT open, generation::text AS generation
      FROM access.recovery_fence WHERE id = true FOR SHARE`)
    ).rows[0];
    if (fence?.open !== false || fence.generation !== recoveryGeneration) {
      throw new AssessmentHistoryUnavailable('Assessment history Access cut changed');
    }
    cut = { state: 'held', recoveryGeneration: fence.generation };
  }
  const raw = (
    await client.query(
      cursor === undefined ? ASSESSMENT_HISTORY_SQL.initial : ASSESSMENT_HISTORY_SQL.continuation,
      [cursor?.after ?? ZERO],
    )
  ).rows;
  const emitted = raw.slice(0, ASSESSMENT_HISTORY_PAGE_SIZE);
  const windowExhausted = raw.length <= ASSESSMENT_HISTORY_PAGE_SIZE;
  return {
    rows: emitted.map(decode),
    next: windowExhausted
      ? null
      : { after: emitted.at(-1)!.id, recoveryGeneration: recoveryGeneration ?? null },
    windowExhausted,
    cut,
    endOfHistory: windowExhausted && cut.state === 'held',
  };
}
