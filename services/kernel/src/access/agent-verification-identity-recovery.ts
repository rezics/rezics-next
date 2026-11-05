import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { currentCommand, noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { encodeReceiptKey, nativeReceiptKeyCandidates, receiptKeysFor } from '../command/receipt-key.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { accountAgentId } from '../semantic/agents.ts';
import type { IdentityIntent, IdentityReceipt } from '../semantic/identity-epoch-contract.ts';
import {
  accountIdentityUnavailable,
  publishedAccountIdentityUndo,
  readOriginalAgentIdentityDecision,
} from './agent-verification-identity.ts';
import {
  readOriginalAccountAgentIdentity,
  verifyOriginalAccountAgentIdentity,
  type OriginalAccountAgentIdentity,
} from '../semantic/account-agent-identity-recovery.ts';
import { declareAgentIdentitySource, type AgentIdentitySourceKey } from '../history/agent-identity-source.ts';
import insertOriginal from './agent-verification-identity-recovery-source.sql';
import originalReversal from './agent-verification-identity-recovery-read.sql';
import insertRecovery from './agent-verification-identity-recovery-insert.sql';

type Receipt = Exclude<IdentityReceipt, { kind: 'subject.merge' }>;
type ReversalRow = {
  principal_id: string;
  command_kind: string;
  idempotency_key: string;
  request_digest: Buffer;
  epoch: number;
  position: string;
  transaction_id: string;
  response: {
    accountId: string;
    receiptId: string;
    requestedBy: string;
    kind: 'released' | 'revoked';
    reason: string | null;
    catalogueSubjectId: string;
    verificationReceiptId: string;
  };
  payload_state: string;
  basis_actor: string | null;
  client_id: string | null;
  basis_requested_by: string | null;
  current_epoch: number;
  current_position: string;
};
const serialize = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry));
const normalized = (value: unknown): string => canonicalize(JSON.parse(serialize(value)))!;
const digest = (value: unknown): Buffer => createHash('sha256').update(normalized(value)).digest();
const keyOf = (receipt: Receipt): string => JSON.stringify([receipt.kind, receipt.account, receipt.receipt]);
const nativeReversal = (row: ReversalRow): string =>
  normalized([
    row.principal_id,
    row.command_kind,
    row.idempotency_key,
    row.request_digest,
    row.epoch,
    row.position,
    row.transaction_id,
    row.response,
    row.payload_state,
    row.basis_actor,
    row.client_id,
    row.basis_requested_by,
  ]);

/** Declaration required from Source; neither today's release nor legacy direct mapping can supply it. */
export const ORIGINAL_IDENTITY_SOURCE_REQUIRED =
  'Source semantic/account-agent-identity-recovery.ts#readOriginalAccountAgentIdentity(pool, ' +
  '{account, direction, receipt}): released native original accepted release, intent digest and consumer custody ' +
  '(including the original published undo locator for legacy reversal)';

async function accountHome(tx: CommandTransaction, receipt: Receipt) {
  const route = routeOf(receipt.account)!;
  const command = currentCommand(tx);
  if (command.basis !== null || command.partition !== partitionOf(route))
    throw new TypeError('Identity recovery requires its native platform account home');
  const account = (
    await tx.query<{ kind: 'actor' | 'organization'; state: string; authn_fenced: boolean }>(
      'SELECT kind,state,authn_fenced FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE',
      [route, receipt.account],
    )
  ).rows[0];
  if (!account || (receipt.kind === 'account-agent.verify' && (account.state !== 'active' || account.authn_fenced)))
    throw accountIdentityUnavailable(`account fenced or absent ${receipt.account}`);
  return account;
}

