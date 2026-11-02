import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { Compile } from 'typebox/compile';
import { admitGroup } from '../access/gates/admission.ts';
import { admitEntryAttempt } from './entry-lifecycle.ts';
import { readAccount } from '../access/account-data.ts';
import { commandAccessContext } from '../access/command-admission.ts';
import { captureDurableInitiator, durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import type { DurableInitiatorReader, DurableInitiatorRecord } from '../access/durable-initiator.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { authoritativeTimeValue, currentCommandReceipt, mintReadTime, releaseOperationalTime,
  principalCommandIdentity, noEffect, type CommandTransaction } from '../command/command.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import type { KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type AccountActor, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { bulkAdmissionSchema } from './bulk-schemas.ts';
import { BULK_ADMISSION_BODY_BYTES, BULK_MAX_SELECTION_IDS } from './bulk-limits.ts';
import type { BulkAdmission, BulkCounters, OperationResult, OutcomeQuery } from './bulk-contract.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, requireRoute } from './command-support.ts';
import { confirmCollectionBulk, previewCollectionBulk, readCollectionBulk,
  type CollectionBulkKey, type CollectionBulkOperation, type CollectionBulkTarget } from './collection-bulk-store.ts';
import { pageBulkOutcomes } from './bulk-outcome-page.ts';
import { resolveSubject } from './subject-anchor.ts';
import creationReceipt from './collection-publication-episode-receipt.sql';

export const BULK_PREVIEW_COMMAND = 'library.collectionBulk.preview';
export const BULK_CONFIRMED_EVENT = 'com.rezics.library.bulk.confirmed.v1';
export const BULK_CHANGED_EVENT = 'com.rezics.library.bulk.changed.v1';
export type CollectionBulkDependencies = { pool: Pool; access: Access; tokens: KeyRing; clock: KernelClock };
export type CollectionBulkInput = { route: number; operationId: string };
export const bulkHash = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
const validator = Compile(bulkAdmissionSchema);

/** Validate the entire command before canonicalization or any source read. */
export function explicitBulkStatus(input: BulkAdmission): Extract<BulkAdmission, { action: 'set_status' }> & {
  selection: Extract<BulkAdmission['selection'], { kind: 'explicit' }>;
} {
  if (Buffer.byteLength(JSON.stringify(input)) > BULK_ADMISSION_BODY_BYTES) throw new RangeError('Bulk command exceeds 64 KiB');
  if (!validator.Check(input)) throw new TypeError('Invalid bulk selection');
  if (input.action !== 'set_status' || input.selection.kind !== 'explicit')
    throw new ProblemError('dependency_unavailable');
  const targets = [...new Set(input.selection.targets.map(target => target.subjectId.toLowerCase()))];
  if (!targets.length || targets.length > BULK_MAX_SELECTION_IDS) throw new RangeError('Select 1 to 1,000 subjects');
  return { ...input, selection: { kind: 'explicit', targets: targets.map(subjectId => ({ subjectId })) } };
}
export function bulkOwner(actor: Actor, action: string): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(action))
    throw new GrantDeniedError();
  return actor;
}
export function bulkKey(owner: AccountActor, operationId: string): CollectionBulkKey {
  const route = requireRoute(owner.accountId);
  if (requireRoute(operationId) !== route) throw new LibraryNotFoundError();
  return { route, accountId: owner.accountId, operationId };
}
/** The only original initiator reader. Verify the sole manifest and exact creation receipt,
 * including its native write basis, before returning any authority record. */
