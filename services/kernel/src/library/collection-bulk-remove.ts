import { isDeepStrictEqual } from 'node:util';
import type { DurableInitiatorRecord } from '../access/durable-initiator.ts';
import { DurableInitiatorUnavailableError } from '../access/durable-initiator.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { shareAccount } from '../access/account-share.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { resourceAuthorization, type AuthorizationAnchor } from '../access/resource-authorization.ts';
import {
  authoritativeTimeValue, CommandUnavailableError, noEffect, principalCommandIdentity, runCommand,
  type CommandAuthorization, type CommandTransaction,
} from '../command/command.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import { ProblemError } from '../http/problem.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type { BulkDependencies, TargetCommand, TargetEvidence, AttemptResult, OccurrenceTarget } from './bulk-contract.ts';
import { BULK_COMMAND_DEADLINE_MS } from './bulk-contract.ts';
import { deleteMembers, readCollection, readMemberDeletion } from './collection-store.ts';
import { assertCollectionOrderWritable } from './collection-order.ts';
import { recordPublicCollectionReduction } from './collections.ts';
import { enterShelfWrite } from './shelf-counter-owner.ts';
import { readableSubjects } from './subject-anchor.ts';

type Source = {
  accountId: string; initiator: DurableInitiatorRecord; expiresAt: string; resultsExpireAt: string;
  state: string;
};
class RemovalReceiptMissing extends Error {}
type RemovalCommand = TargetCommand & { target: OccurrenceTarget & { expected: NonNullable<OccurrenceTarget['expected']> } };

/** Only exact persisted occurrences enter this action. In particular, no Subject selection is evaluated here. */
async function source(client: CommandTransaction, command: TargetCommand): Promise<Source | null> {
  const result = await client.query<Source>(
    `SELECT o.account_id AS "accountId",o.initiator,o.expires_at::text AS "expiresAt",
      o.results_expire_at::text AS "resultsExpireAt",t.state
     FROM library.bulk_operation o JOIN library.bulk_target t USING(route,operation_id,account_id)
     WHERE o.route=$1 AND o.operation_id=$2 AND t.ordinal=$3 AND o.source_digest=$4
       AND t.source_digest=o.source_digest AND t.target=$5::jsonb AND t.receipt=$6::jsonb
       AND o.phase<>'preview' AND o.request->>'action'='remove_from_collection'
       AND o.request->>'collectionId'=t.collection_id::text`,
    [command.source.route, command.source.id, command.target.ordinal, command.sourceDigest,
      JSON.stringify(command.target), JSON.stringify(command.receipt)],
  );
  const row = result.rows[0];
  return row && isDeepStrictEqual(row.initiator.operation, command.source) &&
    row.initiator.initiatorAccountId === row.accountId &&
    row.initiator.actor?.kind === 'account' && row.initiator.actor.accountId === row.accountId &&
    row.accountId === command.receipt.principalId ? row : null;
}

function evidence(command: TargetCommand, transactionId: string | null,
  outcome: TargetEvidence['outcome'], reason: TargetEvidence['reason'] = null): TargetEvidence {
  return { operationId: command.target.operationId, ordinal: command.target.ordinal,
    sourceDigest: command.sourceDigest, receipt: command.receipt, transactionId, outcome, reason,
    resultingMemberId: null };
}

/** Private source-bound accounting only. No actor restoration, effect, Subject read or public result read.
 * The exact native receipt is the commit evidence, including after the occurrence has been restored/purged.
 */
async function committed(deps: BulkDependencies, client: CommandTransaction, command: TargetCommand): Promise<TargetEvidence | null> {
  if (!(await source(client, command))) return null;
  const receipt = command.receipt;
  const found = await client.query<{ transactionId: string; digest: string; response: TargetEvidence }>(
    `SELECT transaction_id AS "transactionId",encode(request_digest,'hex') AS digest,response
     FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
       AND command_kind=$3 AND idempotency_key=ANY($4::text[]) AND payload_state='present' LIMIT 1`,
    [receipt.partition, receipt.principalId, receipt.commandKind,
      nativeReceiptKeyCandidates(deps.pool, receipt.commandKind, receipt.principalId, receipt.key)],
  );
  const row = found.rows[0], value = row?.response;
  if (!row || row.digest !== receipt.digest || !value || value.transactionId !== row.transactionId ||
    value.operationId !== command.target.operationId || value.ordinal !== command.target.ordinal ||
    value.sourceDigest !== command.sourceDigest || !isDeepStrictEqual(value.receipt, receipt) ||
    !['applied', 'no_effect', 'conflict', 'denied', 'cancelled'].includes(value.outcome)) return null;
  // Applied results must carry the native retained-removal episode, never an inferred current row.
  if (value.outcome === 'applied' && !value.memberDeletion) return null;
  return value;
}