async function reversal(tx: CommandTransaction, receipt: Receipt): Promise<ReversalRow> {
  const account = await accountHome(tx, receipt);
  const row = (await tx.query<ReversalRow>(originalReversal.sql, [currentCommand(tx).partition, receipt.receipt]))
    .rows[0];
  const value = row?.response;
  if (
    !row ||
    row.payload_state !== 'present' ||
    !value ||
    value.accountId !== receipt.account ||
    value.receiptId !== receipt.receipt ||
    value.requestedBy !== row.principal_id ||
    normalized(value) !==
      normalized({
        accountId: value.accountId,
        receiptId: value.receiptId,
        requestedBy: value.requestedBy,
        kind: value.kind,
        reason: value.reason,
        catalogueSubjectId: value.catalogueSubjectId,
        verificationReceiptId: value.verificationReceiptId,
      }) ||
    !['released', 'revoked'].includes(value.kind) ||
    !(value.reason === null || (typeof value.reason === 'string' && Array.from(value.reason).length <= 500)) ||
    routeOf(value.catalogueSubjectId) === null ||
    routeOf(value.verificationReceiptId) === null ||
    row.epoch !== row.current_epoch ||
    BigInt(row.position) <= 0n ||
    BigInt(row.position) > BigInt(row.current_position) ||
    (row.command_kind === 'access.agent-verification.deleted'
      ? account.state !== 'deleted' ||
        value.kind !== 'revoked' ||
        value.reason !== 'Account deleted' ||
        row.principal_id !== receipt.account ||
        !nativeReceiptKeyCandidates(
          tx,
          row.command_kind,
          row.principal_id,
          `delete:${value.verificationReceiptId}`,
        ).includes(row.idempotency_key) ||
        !row.request_digest.equals(createHash('sha256').update(receipt.account).digest())
      : row.command_kind !== `access.agent-verification.${value.kind}` ||
        row.basis_actor !== row.principal_id ||
        row.client_id === null ||
        !row.request_digest.equals(
          digest({
            operation: 'account.reverse_agent_verification',
            client_id: row.client_id,
            requested_by: row.basis_requested_by,
            body: { accountId: receipt.account, kind: value.kind, reason: value.reason },
          }),
        ))
  )
    throw accountIdentityUnavailable(`missing complete original native reversal receipt/write_basis ${keyOf(receipt)}`);
  return row;
}

/** Resolve only the exact Global decision and pending receipt. Personal JSON/history is never searched. */
async function verificationDecision(pool: Pool, receipt: Receipt) {
  const { withReadTransaction } = await import('../semantic/read.ts');
  const request = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query<{ request_id: string }>(
          `SELECT request_id FROM access.agent_verification_request
         WHERE route=0 AND account_id=$1 AND decision_receipt_id=$2`,
          [receipt.account, receipt.receipt],
        )
      ).rows[0],
  );
  if (!request)
    throw accountIdentityUnavailable(
      `missing original Global decision for ${keyOf(receipt)}; Accounts decision required`,
    );
  const decision = await readOriginalAgentIdentityDecision(pool, request.request_id, receipt.receipt);
  if (decision.account_id !== receipt.account || decision.transaction_id !== receipt.receipt)
    throw accountIdentityUnavailable(`mismatched original Global decision ${keyOf(receipt)}`);
  return decision;
}
type Decision = Awaited<ReturnType<typeof verificationDecision>>;
type PendingRow = Pick<
  ReversalRow,
  'principal_id' | 'command_kind' | 'idempotency_key' | 'request_digest' | 'epoch' | 'position' | 'transaction_id'
> & { response: unknown };
async function pending(tx: CommandTransaction, receipt: Receipt, decision: Decision): Promise<PendingRow> {
  const account = await accountHome(tx, receipt);
  const pending = (
    await tx.query<PendingRow>(
      `SELECT r.principal_id,r.command_kind,r.idempotency_key,r.request_digest,r.response,
           r.epoch,r.position::text,r.transaction_id FROM core.receipt r
         JOIN core.partition p ON p.partition_no=r.partition_no AND p.write_state='active'
           AND p.epoch=r.epoch AND p.position>=r.position
         WHERE r.partition_no=$1 AND r.principal_kind='account' AND r.principal_id=$2
           AND r.command_kind='access.agent-verification.pending' AND r.idempotency_key=ANY($3::text[])
           AND r.payload_state='present' AND r.position>0 FOR SHARE OF r`,
      [
        currentCommand(tx).partition,
        decision.requested_by,
        nativeReceiptKeyCandidates(
          tx,
          'access.agent-verification.pending',
          decision.requested_by,
          `${decision.request_id}:pending`,
        ),
      ],
    )
  ).rows;
  const expected = createHash('sha256')
    .update(
      JSON.stringify([
        decision.request_id,
        receipt.account,
        decision.account_kind,
        decision.catalogue_subject_id,
        receipt.receipt,
      ]),
    )
    .digest();
  if (
    account.kind !== decision.account_kind ||
    pending.length !== 1 ||
    !pending[0]!.request_digest.equals(expected) ||
    normalized(pending[0]!.response) !== normalized({ requestId: decision.request_id, accountId: receipt.account })
  )
    throw accountIdentityUnavailable(
      `missing complete original native pending receipt ${keyOf(receipt)}; Accounts pending source required`,
    );
  return pending[0]!;
}

