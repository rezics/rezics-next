import type { CommandAuthorization, CommandEvent } from '../command/command.ts';
import { authoritativeTimeValue, noEffect, principalCommandIdentity, runCommand } from '../command/command.ts';
import { shareAccount } from '../access/account-share.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { DurableInitiatorUnavailableError } from '../access/durable-initiator.ts';
import { accessCommandAuthorization } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';
import { withConnection } from '../database/pool.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import type { AttemptResult, BulkDependencies, TargetCommand, TargetEvidence } from './bulk-contract.ts';
import { applyCollectionBulkTarget, readCollectionBulk } from './collection-bulk-store.ts';
import { bulkHash, BULK_CHANGED_EVENT } from './collection-bulk-operation.ts';
import { admitEntryAttempt } from './entry-lifecycle.ts';
import { readLibraryProfileSource } from './profile-source.ts';
import { hasEntryState } from './profile.ts';
import { updateEntryState } from './entry-store.ts';
import { enterShelfWrite } from './shelf-counter-owner.ts';
import { createShelfHeads } from './shelf-heads.ts';
import { createShelfCounters } from './shelf-counters.ts';
import { allocateOwnerWriteSeq } from './owner-write-sequence.ts';
import { createFollowCommands } from './follows.ts';
import placement from './shelf-counter-placement.sql';
import mutation from './entry-mutation-state.sql';
import stamp from './entry-owner-write-sequence.sql';

/** Exact source-bound private accounting only. No Access restoration, write, or public reader. */
export async function reconcileCollectionBulkStatus(deps: Pick<BulkDependencies, 'pool'>, command: TargetCommand): Promise<AttemptResult | null> {
  return withConnection(deps.pool, async tx => {
    const key = { route: command.source.route, accountId: command.receipt.principalId, operationId: command.source.id };
    const operation = await readCollectionBulk(tx, key);
    if (!operation || operation.sourceDigest !== command.sourceDigest ||
      bulkHash(operation.initiator.operation) !== bulkHash(command.source)) return { kind: 'stop', reason: 'evidence_missing' };
    const row = (await tx.query<{ target: unknown; receipt: unknown; evidence: TargetEvidence | null; state: string }>(
      `SELECT target,receipt,evidence,state FROM library.bulk_target WHERE route=$1 AND operation_id=$2 AND account_id=$3 AND ordinal=$4`,
      [key.route, key.operationId, key.accountId, command.target.ordinal])).rows[0];
    if (!row || bulkHash(row.target) !== bulkHash(command.target) || bulkHash(row.receipt) !== bulkHash(command.receipt))
      return { kind: 'stop', reason: 'evidence_missing' };
    if (row.state === 'pending') return null;
    if (!row.evidence) return { kind: 'stop', reason: 'evidence_missing' };
    const receipt = (await tx.query<{ transactionId: string; digest: string; evidence: TargetEvidence }>(
      `SELECT r.transaction_id AS "transactionId",encode(r.request_digest,'hex') AS digest,r.response->'evidence' AS evidence
       FROM core.receipt r JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
       WHERE r.partition_no=$1 AND r.principal_kind='account' AND r.principal_id=$2 AND r.command_kind=$3
        AND r.idempotency_key=ANY($4::text[]) AND r.payload_state='present' AND r.xmin=b.xmin
        AND r.position=b.position AND r.epoch=b.epoch AND b.principal_kind=r.principal_kind AND b.principal_id=r.principal_id LIMIT 1`,
      [partitionOf(key.route), key.accountId, command.receipt.commandKind,
        nativeReceiptKeyCandidates(tx, command.receipt.commandKind, key.accountId, command.receipt.key)])).rows[0];
    if (!receipt || receipt.transactionId !== row.evidence.transactionId || receipt.digest !== command.receipt.digest ||
      bulkHash(receipt.evidence) !== bulkHash(row.evidence)) return { kind: 'stop', reason: 'evidence_missing' };
    return { kind: 'terminal', evidence: row.evidence };
  });
}

/** Same-home status transitions use the existing native CAS, profile, counters, owner
 * sequence, follow transition and events. The terminal manifest outcome shares that transaction. */