export const readCollectionBulkInitiator: DurableInitiatorReader = async (client, anchor, time) => {
  authoritativeTimeValue(time);
  if (anchor.kind !== BULK_PREVIEW_COMMAND || anchor.sourceId !== anchor.id || routeOf(anchor.id) !== anchor.route) return null;
  const found = await client.query<{ accountId: string; request: CollectionBulkOperation['request'];
    initiator: DurableInitiatorRecord; sourceDigest: string; receipt: { key: string; digest: string }; count: number }>(
    `SELECT account_id AS "accountId",request,initiator,source_digest AS "sourceDigest",
      creation_receipt AS receipt,target_count AS count FROM library.bulk_operation WHERE route=$1 AND operation_id=$2`,
    [anchor.route, anchor.id]);
  const row = found.rows[0];
  if (!row) return null;
  const record = row.initiator;
  try {
    if (canonicalize(record.operation) !== canonicalize(anchor) || record.initiatorAccountId !== row.accountId ||
      record.actor.accountId !== row.accountId || record.creation.target.id !== row.accountId ||
      record.creation.target.route !== anchor.route || record.creation.commandKind !== BULK_PREVIEW_COMMAND) return null;
    const manifest = await client.query<{ target: unknown; transactionId: string; sourceDigest: string }>(
      `SELECT target,created_transaction_id AS "transactionId",source_digest AS "sourceDigest"
       FROM library.bulk_target WHERE route=$1 AND operation_id=$2 AND account_id=$3 ORDER BY ordinal LIMIT 1001`,
      [anchor.route, anchor.id, row.accountId]);
    if (manifest.rows.length !== row.count || manifest.rows.some(target =>
      target.transactionId !== record.recordedTransactionId || target.sourceDigest !== row.sourceDigest)) return null;
    const targets = manifest.rows.map(target => target.target);
    const source = { operation: anchor, accountId: row.accountId, request: row.request, targets };
    if (bulkHash(source) !== record.sourceDigest || bulkHash({ request: row.request, targets,
      initiator: record, creationReceipt: { partition: partitionOf(anchor.route), principalKind: 'account',
        principalId: row.accountId, commandKind: BULK_PREVIEW_COMMAND, key: row.receipt.key, digest: row.receipt.digest } }) !== row.sourceDigest) return null;
    const receipt = (await client.query<{ transactionId: string; digest: string; commitment: string }>(
      creationReceipt.sql, [partitionOf(anchor.route), row.accountId, BULK_PREVIEW_COMMAND,
        nativeReceiptKeyCandidates(client, BULK_PREVIEW_COMMAND, row.accountId, record.creation.idempotencyKey), row.receipt.key])).rows[0];
    if (!receipt || receipt.transactionId !== record.recordedTransactionId || receipt.digest !== record.creation.requestDigest ||
      receipt.digest !== row.receipt.digest || receipt.commitment !== durableInitiatorCommitment(record)) return null;
    return record;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
};

export async function collectionBulkView(tx: CommandTransaction, key: CollectionBulkKey): Promise<OperationResult> {
  const operation = await readCollectionBulk(tx, key);
  if (!operation) throw new LibraryNotFoundError();
  const header = (await tx.query<{ admittedAt: string; confirmedAt: string | null }>(
    `SELECT admitted_at::text AS "admittedAt",confirmed_at::text AS "confirmedAt" FROM library.bulk_operation
      WHERE route=$1 AND operation_id=$2 AND account_id=$3`, [key.route, key.operationId, key.accountId])).rows[0]!;
  const rows = await tx.query<{ state: string; reason: string | null; n: number }>(
    `SELECT state,reason,count(*)::integer AS n FROM library.bulk_target WHERE route=$1 AND operation_id=$2
      AND account_id=$3 GROUP BY state,reason`, [key.route, key.operationId, key.accountId]);
  const counts: BulkCounters = { scannedCandidates: operation.targetCount, selectedSubjects: operation.targetCount,
    scannedOccurrences: 0, capturedOccurrences: 0, targets: operation.targetCount, pending: 0, reconciling: 0,
    applied: 0, no_effect: 0, conflict: 0, denied: 0, failed: 0, cancelled: 0 };
  for (const row of rows.rows) if (Object.hasOwn(counts, row.state)) {
    const totals = counts as unknown as Record<string, number>;
    totals[row.state] = (totals[row.state] ?? 0) + row.n;
  }
  const stopReason = rows.rows.find(row => row.reason === 'authority_lost' || row.reason === 'cancel_requested' || row.reason === 'execution_expired')?.reason;
  const cancelled = operation.phase === 'completed' && (counts.pending > 0 || counts.cancelled > 0);
  return { operation: { id: key.operationId, route: key.route, action: operation.request.action,
    selectionKind: operation.request.selection.kind,
    state: operation.request.action === 'set_status' ? operation.request.state : null,
    collectionId: 'collectionId' in operation.request ? operation.request.collectionId : null,
    phase: cancelled && stopReason === 'execution_expired' ? 'expired' : stopReason === 'authority_lost' ? 'stopped' :
      cancelled ? 'cancelled' : operation.phase === 'completed' && counts.conflict + counts.denied + counts.failed > 0 ? 'completed_with_errors' : operation.phase,
    selectionComplete: true, occurrencesComplete: true, cancelRequested: cancelled, counts,
    summary: counts.pending + counts.reconciling === 0 && operation.phase !== 'preview' ? {
      changed: counts.applied, unchanged: counts.no_effect,
      failed: counts.conflict + counts.denied + counts.failed + counts.cancelled } : null,
    admittedAt: header.admittedAt, targetBoundAt: header.admittedAt, expiresAt: operation.expiresAt,
    resultsExpireAt: operation.resultsExpireAt, finishedAt: null,
    reason: stopReason === 'authority_lost' || stopReason === 'execution_expired' || stopReason === 'cancel_requested' ? stopReason : cancelled ? 'cancel_requested' : null } };
}

export function createCollectionBulkOperations(deps: CollectionBulkDependencies) {
  const { pool, access, clock, tokens } = deps;
  const runner = createLibraryCommandRunner({ pool, access, clock });
  async function read<T>(actor: Actor, operationId: string, body: (tx: CommandTransaction, key: CollectionBulkKey) => Promise<T>) {
    const owner = bulkOwner(actor, 'library_entry:list'), key = bulkKey(owner, operationId);
    await admitGroup({ pool, access: () => access, actor: owner, group: 'personal_library', clientAction: 'library_entry:list',
      deadline: deadlineFor(5000), clock });
    const check = await accessCheck(access, owner, 'library_entry:list', { route: key.route, id: owner.accountId },
      { pool, deadline: deadlineFor(5000) });
    return withConnection(pool, async tx => {
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const time = await mintReadTime(tx, clock);
      try {
        const current = await readAccount(tx, key.route, key.accountId);
        if (!current || current.kind !== 'actor' || current.state !== 'active' || current.fenced ||
          current.minimumAuthnEpoch > BigInt(owner.authnEpoch) || !(await check(tx, time))) throw new GrantDeniedError();
        const operation = await readCollectionBulk(tx, key);
        if (!operation || Date.parse(operation.resultsExpireAt) <= Date.parse(authoritativeTimeValue(time))) throw new LibraryNotFoundError();
        const result = await body(tx, key);
        await tx.query('COMMIT');
        return result;
      } catch (error) { await tx.query('ROLLBACK'); throw error; }
      finally { releaseOperationalTime(time); }
    });
  }
  return {
    async preview(actor: Actor, input: BulkAdmission, requestKey: string) {
      const owner = bulkOwner(actor, 'library_entry:update'), parsed = explicitBulkStatus(input);
      const route = requireRoute(owner.accountId), operationId = newId(route);
      const requestDigest = bulkHash([principalCommandIdentity(owner), BULK_PREVIEW_COMMAND, input]);
      return runner.ownAccountPrepared(owner, { action: 'library_entry:update', kind: BULK_PREVIEW_COMMAND,
        requestKey, input, async prepare(attempt) {
          const context = commandAccessContext({ pool, deadline: deadlineFor(5000) }, attempt);
          await admitEntryAttempt(deps, owner, 'library_entry:update', attempt, context.deadline);
          const capture = await captureDurableInitiator(context, owner);
          const resolved: { subjectId: string; requestedSubjectId: string | null }[] = [];
          const seen = new Set<string>();
          try { for (const target of parsed.selection.targets) {
            const subject = await resolveSubject(deps, owner, target.subjectId, attempt.time, context);
            if (!subject) throw new LibraryNotFoundError();
            if (!seen.has(subject.subjectId)) { seen.add(subject.subjectId); resolved.push(subject); }
          }
          } catch (error) { return { capture, resolved, error }; }
          return { capture, resolved };
        } }, async (tx, command, prepared) => {
          if ('error' in prepared) throw prepared.error;
          const rows = await tx.query<{ subjectId: string; incarnation: string | null; revision: number }>(
            `SELECT subject_id AS "subjectId",incarnation_id AS incarnation,revision FROM library.entry
              WHERE route=$1 AND account_id=$2 AND subject_id=ANY($3::uuid[]) ORDER BY subject_id`,
            [route, owner.accountId, prepared.resolved.map(subject => subject.subjectId)]);
          const entries = new Map(rows.rows.map(entry => [entry.subjectId, entry]));
          const targets: CollectionBulkTarget[] = prepared.resolved.map(subject => {
            const entry = entries.get(subject.subjectId);
            if (entry && !entry.incarnation) throw new ProblemError('dependency_unavailable');
            return { kind: 'subject', ...subject, expected: entry ? { kind: 'present', incarnation: entry.incarnation!,
              admissionSequence: '0', revision: entry.revision } : { kind: 'absent', slotGeneration: '0' } };
          });
          const request = { ...parsed, selection: { kind: 'explicit' as const } };
          const operation = { route, id: operationId, kind: BULK_PREVIEW_COMMAND, sourceId: operationId };
          const record: DurableInitiatorRecord = { operation, actor: structuredClone(owner), initiatorAccountId: owner.accountId,
            recordedTransactionId: command.transactionId, ...prepared.capture,
            sourceDigest: bulkHash({ operation, accountId: owner.accountId, request,
              targets: targets.map((target, ordinal) => ({ ...target, operationId, ordinal: String(ordinal) })) }),
            creation: { commandKind: BULK_PREVIEW_COMMAND, idempotencyKey: requestKey, requestDigest,
              target: { route, id: owner.accountId } } };
          const receipt = currentCommandReceipt(tx);
          const key = { route, accountId: owner.accountId, operationId };
          await previewCollectionBulk(tx, { ...key, request: parsed, targets, initiator: record,
            creationReceipt: { partition: partitionOf(route), principalKind: 'account', principalId: owner.accountId,
              commandKind: BULK_PREVIEW_COMMAND, key: receipt.storageKey, digest: requestDigest },
            transactionId: command.transactionId, now: authoritativeTimeValue(command.time) });
          return { value: { ...await collectionBulkView(tx, key), durableInitiator: durableInitiatorCommitment(record) },
            events: [{ type: BULK_CHANGED_EVENT, subject: owner.accountId, data: { operationId } }] };
        });
    },
    get(actor: Actor, operationId: string) { return read(actor, operationId, collectionBulkView); },
    async outcomes(actor: Actor, operationId: string, query: OutcomeQuery) {
      const result = await read(actor, operationId, async (tx, key) => {
        const binding = { operation: 'library.bulk.outcomes', parameters: { ...key, state: query.state ?? null } };
        let after: string | null = null;
        if (query.cursor !== undefined) {
          if (query.cursor.length > 4096) throw new TypeError('Invalid bulk cursor');
          const cursor = decodeCursor(tokens, binding, query.cursor);
          if (!cursor.ok || cursor.epoch !== 1 || cursor.after.length !== 1 || typeof cursor.after[0] !== 'string' ||
            !/^(0|[1-9][0-9]*)$/.test(cursor.after[0]) || Number(cursor.after[0]) >= 1000) throw new TypeError('Invalid bulk cursor');
          after = cursor.after[0];
        }
        const page = await pageBulkOutcomes(tx, { ...key, after, limit: query.limit ?? 20, state: query.state ?? null });
        return { outcomes: page.outcomes, next: page.nextAfter === null ? null : encodeCursor(tokens, binding,
          { epoch: 1, after: [page.nextAfter] }) };
      });
      // Release the source snapshot before checking foreign subject homes. A page is
      // disclosed only while every returned target and the operation remain readable.
      for (const outcome of result.outcomes) {
        const subject = await resolveSubject(deps, actor, outcome.subjectId);
        if (!subject || subject.subjectId !== outcome.subjectId) throw new GrantDeniedError();
      }
      return read(actor, operationId, async () => result);
    },
    async confirm(actor: Actor, operationId: string, requestKey: string) {
      const owner = bulkOwner(actor, 'library_entry:update'), key = bulkKey(owner, operationId);
      return runner.ownAccountPrepared(owner, { action: 'library_entry:update', kind: 'library.collectionBulk.confirm', requestKey,
        input: { operationId }, prepare: attempt => admitEntryAttempt(deps, owner, 'library_entry:update', attempt, deadlineFor(5000)) }, async (tx, command) => {
          const operation = await readCollectionBulk(tx, key);
          if (!operation || Date.parse(operation.resultsExpireAt) <= Date.parse(authoritativeTimeValue(command.time))) throw new LibraryNotFoundError();
          if (operation.phase === 'preview' && Date.parse(operation.expiresAt) <= Date.parse(authoritativeTimeValue(command.time)))
            throw new TypeError('Bulk preview expired; preview again');
          const changed = await confirmCollectionBulk(tx, { ...key, now: authoritativeTimeValue(command.time) });
          const value = await collectionBulkView(tx, key);
          return changed ? { value, events: [{ type: BULK_CONFIRMED_EVENT, subject: owner.accountId, data: { operationId } }] } : noEffect(value);
        });
    },
    async cancel(actor: Actor, operationId: string, requestKey: string) {
      const owner = bulkOwner(actor, 'library_entry:update'), key = bulkKey(owner, operationId);
      return runner.ownAccountPrepared(owner, { action: 'library_entry:update', kind: 'library.collectionBulk.cancel', requestKey,
        input: { operationId }, prepare: attempt => admitEntryAttempt(deps, owner, 'library_entry:update', attempt, deadlineFor(5000)) }, async (tx, command) => {
          const operation = await readCollectionBulk(tx, key);
          if (!operation || Date.parse(operation.resultsExpireAt) <= Date.parse(authoritativeTimeValue(command.time))) throw new LibraryNotFoundError();
          // This is the same root lock as target effects. Completed-with-pending is a durable stop marker.
          const changed = await tx.query(`UPDATE library.bulk_operation SET phase='completed' WHERE route=$1 AND operation_id=$2
            AND account_id=$3 AND phase IN ('preview','applying') RETURNING operation_id`, [key.route, operationId, key.accountId]);
          const value = await collectionBulkView(tx, key);
          return changed.rowCount ? { value, events: [{ type: BULK_CONFIRMED_EVENT, subject: owner.accountId, data: { operationId } }] } : noEffect(value);
        });
    },
  };
}
