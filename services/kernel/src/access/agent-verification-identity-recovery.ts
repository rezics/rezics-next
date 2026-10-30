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
async function verification(pool: Pool, receipt: Receipt): Promise<never> {
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
  await runCommand(pool, { partition: partitionOf(routeOf(receipt.account)!) }, async (tx) => {
    const account = await accountHome(tx, receipt);
    const pending = (
      await tx.query<{ request_digest: Buffer; response: unknown }>(
        `SELECT r.request_digest,r.response FROM core.receipt r
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
            `${request.request_id}:pending`,
          ),
        ],
      )
    ).rows;
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          request.request_id,
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
      normalized(pending[0]!.response) !== normalized({ requestId: request.request_id, accountId: receipt.account })
    )
      throw accountIdentityUnavailable(
        `missing complete original native pending receipt ${keyOf(receipt)}; Accounts pending source required`,
      );
    return noEffect(null);
  });
  // That original native response retained no accepted release or consumer intent. Do not fill either from now.
  throw accountIdentityUnavailable(`${ORIGINAL_IDENTITY_SOURCE_REQUIRED}; ${keyOf(receipt)}`);
}

/** Only the existing missing-source branch calls this. No admission capability or caller source JSON is accepted. */
export async function recoverMissingAccountIdentitySource(
  pool: Pool,
  receipt: Receipt,
  error: unknown,
): Promise<boolean> {
  if (
    !(error instanceof Error) ||
    !('code' in error) ||
    error.code !== 'identity_epoch_unavailable' ||
    error.message !==
      `Accounts source: missing original ${keyOf(receipt)}; owner must recover native decision/pending or reversal custody`
  )
    return false;
  const partition = partitionOf(routeOf(receipt.account)!);
  // The failed read has released its checkout. All cross-home proofs are collected before reacquiring it.
  if (receipt.kind === 'account-agent.verify') await verification(pool, receipt);
  const original = (await runCommand(pool, { partition }, async (tx) => noEffect(await reversal(tx, receipt)))).value;
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
