import canonicalize from 'canonicalize';
import type { AccountActor, AccessClient } from '../request/access.ts';
import { readAccount } from '../access/account-data.ts';
import { shareAccount } from '../access/account-share.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { DurableInitiatorUnavailableError, type DurableInitiatorRecord } from '../access/durable-initiator.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { PlatformClosedError } from '../access/gates/admission.ts';
import { resourceAuthorization, type AuthorizationAnchor } from '../access/resource-authorization.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  noEffect,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { deadlineFor } from '../request/deadline.ts';
import {
  BULK_COMMAND_DEADLINE_MS,
  type AttemptResult,
  type BulkDependencies,
  type SubjectTarget,
  type TargetCommand,
  type TargetEvidence,
} from './bulk-contract.ts';
import { deleteLibraryEntryInTransaction } from './entries.ts';
import { admitEntryAttempt } from './entry-lifecycle.ts';
import { enterShelfWrite } from './shelf-counter-owner.ts';
import { createShelfHeads } from './shelf-heads.ts';

type Binding = {
  record: DurableInitiatorRecord;
  phase: string;
  expiresAt: string;
  resultsExpireAt: string;
  state: string;
  evidence: TargetEvidence | null;
  chunkUnits: number;
};
class MissingEvidence extends Error {}
class ExecutionExpired extends Error {}
class ChunkRefused extends Error {}
const same = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);

/** Only native source keys are accepted; caller data never supplies an actor or permission. */
function validate(command: TargetCommand): void {
  const { source, target, receipt } = command;
  if (
    target.kind !== 'subject' ||
    target.operationId !== source.id ||
    routeOf(source.id) !== source.route ||
    routeOf(source.sourceId) !== source.route ||
    routeOf(receipt.principalId) !== source.route ||
    receipt.principalKind !== 'account' ||
    receipt.partition !== partitionOf(source.route) ||
    routeOf(target.subjectId) === null ||
    !/^(0|[1-9][0-9]{0,2})$/.test(target.ordinal) ||
    !/^[a-f0-9]{64}$/.test(command.sourceDigest) ||
    !/^[a-f0-9]{64}$/.test(receipt.digest) ||
    !Number.isSafeInteger(command.chunkIndex) ||
    command.chunkIndex < 0 ||
    !Number.isFinite(command.deadline)
  )
    throw new TypeError('Invalid personal Library removal target');
}