/** Only the existing missing-source branch calls this. No admission capability or caller source JSON is accepted. */
export async function recoverMissingAccountIdentitySource(
  pool: Pool,
  receipt: Receipt,
  error: unknown,
  deadline: number,
): Promise<boolean> {
  if (
    !(error instanceof Error) ||
    !('code' in error) ||
    error.code !== 'identity_epoch_unavailable' ||
    error.message !==
      `Accounts source: missing original ${keyOf(receipt)}; owner must recover native decision/pending or reversal custody`
  )
    return false;
  // The complete Source/History aggregate has not funded the extra foreign probes and
  // recovery writer. Do not dispatch them from a Source frame on the earlier partial
  // allocation; ordinary Access recovery keeps its own command owner and deadline.
  const sourceMaintenance = await import('../semantic/identity-source-consumer-maintenance.ts');
  if (sourceMaintenance.activeIdentitySourceConsumerMaintenance(pool)) {
    const { IdentityHistoryWorkUnavailable } = await import('../history/agent-identity-inventory-work.ts');
    throw new IdentityHistoryWorkUnavailable();
  }
  const partition = partitionOf(routeOf(receipt.account)!);
  // The failed read has released its checkout. All cross-home proofs are collected before reacquiring it.
  const decision = receipt.kind === 'account-agent.verify' ? await verificationDecision(pool, receipt) : null;
  const source = await readOriginalAccountAgentIdentity(pool, {
    account: receipt.account,
    direction: receipt.kind,
    receipt: receipt.receipt,
  });
  if (decision || source) {
    await recoverOriginalSource(pool, receipt, source, decision, deadline);
    return true;
  }
  const original = (
    await runCommand(pool, { partition, deadline }, async (tx) => noEffect(await reversal(tx, receipt)))
  ).value;
  let undo: Awaited<ReturnType<typeof publishedAccountIdentityUndo>>;
  try {
    undo = await publishedAccountIdentityUndo(pool, receipt.account, original.response.verificationReceiptId);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('Accounts source: missing original ') ||
        error.message === 'Accounts source: prior verification has no accepted native undo custody')
    )
      throw accountIdentityUnavailable(
        `${ORIGINAL_IDENTITY_SOURCE_REQUIRED}; prior verification ${original.response.verificationReceiptId} for ${keyOf(receipt)}`,
      );
    throw error;
  }
  const previous = undo.source.input;
  if (
    previous.intent.kind !== 'merge' ||
    previous.intent.survivor !== original.response.catalogueSubjectId ||
    previous.intent.redirected !== accountAgentId(receipt.account) ||
    undo.source.epoch !== original.epoch
  )
    throw accountIdentityUnavailable(`original reversal and prior published source differ ${keyOf(receipt)}`);
  const intent: IdentityIntent = {
    kind: 'unmerge',
    original: accountAgentId(receipt.account),
    undoJob: undo.job,
    verificationReceipt: original.response.verificationReceiptId,
    release: previous.intent.release,
  };
  const intentDigest = digest([intent, receipt]).toString('hex');
  await runCommand(
    pool,
    {
      partition,
      deadline,
      receipt: {
        actorAccountId: original.principal_id,
        kind: 'access.agent-identity.recover',
        key: keyOf(receipt),
        digest: digest([
          keyOf(receipt),
          original.transaction_id,
          original.epoch,
          original.position,
          intentDigest,
          undo.source.digest,
        ]),
      },
    },
    async (tx) => {
      const retained = await reversal(tx, receipt);
      if (nativeReversal(retained) !== nativeReversal(original))
        throw accountIdentityUnavailable(`original reversal custody changed ${keyOf(receipt)}`);
      const existing = (
        await tx.query<{ intent_digest: string }>(
          `SELECT intent_digest FROM access.agent_identity_intent
           WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4 FOR SHARE`,
          [routeOf(receipt.account), receipt.account, receipt.kind, receipt.receipt],
        )
      ).rows[0];
      if (existing) {
        if (existing.intent_digest !== intentDigest)
          throw accountIdentityUnavailable(`conflicting original source ${keyOf(receipt)}`);
        return noEffect(null);
      }
      const saved = await tx.query(insertRecovery.sql, [
        partition,
        routeOf(receipt.account),
        receipt.account,
        receipt.receipt,
        accountAgentId(receipt.account),
        original.response.verificationReceiptId,
        original.principal_id,
        original.command_kind,
        original.idempotency_key,
        serialize(intent),
        intentDigest,
        undo.job.jobId,
        undo.job.epoch.toString(),
        keyOf(receipt),
        `accounts.agent-verification-reversal:${receipt.account}:${receipt.receipt}`,
        undo.source.digest,
        currentCommand(tx).transactionId,
        encodeReceiptKey(
          receiptKeysFor(tx),
          'access.agent-identity.recover',
          { kind: 'account', id: original.principal_id },
          keyOf(receipt),
        ),
      ]);
      if (saved.rowCount !== 1) throw accountIdentityUnavailable(`lost original reversal custody ${keyOf(receipt)}`);
      await declareRecovery(
        tx,
        receipt,
        intentDigest,
        original.principal_id,
        original.response.kind === 'revoked' ? original.principal_id : null,
        undo.source.roles,
      );
      // Native account wakeup, with no duplicate reversing event or fresh reversal decision.
      return {
        value: null,
        events: [
          {
            type: 'com.rezics.access.account-updated.v1',
            subject: receipt.account,
            data: { accountId: receipt.account },
          },
        ],
      };
    },
  );
  return true;
}

