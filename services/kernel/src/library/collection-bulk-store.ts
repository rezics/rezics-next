import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { CommandTransaction } from '../command/command.ts';
import type { DurableInitiatorRecord } from '../access/durable-initiator.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { EntryState } from './entry-model.ts';
import type {
  BulkAdmission, BulkReason, OccurrenceTarget, ReceiptLocator, SubjectTarget, TerminalOutcome,
} from './bulk-contract.ts';

export const COLLECTION_BULK_TARGET_LIMIT = 1_000;
export const COLLECTION_BULK_PAGE_LIMIT = 100;
const JSON_BYTES = 131_072;
const TARGET_BYTES = 4_096;
export type CollectionBulkTarget =
  | Omit<SubjectTarget, 'operationId' | 'ordinal'>
  | (Omit<OccurrenceTarget, 'operationId' | 'ordinal'> & { revision: number });
export type CollectionBulkIntent = (
  | { action: 'set_status'; state: EntryState }
  | { action: 'add_to_collection' | 'remove_from_collection'; collectionId: string }
  | { action: 'remove_from_library' }
) & { selection: { kind: 'explicit' | 'occurrences' } | Extract<BulkAdmission['selection'], { kind: 'query' }> };
export type CollectionBulkKey = { route: number; accountId: string; operationId: string };
export type CollectionBulkOperation = {
  operationId: string;
  phase: 'preview' | 'applying' | 'completed';
  targetCount: number;
  request: CollectionBulkIntent;
  initiator: DurableInitiatorRecord;
  sourceDigest: string;
  expiresAt: string;
  resultsExpireAt: string;
};
export type CollectionBulkOutcome = {
  state: TerminalOutcome;
  reason: BulkReason | null;
  resultingMemberId?: string | null;
};
export type CollectionBulkManifestRow = {
  ordinal: string;
  target: CollectionBulkTarget;
  receipt: ReceiptLocator;
  state: 'pending' | TerminalOutcome;
  reason: BulkReason | null;
  resultingMemberId: string | null;
};
export class CollectionBulkSelectionTooLarge extends Error {
  constructor() { super('Select at most 1,000 targets. Narrow the selection and preview again.'); }
}