/** Full-key source/manifest comparison. The installed reader independently verifies creation provenance. */
async function binding(
  deps: BulkDependencies,
  client: AccessClient,
  command: TargetCommand,
  time: AuthoritativeTime,
  lock = false,
): Promise<Binding> {
  const { source, target, receipt } = command;
  const record = await deps.readInitiator(client, source, time);
  if (
    !record ||
    !same(record.operation, source) ||
    record.initiatorAccountId !== receipt.principalId ||
    record.actor.accountId !== receipt.principalId
  )
    throw new MissingEvidence();
  const operation = (
    await client.query<{
      phase: string;
      expiresAt: string;
      resultsExpireAt: string;
      initiator: DurableInitiatorRecord;
      sourceDigest: string;
      request: { action: string };
    }>(
      `SELECT phase,expires_at::text AS "expiresAt",results_expire_at::text AS "resultsExpireAt",
      initiator,source_digest AS "sourceDigest",request FROM library.bulk_operation
      WHERE route=$1 AND operation_id=$2 AND account_id=$3 ${lock ? 'FOR UPDATE' : ''}`,
      [source.route, source.id, receipt.principalId],
    )
  ).rows[0];
  if (
    !operation ||
    operation.request.action !== 'remove_from_library' ||
    operation.sourceDigest !== command.sourceDigest ||
    !same(operation.initiator, record) ||
    Date.parse(authoritativeTimeValue(time)) >= Date.parse(operation.resultsExpireAt)
  )
    throw new MissingEvidence();
  const row = (
    await client.query<{
      target: SubjectTarget;
      receipt: TargetCommand['receipt'];
      sourceDigest: string;
      chunkIndex: number;
      state: string;
      evidence: TargetEvidence | null;
    }>(
      `SELECT target,receipt,source_digest AS "sourceDigest",chunk_index AS "chunkIndex",state,evidence
      FROM library.bulk_target WHERE route=$1 AND operation_id=$2 AND account_id=$3 AND ordinal=$4
      ${lock ? 'FOR UPDATE' : ''}`,
      [source.route, source.id, receipt.principalId, target.ordinal],
    )
  ).rows[0];
  if (
    !row ||
    !same(row.target, target) ||
    !same(row.receipt, receipt) ||
    row.sourceDigest !== command.sourceDigest ||
    row.chunkIndex !== command.chunkIndex
  )
    throw new MissingEvidence();
  const chunk = (
    await client.query<{ units: number }>(
      `SELECT count(*)::integer AS units FROM library.bulk_target
    WHERE route=$1 AND operation_id=$2 AND account_id=$3 AND ordinal >= $4 AND ordinal < $5 AND chunk_index=$6`,
      [
        source.route,
        source.id,
        receipt.principalId,
        command.chunkIndex * 100,
        (command.chunkIndex + 1) * 100,
        command.chunkIndex,
      ],
    )
  ).rows[0];
  if (!chunk || chunk.units < 1 || chunk.units > 100) throw new MissingEvidence();
  return {
    record,
    chunkUnits: chunk.units,
    phase: operation.phase,
    expiresAt: operation.expiresAt,
    resultsExpireAt: operation.resultsExpireAt,
    state: row.state,
    evidence: row.evidence,
  };
}

/** Private accounting only: no actor restoration, write, outcome acknowledgement or public disclosure.
 * A terminal row alone cannot prove a commit; its original native receipt must agree in full.
 */
async function recover(deps: BulkDependencies, command: TargetCommand) {
  return within(command.deadline, () =>
    withConnection(deps.pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const bounded = deadlineClient(client, command.deadline);
        const time = await mintReadTime(bounded, deps.clock);
        const current = await binding(deps, bounded, command, time);
        const receipt = command.receipt;
        const result = (
          await bounded.query<{
            digest: Buffer;
            transactionId: string;
            response: TargetEvidence;
            payloadState: string;
          }>(
            `SELECT request_digest AS digest,transaction_id AS "transactionId",response,payload_state AS "payloadState"
        FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
        AND command_kind=$3 AND idempotency_key=ANY($4::text[]) LIMIT 1`,
            [
              receipt.partition,
              receipt.principalId,
              receipt.commandKind,
              nativeReceiptKeyCandidates(deps.pool, receipt.commandKind, receipt.principalId, receipt.key),
            ],
          )
        ).rows[0];
        if (result || current.evidence || !['pending', 'reconciling'].includes(current.state)) {
          const evidence = current.evidence;
          if (
            !result ||
            !evidence ||
            result.payloadState !== 'present' ||
            Buffer.from(result.digest).toString('hex') !== receipt.digest ||
            result.transactionId !== evidence.transactionId ||
            !same(result.response, evidence) ||
            evidence.operationId !== command.source.id ||
            evidence.ordinal !== command.target.ordinal ||
            evidence.sourceDigest !== command.sourceDigest ||
            !same(evidence.receipt, receipt) ||
            evidence.outcome !== current.state
          )
            throw new MissingEvidence();
        }
        await client.query('COMMIT');
        return current;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }),
  );
}