export async function executeCollectionBulkStatus(deps: BulkDependencies, command: TargetCommand): Promise<AttemptResult> {
  const previous = await reconcileCollectionBulkStatus(deps, command);
  if (previous) return previous;
  const key = { route: command.source.route, accountId: command.receipt.principalId, operationId: command.source.id };
  const operation = await withConnection(deps.pool, tx => readCollectionBulk(tx, key));
  if (!operation || operation.request.action !== 'set_status' || command.target.kind !== 'subject')
    return { kind: 'stop', reason: 'evidence_missing' };
  if (operation.phase !== 'applying') return { kind: 'stop', reason: 'execution_expired' };
  const requestedState = operation.request.state, target = command.target;
  let prepared: { native: CommandAuthorization; source: Awaited<ReturnType<typeof readLibraryProfileSource>> } | undefined;
  try {
    const result = await runCommand<AttemptResult>(deps.pool, {
      ...principalCommandIdentity(operation.initiator.actor), partition: partitionOf(key.route), clock: deps.clock,
      deadline: command.deadline,
      receipt: { kind: command.receipt.commandKind, key: command.receipt.key, digest: Buffer.from(command.receipt.digest, 'hex') },
      authorization: { action: 'library_entry:update', resource: { route: key.route, id: key.accountId },
        denied: () => new GrantDeniedError(),
        async prepare(attempt) {
          prepared = undefined;
          const actor = await deps.initiators.restoreInitiator({ operation: command.source, action: 'library_entry:update',
            anchor: { resource: { route: key.route, id: key.accountId }, async validate(client) {
              const current = await readCollectionBulk(client, key);
              return current?.sourceDigest === command.sourceDigest && current.phase === 'applying';
            } }, context: { pool: deps.pool, deadline: command.deadline } }, attempt.time);
          const native = await accessCommandAuthorization(deps.access, actor, 'library_entry:update',
            { route: key.route, id: key.accountId }, { pool: deps.pool, deadline: command.deadline }, () => new GrantDeniedError());
          const evidence = await native.prepare?.(attempt);
          await admitEntryAttempt(deps, actor, 'library_entry:update', attempt, command.deadline);
          const source = await readLibraryProfileSource({ ...deps, actor, at: attempt.time, deadline: command.deadline }, target.subjectId);
          prepared = { native, source };
          return evidence;
        },
        async authorize(tx, attempt, evidence) {
          if (!prepared) throw new GrantDeniedError();
          await shareAccount(tx, key.accountId);
          return prepared.native.authorize(tx, attempt, evidence);
        },
      },
    }, async (tx, native) => {
      const events: CommandEvent[] = [];
      const write = { client: tx, route: key.route, accountId: key.accountId };
      // Preserve the normal owner/head/entry lock order before the operation's effect lock.
      const gate = await enterShelfWrite(write);
      await createShelfHeads().ensure(write, target.subjectId);
      const outcome = await applyCollectionBulkTarget(tx, { ...key, ordinal: Number(target.ordinal),
        now: authoritativeTimeValue(native.time) }, async (client, current, row) => {
          if (current.sourceDigest !== command.sourceDigest || bulkHash(row.receipt) !== bulkHash(command.receipt) ||
            bulkHash(row.target) !== bulkHash(target)) throw new TypeError('Bulk target binding changed');
          if (current.phase !== 'applying') return { state: 'cancelled', reason: 'cancel_requested' };
          const before = await placement.run(client, { route: key.route, account_id: key.accountId, subject_id: target.subjectId });
          const locked = await mutation.run(client, { route: key.route, account_id: key.accountId, subject_id: target.subjectId });
          if (target.expected.kind !== 'present' || !locked) return { state: 'conflict', reason: 'missing_target' };
          if (locked.revision !== target.expected.revision || locked.incarnationId !== target.expected.incarnation)
            return { state: 'conflict', reason: 'revision_mismatch' };
          const source = prepared!.source;
          if (!source || source.subjectId !== target.subjectId) return { state: 'denied', reason: 'target_denied' };
          if (source.kind !== 'supported' || !hasEntryState(source.profile, requestedState))
            return { state: 'failed', reason: 'invalid_subject' };
          if (before?.state === requestedState) return { state: 'no_effect', reason: null };
          const context = { transactionId: native.transactionId, time: authoritativeTimeValue(native.time) };
          const seq = await allocateOwnerWriteSeq(client, key.accountId);
          const changed = await updateEntryState(client, key.route, key.accountId, target.subjectId,
            target.expected.revision, requestedState, context, source.pin, target.expected.incarnation);
          if (!changed) return { state: 'conflict', reason: 'revision_mismatch' };
          if (gate.ready && !before?.typeId) throw new Error('Complete shelf placement is missing a type');
          await createShelfCounters().transition(write, before?.typeId ? { state: before.state, typeId: before.typeId } : null,
            before?.typeId ? { state: changed.state, typeId: before.typeId } : null);
          const stamped = await stamp.run(client, { route: key.route, account_id: key.accountId, subject_id: target.subjectId,
            revision: changed.revision, transaction_id: native.transactionId, seq });
          if (stamped.length !== 1) throw new Error('Library entry owner sequence stamp failed');
          events.push({ type: 'com.rezics.library.entry.updated.v1', subject: key.accountId, data: { subjectId: target.subjectId } });
          if (changed.state === 'in_progress') {
            const followed = await createFollowCommands({ ...deps }).followFromLibrary(client, key.route,
              { accountId: key.accountId, subjectId: target.subjectId, ...context });
            if (followed) events.push(followed);
          }
          return { state: 'applied', reason: null };
        });
      if (!outcome) return noEffect({ kind: 'stop', reason: 'execution_expired' });
      const evidence: TargetEvidence = { operationId: key.operationId, ordinal: target.ordinal,
        sourceDigest: command.sourceDigest, receipt: command.receipt, transactionId: native.transactionId,
        outcome: outcome.state, reason: outcome.reason, resultingMemberId: outcome.resultingMemberId ?? null };
      await tx.query(`UPDATE library.bulk_target SET evidence=$5 WHERE route=$1 AND operation_id=$2 AND account_id=$3 AND ordinal=$4`,
        [key.route, key.operationId, key.accountId, target.ordinal, JSON.stringify(evidence)]);
      events.push({ type: BULK_CHANGED_EVENT, subject: key.accountId, data: { operationId: key.operationId } });
      return { value: { kind: 'terminal', evidence }, events };
    });
    return result.value;
  } catch (error) {
    // A lost response or a revoked identity may follow a committed effect. Only its
    // original private receipt can establish it; this path never authorizes a retry.
    const committed = await reconcileCollectionBulkStatus(deps, command);
    if (committed) return committed;
    if (error instanceof GrantDeniedError || error instanceof DurableInitiatorUnavailableError)
      return { kind: 'stop', reason: 'authority_lost' };
    throw error;
  }
}