// Only the two validated recovery branches can issue a declaration for serializers.
// Its native component is the NEW recovery writer; the original command and Source
// admission components remain separate data on agent_identity_recovery.
const recoveredDeclarations = new WeakMap<
  CommandTransaction,
  ReturnType<typeof import('./agent-verification-identity.ts').originalAccountIdentitySource>
>();
export function originalRecoveredAccountIdentitySource(tx: CommandTransaction) {
  currentCommand(tx);
  return recoveredDeclarations.get(tx);
}
async function declareRecovery(
  tx: CommandTransaction,
  receipt: Receipt,
  digest: string,
  requester: string,
  decider: string | null,
  priorRoles: readonly { account_id: string; role: string }[] = [],
) {
  const command = currentCommand(tx);
  const { ACCOUNT_ROLE_BITS: roles } = await import('../history/contracts.ts');
  const { unionHistoryScope } = await import('../history/record.ts');
  const ref = (accountId: string, mask: number) => ({ accountRoute: routeOf(accountId)!, accountId, roles: mask });
  const key: AgentIdentitySourceKey = Object.freeze({
    route: routeOf(receipt.account)!,
    accountId: receipt.account,
    direction: receipt.kind,
    receiptId: receipt.receipt,
  });
  const accounts = unionHistoryScope('command-receipt/v1', [
    ref(receipt.account, roles.subject),
    ref(requester, roles.actor | roles.principal),
    ...(decider ? [ref(decider, roles.reviewer)] : []),
    ...priorRoles.map(({ account_id, role }) => {
      const mask =
        role === 'subject'
          ? roles.subject
          : role === 'actor'
            ? roles.actor | roles.principal
            : role === 'editor'
              ? roles.reviewer
              : null;
      if (mask === null) throw new TypeError('Unknown original Accounts recovery role');
      return ref(account_id, mask);
    }),
  ]).accounts;
  const component = (
    await tx.query<{ epoch: number; position: string; workflow_id: string; delivery_key: string }>(
      `SELECT p.epoch,p.position::text,i.workflow_id,i.delivery_key
       FROM core.partition p JOIN access.agent_identity_intent i ON i.source_partition=p.partition_no
       WHERE p.partition_no=$1 AND p.write_state='active'
         AND i.route=$2 AND i.account_id=$3 AND i.direction=$4 AND i.receipt_id=$5`,
      [command.partition, key.route, key.accountId, key.direction, key.receiptId],
    )
  ).rows[0]!;
  recoveredDeclarations.set(
    tx,
    Object.freeze({
      writerKind: 'recovery',
      key,
      digest,
      partition: command.partition,
      epoch: component.epoch,
      position: BigInt(component.position) + 1n,
      transactionId: command.transactionId,
      workflowId: component.workflow_id,
      deliveryKey: component.delivery_key,
      // A recovery copy is not an original finite inventory or an SDK handoff.
      handoff: null,
      accounts: Object.freeze(accounts.map((account) => Object.freeze(account))),
    }),
  );
  await declareAgentIdentitySource(tx, key, digest);
}