/** Captured expectation is compared under the ordinary owner and entry locks, at the actual effect. */
async function remove(
  tx: CommandTransaction,
  context: { time: AuthoritativeTime; transactionId: string },
  actor: AccountActor,
  target: SubjectTarget,
) {
  const route = routeOf(actor.accountId)!;
  const write = { client: tx, route, accountId: actor.accountId };
  await enterShelfWrite(write);
  await createShelfHeads().ensure(write, target.subjectId);
  const current = (
    await tx.query<{ incarnation: string | null; revision: number; sequence: string | null }>(
      `SELECT incarnation_id AS incarnation,revision,owner_write_seq::text AS sequence FROM library.entry
      WHERE route=$1 AND account_id=$2 AND subject_id=$3 FOR UPDATE`,
      [route, actor.accountId, target.subjectId],
    )
  ).rows[0];
  if (target.expected.kind === 'absent') {
    // The native owner counter also advances for an intervening create/clear. No per-slot tombstone is invented.
    const counter = (
      await tx.query<{ seq: string }>(
        `SELECT seq::text FROM library.owner_write_counter
      WHERE route=$1 AND account_id=$2 FOR SHARE`,
        [route, actor.accountId],
      )
    ).rows[0];
    if (!current && counter?.seq === target.expected.slotGeneration)
      return { outcome: 'no_effect' as const, reason: null, events: [] };
  } else if (
    current &&
    current.incarnation === target.expected.incarnation &&
    current.revision === target.expected.revision &&
    current.sequence === target.expected.admissionSequence &&
    current.revision <= 2_147_483_644
  ) {
    const deletion = await deleteLibraryEntryInTransaction(
      tx,
      context,
      actor,
      target.subjectId,
      target.expected.revision,
      target.expected.incarnation,
    );
    return { outcome: 'applied' as const, reason: null, events: deletion.events, deletion: deletion.value };
  }
  return { outcome: 'conflict' as const, reason: 'revision_mismatch' as const, events: [] };
}