function key(input: CollectionBulkKey): void {
  if (routeOf(input.accountId) !== input.route || routeOf(input.operationId) !== input.route)
    throw new RangeError('Owner and operation must carry the source route');
}
function json(value: unknown, maxBytes = JSON_BYTES): string {
  const result = canonicalize(value);
  if (typeof result !== 'string' || Buffer.byteLength(result) > maxBytes)
    throw new RangeError('Bulk intent exceeds its byte limit');
  return result;
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function targetKey(target: CollectionBulkTarget): string {
  if (routeOf(target.subjectId) === null) throw new TypeError('Invalid subject');
  if (target.kind === 'subject') {
    const expected = target.expected;
    if (expected.kind === 'present') {
      if (routeOf(expected.incarnation) === null || !Number.isSafeInteger(expected.revision) || expected.revision < 1 ||
        !/^(0|[1-9][0-9]*)$/.test(expected.admissionSequence)) throw new TypeError('Invalid entry expectation');
    } else if (expected.kind !== 'absent' || !/^(0|[1-9][0-9]*)$/.test(expected.slotGeneration)) {
      throw new TypeError('Invalid absent entry expectation');
    }
    return target.subjectId;
  }
  if (routeOf(target.collectionId) === null || routeOf(target.collectionId) !== routeOf(target.memberId) ||
    routeOf(target.incarnation) === null || !Number.isSafeInteger(target.revision) || target.revision < 1 ||
    !/^(0|[1-9][0-9]*)$/.test(target.admissionSequence)) throw new TypeError('Invalid occurrence expectation');
  return `${target.collectionId}:${target.memberId}`;
}

/** Source readers must already provide canonical, currently authorized targets in an indexed order.
 * Request only remaining+1 rows per bounded page; stop at 1,001, before any manifest write.
 */
export async function collectCollectionBulkTargets(
  readPage: (after: string | null, limit: number) => Promise<{
    targets: readonly CollectionBulkTarget[]; next: string | null;
  }>,
): Promise<CollectionBulkTarget[]> {
  const targets: CollectionBulkTarget[] = [];
  let after: string | null = null;
  for (let pages = 0; pages <= COLLECTION_BULK_TARGET_LIMIT; pages++) {
    const limit = Math.min(COLLECTION_BULK_PAGE_LIMIT, COLLECTION_BULK_TARGET_LIMIT + 1 - targets.length);
    const page = await readPage(after, limit);
    if (page.targets.length > limit || (page.next !== null && (page.next === after || page.targets.length === 0)))
      throw new Error('Source must make bounded progress');
    targets.push(...page.targets);
    if (targets.length > COLLECTION_BULK_TARGET_LIMIT) throw new CollectionBulkSelectionTooLarge();
    if (page.next === null) return targets;
    after = page.next;
  }
  throw new Error('Source exceeded the bounded page count');
}

/** Internal store only. The caller owns the native command transaction, receipt, live Access and
 * durable-initiator capture/restoration. Stored intent is never an authorization grant.
 */
export async function previewCollectionBulk(
  tx: CommandTransaction,
  input: CollectionBulkKey & {
    request: BulkAdmission; targets: readonly CollectionBulkTarget[]; initiator: DurableInitiatorRecord;
    creationReceipt: ReceiptLocator; transactionId: string; now: string;
  },
): Promise<CollectionBulkOperation> {
  key(input);
  if (input.targets.length > COLLECTION_BULK_TARGET_LIMIT) throw new CollectionBulkSelectionTooLarge();
  const intent: CollectionBulkIntent = { ...input.request, selection: input.request.selection.kind === 'query'
    ? input.request.selection : { kind: input.request.selection.kind } };
  const request = json(intent);
  const initiator = json(input.initiator);
  const receipt = input.creationReceipt;
  if (receipt.principalId !== input.accountId || receipt.principalKind !== 'account' ||
    receipt.partition !== partitionOf(input.route) || !/^[a-f0-9]{64}$/.test(receipt.digest) ||
    receipt.key.length < 1 || receipt.key.length > 255 || receipt.commandKind.length < 1 || receipt.commandKind.length > 255)
    throw new TypeError('Creation receipt must bind the native owner command');
  const seen = new Set<string>();
  const targets = input.targets.map((target, ordinal) => {
    const identity = targetKey(target);
    if (seen.has(identity)) throw new TypeError('Duplicate manifest target');
    seen.add(identity);
    if (input.request.action === 'remove_from_collection' && target.kind === 'occurrence' &&
      target.collectionId !== input.request.collectionId) throw new TypeError('Occurrence belongs to another Collection');
    const frozen = JSON.parse(json(target, TARGET_BYTES)) as CollectionBulkTarget;
    return { ...frozen, operationId: input.operationId, ordinal: String(ordinal) };
  });
  const sourceDigest = digest(json({ request: intent, targets, initiator: input.initiator, creationReceipt: receipt }, 4_300_000));
  const created = await tx.query(`INSERT INTO library.bulk_operation
    (route,operation_id,account_id,request,initiator,creation_receipt,source_digest,target_count,phase,
      admitted_at,expires_at,results_expire_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'preview',$9,$9::timestamptz+interval '24 hours',
      $9::timestamptz+interval '48 hours') ON CONFLICT DO NOTHING RETURNING operation_id`,
    [input.route,input.operationId,input.accountId,request,initiator,json(receipt),sourceDigest,targets.length,input.now]);
  if (created.rowCount) {
    // One native insert, into the installed manifest; no workflow payload or second target list.
    await tx.query(`INSERT INTO library.bulk_target
      (route,operation_id,ordinal,account_id,subject_id,target_kind,collection_id,member_id,target,
        source_digest,receipt,created_transaction_id,state,chunk_index)
      SELECT $1,$2,(n-1),$3,(target->>'subjectId')::uuid,target->>'kind',
        (target->>'collectionId')::uuid,(target->>'memberId')::uuid,target,$5,
        jsonb_build_object('partition',$7::integer,'principalKind','account','principalId',$3::text,
          'commandKind','library.collectionBulk.target','key',$2::text||':'||(n-1)::text,
          'digest',encode(sha256(convert_to(target::text,'UTF8')),'hex')),$6,'pending',(n-1)/100
      FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS manifest(target,n) WHERE n <= 1000`,
      [input.route,input.operationId,input.accountId,JSON.stringify(targets),sourceDigest,input.transactionId,partitionOf(input.route)]);
  }
  const operation = await readCollectionBulk(tx, input);
  if (!operation || operation.sourceDigest !== sourceDigest) throw new Error('Bulk operation identity conflicts with its preview');
  return operation;
}

export async function readCollectionBulk(
  tx: CommandTransaction, input: CollectionBulkKey,
): Promise<CollectionBulkOperation | null> {
  key(input);
  const rows = await tx.query<CollectionBulkOperation>(`SELECT operation_id AS "operationId", phase,
    target_count AS "targetCount", request, initiator, source_digest AS "sourceDigest",
    expires_at::text AS "expiresAt", results_expire_at::text AS "resultsExpireAt"
    FROM library.bulk_operation WHERE route=$1 AND operation_id=$2 AND account_id=$3`,
    [input.route,input.operationId,input.accountId]);
  return rows.rows[0] ?? null;
}

/** Returns true only for the transition; its native caller emits the registered Core outbox event
 * in this same command. Retries do not enqueue another execution or rerun the source filter.
 */
export async function confirmCollectionBulk(
  tx: CommandTransaction, input: CollectionBulkKey & { now: string },
): Promise<boolean> {
  key(input);
  const result = await tx.query(`UPDATE library.bulk_operation SET phase=CASE WHEN target_count=0
    THEN 'completed' ELSE 'applying' END, confirmed_at=$4
    WHERE route=$1 AND operation_id=$2 AND account_id=$3 AND phase='preview' AND expires_at>$4
    RETURNING operation_id`, [input.route,input.operationId,input.accountId,input.now]);
  return result.rowCount === 1;
}

export async function pageCollectionBulkManifest(
  tx: CommandTransaction, input: CollectionBulkKey & { after?: number; limit?: number; pendingOnly?: boolean },
): Promise<CollectionBulkManifestRow[]> {
  key(input);
  const after = input.after ?? -1, limit = input.limit ?? COLLECTION_BULK_PAGE_LIMIT;
  if (!Number.isSafeInteger(after) || after < -1 || after >= COLLECTION_BULK_TARGET_LIMIT ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > COLLECTION_BULK_PAGE_LIMIT) throw new RangeError('Invalid manifest page');
  // Separate predicates let PostgreSQL use the installed partial pending index.
  const rows = await tx.query<CollectionBulkManifestRow>(`SELECT ordinal::text, target, receipt, state, reason, resulting_member_id AS "resultingMemberId"
    FROM library.bulk_target WHERE route=$1 AND operation_id=$2 AND account_id=$3
      AND ordinal>$4 AND ordinal<1000 ${input.pendingOnly ? "AND state IN ('pending','reconciling')" : ''}
    ORDER BY ordinal LIMIT $5`, [input.route,input.operationId,input.accountId,after,limit]);
  return rows.rows;
}

export type ApplyCollectionBulkTarget = (
  tx: CommandTransaction, operation: CollectionBulkOperation, row: CollectionBulkManifestRow,
) => Promise<CollectionBulkOutcome>;

/** Same-home native seam. apply must check the captured revision/incarnation in the actual write
 * (return conflict/revision_mismatch for a changed entry), retain current authorization, and return
 * native events to its surrounding command. Remote commands need their exact persisted receipt and
 * reconciliation in the Library worker; they must not be called from this same-home seam.
 */
export async function applyCollectionBulkTarget(
  tx: CommandTransaction,
  input: CollectionBulkKey & { ordinal: number; now: string },
  apply: ApplyCollectionBulkTarget,
): Promise<CollectionBulkOutcome | null> {
  key(input);
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal >= COLLECTION_BULK_TARGET_LIMIT)
    throw new RangeError('Invalid manifest ordinal');
  // All transitions share the root lock. An effect and its terminal result commit or roll back together.
  await tx.query(`SELECT operation_id FROM library.bulk_operation WHERE route=$1 AND operation_id=$2
    AND account_id=$3 FOR UPDATE`, [input.route,input.operationId,input.accountId]);
  const operation = await readCollectionBulk(tx, input);
  if (!operation || operation.phase === 'preview') return null;
  const found = await tx.query<CollectionBulkManifestRow>(`SELECT ordinal::text,target,receipt,state,reason,resulting_member_id AS "resultingMemberId"
    FROM library.bulk_target WHERE route=$1 AND operation_id=$2 AND account_id=$3 AND ordinal=$4 FOR UPDATE`,
    [input.route,input.operationId,input.accountId,input.ordinal]);
  const row = found.rows[0];
  if (!row) return null;
  if (row.state !== 'pending') return { state: row.state, reason: row.reason, resultingMemberId: row.resultingMemberId };
  if (row.target.kind === 'occurrence' && routeOf(row.target.collectionId) !== input.route)
    throw new RangeError('Remote occurrences require native receipt reconciliation in the Library worker');
  const outcome: CollectionBulkOutcome = Date.parse(input.now) >= Date.parse(operation.expiresAt)
    ? { state: 'cancelled', reason: 'execution_expired' } : await apply(tx, operation, row);
  if (!['applied','no_effect','conflict','denied','failed','cancelled'].includes(outcome.state))
    throw new TypeError('Native effect must return a terminal outcome');
  await tx.query(`UPDATE library.bulk_target SET state=$5,reason=$6,resulting_member_id=$7
    WHERE route=$1 AND operation_id=$2 AND account_id=$3 AND ordinal=$4 AND state='pending'`,
    [input.route,input.operationId,input.accountId,input.ordinal,outcome.state,outcome.reason,outcome.resultingMemberId ?? null]);
  await tx.query(`UPDATE library.bulk_operation SET phase='completed' WHERE route=$1 AND operation_id=$2
    AND account_id=$3 AND NOT EXISTS (SELECT 1 FROM library.bulk_target WHERE route=$1 AND operation_id=$2
      AND state IN ('pending','reconciling') ORDER BY ordinal LIMIT 1)`,
    [input.route,input.operationId,input.accountId]);
  return outcome;
}