async function recoverOriginalSource(
  pool: Pool,
  receipt: Receipt,
  source: OriginalAccountAgentIdentity | null,
  decision: Decision | null,
  deadline: number,
): Promise<void> {
  const selection = { account: receipt.account, direction: receipt.kind, receipt: receipt.receipt };
  const partition = partitionOf(routeOf(receipt.account)!);
  // This checkout independently stages the original Accounts command. All Source
  // foreign reads have already finished, including the prior fixed-three publication.
  const staged = (
    await runCommand(pool, { partition, deadline }, async (tx) =>
      noEffect({
        pending: decision ? await pending(tx, receipt, decision) : null,
        reversal: decision ? null : await reversal(tx, receipt),
      }),
    )
  ).value;
  const original = staged.pending ?? staged.reversal!;
  if (!source) throw accountIdentityUnavailable(`${ORIGINAL_IDENTITY_SOURCE_REQUIRED}; ${keyOf(receipt)}`);
  const intent = source.input.intent;
  const prior = source.priorVerification;
  const value = staged.reversal?.response;
  const catalogue = decision?.catalogue_subject_id ?? value?.catalogueSubjectId;
  if (
    normalized(source.input.receipt) !== normalized(receipt) ||
    source.digest !== digest([intent, receipt]).toString('hex') ||
    (decision
      ? intent.kind !== 'merge' || intent.survivor !== catalogue || prior !== null
      : !value ||
        intent.kind !== 'unmerge' ||
        !prior ||
        prior.input.intent.kind !== 'merge' ||
        prior.input.intent.survivor !== catalogue ||
        prior.input.intent.redirected !== accountAgentId(receipt.account) ||
        prior.verificationReceipt !== value.verificationReceiptId ||
        intent.verificationReceipt !== prior.verificationReceipt ||
        intent.release !== prior.input.intent.release ||
        normalized(intent.undoJob) !== normalized(prior.job))
  )
    throw accountIdentityUnavailable(`original Account and Source evidence differ ${keyOf(receipt)}`);
  // Bind the recovery receipt to every persisted reference, including both native
  // domains. A replay can never swap an accepted Source claim or its current job.
  const requestDigest = digest([
    keyOf(receipt),
    original.transaction_id,
    original.epoch,
    original.position,
    source.digest,
    prior?.digest ?? null,
    source.native.transactionId,
    source.native.epoch,
    source.native.position,
    source.claim.generation,
    source.job.jobId,
    source.job.epoch,
    source.claim.scope,
    decision?.transaction_id ?? null,
    decision?.epoch ?? null,
    decision?.position ?? null,
  ]);
  await runCommand(
    pool,
    {
      partition,
      deadline,
      receipt: {
        actorAccountId: original.principal_id,
        kind: 'access.agent-identity.recover',
        key: keyOf(receipt),
        digest: requestDigest,
      },
    },
    async (tx) => {
      const changed = decision
        ? normalized(await pending(tx, receipt, decision)) !== normalized(staged.pending)
        : nativeReversal(await reversal(tx, receipt)) !== nativeReversal(staged.reversal!);
      if (changed) throw accountIdentityUnavailable(`original Account custody changed ${keyOf(receipt)}`);
      // Supply the actual opaque object returned by Source, never its serialized data.
      if (!(await verifyOriginalAccountAgentIdentity(tx, selection, source)))
        throw accountIdentityUnavailable(
          `Source verifyOriginalAccountAgentIdentity lost original custody ${keyOf(receipt)}`,
        );
      const existing = (
        await tx.query<{ intent_digest: string; original_source: unknown; original_source_minimized: boolean }>(
          `SELECT i.intent_digest,a.original_source,COALESCE(a.original_source_minimized,false) AS original_source_minimized
       FROM access.agent_identity_intent i
       LEFT JOIN access.agent_identity_recovery a USING(route,account_id,direction,receipt_id)
       WHERE i.route=$1 AND i.account_id=$2 AND i.direction=$3 AND i.receipt_id=$4 FOR SHARE OF i`,
          [routeOf(receipt.account), receipt.account, receipt.kind, receipt.receipt],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.original_source_minimized ||
          existing.intent_digest !== source.digest ||
          normalized(existing.original_source) !== normalized(source)
        )
          throw accountIdentityUnavailable(`conflicting original source ${keyOf(receipt)}`);
        return noEffect(null);
      }
      const account = await accountHome(tx, receipt);
      const saved = await tx.query(insertOriginal.sql, [
        partition,
        serialize({
          route: routeOf(receipt.account),
          account_id: receipt.account,
          direction: receipt.kind,
          receipt_id: receipt.receipt,
          agent_id: accountAgentId(receipt.account),
          account_kind: account.kind,
          catalogue_id: catalogue,
          request_id: decision?.request_id ?? null,
          requested_by: original.principal_id,
          decided_by: decision?.decided_by ?? (value?.kind === 'revoked' ? original.principal_id : null),
          decision_epoch: decision?.epoch ?? null,
          decision_position: decision?.position ?? null,
          decision_transaction_id: decision?.transaction_id ?? null,
          pending_receipt_id: original.transaction_id,
          verification_receipt_id: prior?.verificationReceipt ?? null,
          disposition: value?.kind ?? null,
          reason: value?.reason ?? null,
          release: intent.release,
          intent,
          intent_digest: source.digest,
          source_epoch: original.epoch,
          source_position: original.position,
          source_transaction_id: original.transaction_id,
          undo_job_id: prior?.job.jobId ?? null,
          undo_job_epoch: prior?.job.epoch ?? null,
          delivery_key: keyOf(receipt),
          workflow_id: decision
            ? `accounts.agent-verification:${decision.request_id}:${receipt.receipt}`
            : `accounts.agent-verification-reversal:${receipt.account}:${receipt.receipt}`,
          native_command_kind: original.command_kind,
          native_receipt_key: original.idempotency_key,
          verification_intent_digest: prior?.digest ?? null,
          original_source: source,
          recovery_transaction_id: currentCommand(tx).transactionId,
          recovery_receipt_key: encodeReceiptKey(
            receiptKeysFor(tx),
            'access.agent-identity.recover',
            { kind: 'account', id: original.principal_id },
            keyOf(receipt),
          ),
          recovery_digest: requestDigest.toString('hex'),
        }),
      ]);
      if (saved.rowCount !== 1) throw accountIdentityUnavailable(`lost original source custody ${keyOf(receipt)}`);
      await declareRecovery(
        tx,
        receipt,
        source.digest,
        original.principal_id,
        decision?.decided_by ?? (value?.kind === 'revoked' ? original.principal_id : null),
      );
      return {
        value: null,
        events: [
          {
            type: 'com.rezics.access.account-updated.v1',
            subject: receipt.account,
            data: { accountId: receipt.account },
          },
        ],
      };
    },
  );
}