/** Native personal entry effects always share the initiating owner's home with their terminal result. */
export async function executeLibraryRemovalTarget(
  deps: BulkDependencies,
  original: TargetCommand,
): Promise<AttemptResult> {
  validate(original);
  const command = { ...original, deadline: Math.min(original.deadline, deadlineFor(BULK_COMMAND_DEADLINE_MS)) };
  try {
    const initial = await recover(deps, command);
    if (initial.evidence) return { kind: 'terminal', evidence: initial.evidence };
    const { receipt, source } = command;
    const resource = { route: source.route, id: receipt.principalId };
    const anchor: AuthorizationAnchor = {
      resource,
      async validate(client) {
        const current = await readAccount(client, resource.route, resource.id);
        return (
          !!current &&
          current.kind === 'actor' &&
          current.state === 'active' &&
          !current.fenced &&
          current.minimumAuthnEpoch <= BigInt(initial.record.actor.authnEpoch)
        );
      },
    };
    type Prepared = { native: CommandAuthorization; proof: unknown; actor: AccountActor; binding?: Binding };
    const prepared = new WeakMap<AuthoritativeTime, Prepared>();
    const authorization: CommandAuthorization = {
      action: 'library_entry:delete',
      resource,
      denied: () => new GrantDeniedError(),
      async prepare(attempt) {
        const actor = await deps.initiators.restoreInitiator(
          {
            operation: source,
            action: 'library_entry:delete',
            anchor,
            context: { pool: deps.pool, deadline: command.deadline },
          },
          attempt.time,
        );
        if (!same(principalCommandIdentity(actor), principalCommandIdentity(initial.record.actor)))
          throw new GrantDeniedError();
        await admitEntryAttempt(deps, actor, 'library_entry:delete', attempt, command.deadline);
        const native = resourceAuthorization({
          access: deps.access,
          actor,
          action: 'library_entry:delete',
          anchor,
          context: { pool: deps.pool, deadline: command.deadline, partition: receipt.partition },
        });
        const proof = await native.prepare!(attempt);
        const spent = await deps.spendChunk?.(
          { pool: deps.pool, actor, deadline: command.deadline },
          { operation: source, index: command.chunkIndex },
          'write',
          initial.chunkUnits,
        );
        if (spent && !spent.allowed) throw new ChunkRefused();
        prepared.set(attempt.time, { native, proof, actor });
      },
      async authorize(tx, attempt) {
        const current = prepared.get(attempt.time);
        if (!current) throw new GrantDeniedError();
        await shareAccount(tx, resource.id);
        if ((await current.native.authorize(tx, attempt, current.proof)) !== 'execute') throw new GrantDeniedError();
        current.binding = await binding(deps, tx, command, attempt.time, true);
        return 'execute';
      },
    };
    const result = await runCommand(
      deps.pool,
      {
        ...principalCommandIdentity(initial.record.actor),
        partition: receipt.partition,
        deadline: command.deadline,
        clock: deps.clock,
        receipt: { kind: receipt.commandKind, key: receipt.key, digest: Buffer.from(receipt.digest, 'hex') },
        authorization,
      },
      async (tx, context) => {
        const current = prepared.get(context.time)!.binding!;
        if (current.evidence || current.phase !== 'applying' || current.state !== 'pending')
          throw new MissingEvidence();
        if (Date.parse(authoritativeTimeValue(context.time)) >= Date.parse(current.expiresAt))
          throw new ExecutionExpired();
        const actor = prepared.get(context.time)!.actor;
        const effect = await remove(tx, context, actor, command.target as SubjectTarget);
        const evidence: TargetEvidence = {
          operationId: source.id,
          ordinal: command.target.ordinal,
          sourceDigest: command.sourceDigest,
          receipt,
          transactionId: context.transactionId,
          outcome: effect.outcome,
          reason: effect.reason,
          resultingMemberId: null,
          ...('deletion' in effect ? { deletion: effect.deletion } : {}),
        };
        await tx.query(
          `UPDATE library.bulk_target SET state=$5,reason=$6,evidence=$7
        WHERE route=$1 AND operation_id=$2 AND account_id=$3 AND ordinal=$4 AND state='pending'`,
          [
            source.route,
            source.id,
            resource.id,
            command.target.ordinal,
            evidence.outcome,
            evidence.reason,
            JSON.stringify(evidence),
          ],
        );
        await tx.query(
          `UPDATE library.bulk_operation SET phase='completed' WHERE route=$1 AND operation_id=$2
        AND account_id=$3 AND NOT EXISTS (SELECT 1 FROM library.bulk_target
          WHERE route=$1 AND operation_id=$2 AND state IN ('pending','reconciling') ORDER BY ordinal LIMIT 1)`,
          [source.route, source.id, resource.id],
        );
        return effect.events.length ? { value: evidence, events: effect.events } : noEffect(evidence);
      },
    );
    // runCommand only returns after the shared receipt/effect/outcome transaction commits.
    return { kind: 'terminal', evidence: result.value };
  } catch (error) {
    if (error instanceof MissingEvidence) return { kind: 'stop', reason: 'evidence_missing' };
    if (error instanceof ExecutionExpired) return { kind: 'stop', reason: 'execution_expired' };
    if (
      error instanceof GrantDeniedError ||
      error instanceof LifecycleDeniedError ||
      error instanceof PlatformClosedError ||
      error instanceof DurableInitiatorUnavailableError
    ) {
      // A concurrent attempt may already have committed. This read grants no authority to try another deletion.
      try {
        const committed = await recover(deps, command);
        if (committed.evidence) return { kind: 'terminal', evidence: committed.evidence };
      } catch (recoveryError) {
        if (recoveryError instanceof MissingEvidence) return { kind: 'stop', reason: 'evidence_missing' };
        throw recoveryError;
      }
      return { kind: 'stop', reason: 'authority_lost' };
    }
    const unavailable = classifyUnavailability(error);
    if (unavailable || error instanceof ChunkRefused)
      return {
        kind: 'reconciling',
        receipt: command.receipt,
        reason: unavailable === 'deadline' ? 'deadline' : 'dependency_unavailable',
      };
    throw error;
  }
}