function valid(command: TargetCommand): command is RemovalCommand {
  const target = command.target;
  return target.kind === 'occurrence' && target.expected !== undefined &&
    command.source.id === target.operationId && routeOf(command.source.id) === command.source.route &&
    routeOf(target.collectionId) !== null && routeOf(target.memberId) === routeOf(target.collectionId) &&
    routeOf(target.subjectId) !== null && /^[0-9]{1,3}$/.test(target.ordinal) && Number(target.ordinal) < 1000 &&
    /^[1-9][0-9]*$/.test(target.expected.memberRevision) && routeOf(target.expected.transactionId) !== null &&
    Number.isFinite(Date.parse(target.expected.addedAt)) && /^[a-f0-9]{64}$/.test(command.sourceDigest) &&
    command.receipt.principalKind === 'account' && /^[a-f0-9]{64}$/.test(command.receipt.digest) &&
    command.receipt.partition === partitionOf(routeOf(target.collectionId)!);
}

export async function executeCollectionRemoveTarget(deps: BulkDependencies, command: TargetCommand): Promise<AttemptResult> {
  if (!valid(command)) return { kind: 'stop', reason: 'evidence_missing' };
  const deadline = Math.min(command.deadline, Date.now() + BULK_COMMAND_DEADLINE_MS);
  const client = deadlineClient(deps.pool, deadline);
  const original = await source(client, command);
  if (!original) return { kind: 'stop', reason: 'evidence_missing' };
  if (Date.parse(original.resultsExpireAt) <= deps.clock().getTime())
    return { kind: 'stop', reason: 'execution_expired' };
  const target = command.target, route = routeOf(target.collectionId)!, partition = partitionOf(route);
  const sameHome = route === command.source.route;
  const anchor: AuthorizationAnchor = {
    resource: { route, id: target.collectionId },
    async validate(tx) {
      const current = await readCollection(tx, route, target.collectionId);
      return !!current && current.state === 'active' && current.membershipKind !== 'dynamic' && !!current.curatorAccountId;
    },
  };
  const authorization: CommandAuthorization = {
    action: 'collection:update', resource: anchor.resource, denied: () => new GrantDeniedError(),
    async prepare(attempt) {
      const record = await deps.readInitiator(client, command.source, attempt.time);
      if (!record || !isDeepStrictEqual(record, original.initiator)) throw new DurableInitiatorUnavailableError();
      const actor = await deps.initiators.restoreInitiator({ operation: command.source, action: 'collection:update',
        anchor, context: { pool: deps.pool, deadline } }, attempt.time);
      if (!isDeepStrictEqual(principalCommandIdentity(actor), principalCommandIdentity(original.initiator.actor)))
        throw new DurableInitiatorUnavailableError();
      const current = resourceAuthorization({ access: deps.access, actor, action: 'collection:update', anchor,
        context: { pool: deps.pool, deadline, partition } });
      const proof = await current.prepare!(attempt);
      const readable = (await readableSubjects(deps, actor, [target.subjectId], attempt.time)).length === 1;
      return { current, proof, readable };
    },
    async authorize(tx, attempt, prepared) {
      const { current, proof } = prepared as { current: CommandAuthorization; proof: unknown };
      if (await current.authorize(tx, attempt, proof) !== 'execute') throw new GrantDeniedError();
      const parent = await readCollection(tx, route, target.collectionId);
      if (!parent?.curatorAccountId || parent.state !== 'active' || parent.membershipKind === 'dynamic')
        throw new GrantDeniedError();
      await shareAccount(tx, parent.curatorAccountId);
      return 'execute';
    },
  };
  let readable = false;
  const nativeAuthorization: CommandAuthorization = { ...authorization,
    async prepare(attempt) {
      const prepared = await authorization.prepare!(attempt) as { readable: boolean };
      readable = prepared.readable;
      return prepared;
    },
  };
  try {
    const result = await runCommand<TargetEvidence>(deps.pool, {
      ...principalCommandIdentity(original.initiator.actor), partition, deadline, clock: deps.clock,
      receipt: { kind: command.receipt.commandKind, key: command.receipt.key, digest: Buffer.from(command.receipt.digest, 'hex') },
      authorization: nativeAuthorization,
    }, async (tx, native) => {
      const at = authoritativeTimeValue(native.time);
      const outcome = (state: TargetEvidence['outcome'], reason: TargetEvidence['reason'] = null) =>
        evidence(command, native.transactionId, state, reason);
      if (original.state !== 'pending' && original.state !== 'reconciling') throw new RemovalReceiptMissing();
      if (!readable) return noEffect(outcome('denied', 'target_denied'));
      if (Date.parse(at) >= Date.parse(original.expiresAt)) return noEffect(outcome('cancelled', 'execution_expired'));
      if (sameHome) {
        // Match the operation owner's lock order. Only this transaction may acknowledge a same-home effect.
        await tx.query(`SELECT operation_id FROM library.bulk_operation WHERE route=$1 AND operation_id=$2 FOR UPDATE`,
          [command.source.route, command.source.id]);
        await tx.query(`SELECT ordinal FROM library.bulk_target WHERE route=$1 AND operation_id=$2 AND ordinal=$3 FOR UPDATE`,
          [command.source.route, command.source.id, target.ordinal]);
        const current = await source(tx, command);
        if (!current) throw new Error('Captured removal source changed');
        if (current.state !== 'pending') throw new RemovalReceiptMissing();
      }
      await assertCollectionOrderWritable(tx, route, target.collectionId);
      const parent = await readCollection(tx, route, target.collectionId);
      if (!parent?.curatorAccountId || parent.state !== 'active' || parent.membershipKind === 'dynamic')
        throw new GrantDeniedError();
      const found = await tx.query<{ subjectId: string; revision: string; transactionId: string;
        sameAdmission: boolean; deletionId: string | null }>(
        `SELECT subject_id AS "subjectId",member_revision::text AS revision,transaction_id AS "transactionId",
          added_at=$4::timestamptz AS "sameAdmission",deletion_id AS "deletionId"
         FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3 FOR UPDATE`,
        [route, target.collectionId, target.memberId, target.expected.addedAt]);
      const member = found.rows[0];
      if (!member || member.deletionId) return noEffect(outcome('no_effect', 'missing_target'));
      if (member.subjectId !== target.subjectId || !member.sameAdmission ||
        member.revision !== target.expected.memberRevision || member.transactionId !== target.expected.transactionId)
        return noEffect(outcome('conflict', 'revision_mismatch'));
      // The native parent CAS and member lock protect the captured stamps through deletion. Sibling edits
      // use the current locked parent revision, rather than turning one removal into conflicts for its peers.
      await enterShelfWrite({ client: tx, route, accountId: parent.curatorAccountId });
      const removed = await deleteMembers(tx, route, target.collectionId,
        [{ memberId: target.memberId, deletionId: newId(route) }], parent.revision,
        { transactionId: native.transactionId, time: at });
      if (removed.length !== 1) throw new Error('Captured occurrence failed its locked native removal CAS');
      const retained = await readMemberDeletion(tx, route, target.collectionId, target.memberId);
      if (!retained?.purgeAfter) throw new Error('Native removal did not retain its Undo deadline');
      const value: TargetEvidence = { ...outcome('applied'), memberDeletion: {
        deletionId: removed[0]!.deletionId, revision: removed[0]!.revision, purgeAfter: retained.purgeAfter } };
      if (parent.visibility === 'public') await recordPublicCollectionReduction(tx, route, target.collectionId, native.transactionId);
      if (sameHome) {
        const updated = await tx.query(`UPDATE library.bulk_target SET state='applied',reason=NULL,evidence=$4::jsonb
          WHERE route=$1 AND operation_id=$2 AND ordinal=$3 AND state='pending' RETURNING ordinal`,
          [command.source.route, command.source.id, target.ordinal, JSON.stringify(value)]);
        if (updated.rowCount !== 1) throw new Error('Captured removal target is no longer pending');
        await tx.query(`UPDATE library.bulk_operation SET phase='completed' WHERE route=$1 AND operation_id=$2
          AND NOT EXISTS(SELECT 1 FROM library.bulk_target WHERE route=$1 AND operation_id=$2
          AND state IN ('pending','reconciling') ORDER BY ordinal LIMIT 1)`, [command.source.route, command.source.id]);
      }
      return { value, events: [{ type: 'com.rezics.library.collection.member.changed.v1', subject: target.collectionId,
        data: { collectionId: target.collectionId, memberId: target.memberId, subjectId: target.subjectId } }] };
    });
    return { kind: 'terminal', evidence: result.value };
  } catch (error) {
    if (error instanceof RemovalReceiptMissing) return { kind: 'stop', reason: 'evidence_missing' };
    // Restoration/Access failure never authorizes another write. Only the private exact receipt can recover
    // a committed result; public operation/result readers still require their own current authorization.
    const refused = error instanceof GrantDeniedError || error instanceof DurableInitiatorUnavailableError ||
      error instanceof LifecycleDeniedError || (error instanceof ProblemError && error.code === 'not_found');
    if (!refused && !(error instanceof CommandUnavailableError)) throw error;
    const prior = await committed(deps, deadlineClient(deps.pool, Math.min(command.deadline, Date.now() + BULK_COMMAND_DEADLINE_MS)), command);
    if (prior) return { kind: 'terminal', evidence: prior };
    if (refused) return { kind: 'terminal', evidence: evidence(command, null, 'denied', 'authority_lost') };
    return { kind: 'reconciling', receipt: command.receipt, reason: 'dependency_unavailable' };
  }
}
