import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import type { DurableInitiatorReader, DurableInitiatorRecord } from '../access/durable-initiator.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { AccessClient } from '../request/access.ts';
import readOperation from './read-workflow-erasure-operation.sql';
import readReceipt from './read-workflow-erasure-receipt.sql';

/** Preserve the source/receipt LEFT JOIN within the caller's transaction snapshot. */
export async function readWorkflowErasureOperation(
  client: AccessClient,
  input: (typeof readOperation)['~reylo']['input'] & { partition_no: number },
) {
  const row = await readOperation.run(client, input);
  if (!row) return null;
  const { initiator_account_id, author_account_id, actor_account_id, actor_client_id } = row;
  // A minimized terminal operation can never supply an initiator again.
  if (
    initiator_account_id === null ||
    author_account_id === null ||
    actor_account_id === null ||
    actor_client_id === null
  )
    return null;
  const receipt = await readReceipt.run(client, {
    partition_no: input.partition_no,
    initiator_account_id,
    creation_command_kind: row.creation_command_kind,
    creation_idempotency_key: row.creation_idempotency_key,
  });
  return {
    ...row,
    initiator_account_id,
    author_account_id,
    actor_account_id,
    actor_client_id,
    receipt_transaction_id: receipt?.receipt_transaction_id ?? null,
    receipt_request_digest: receipt?.receipt_request_digest ?? null,
    receipt_commitment: receipt?.receipt_commitment ?? null,
  };
}

/** The operation row is its own immutable source. Native workflow identity is a
 * relay binding, never a durable initiator source or authority. Missing original
 * provenance is deliberately not reconstructed from current account state.
 */
export const readErasureInitiator: DurableInitiatorReader = async (client, operation) => {
  if (
    operation.kind !== 'content.author-erasure' ||
    operation.sourceId !== operation.id ||
    routeOf(operation.id) !== operation.route
  )
    return null;
  const row = await readWorkflowErasureOperation(client, {
    partition_no: partitionOf(operation.route),
    route: operation.route,
    operation_id: operation.id,
  });
  if (
    !row ||
    row.empty_scope ||
    row.actor_kind !== 'account' ||
    row.actor_account_id !== row.initiator_account_id ||
    row.upper_created_at === null ||
    row.upper_post_id === null ||
    row.source_digest === null ||
    row.original_minimum_authn_epoch === null ||
    row.creation_command_kind !== operation.kind ||
    row.creation_idempotency_key === null ||
    row.creation_request_digest === null ||
    row.creation_target_route === null ||
    row.creation_target_id === null ||
    row.receipt_transaction_id !== row.recorded_transaction_id ||
    row.receipt_request_digest !== row.creation_request_digest ||
    row.receipt_commitment === null
  )
    return null;
  if (
    row.actor_requested_by === null
      ? row.original_delegation_transaction_id !== null || row.original_delegation_issued_valid !== null
      : row.original_delegation_transaction_id === null || row.original_delegation_issued_valid === null
  )
    return null;
  const authnEpoch = Number(row.actor_authn_epoch);
  if (!Number.isSafeInteger(authnEpoch) || authnEpoch <= 0) return null;
  const scopes = row.actor_scopes;
  if (!scopes.every((scope): scope is string => scope !== null)) return null;
  const record: DurableInitiatorRecord = {
    operation: {
      route: row.route,
      id: row.operation_id,
      kind: row.creation_command_kind,
      sourceId: row.operation_id,
    },
    initiatorAccountId: row.initiator_account_id,
    actor: {
      kind: 'account',
      accountId: row.actor_account_id,
      clientId: row.actor_client_id,
      scopes,
      requestedBy: row.actor_requested_by,
      authnEpoch,
    },
    recordedTransactionId: row.recorded_transaction_id,
    sourceDigest: row.source_digest,
    originalAccount: {
      minimumAuthnEpoch: row.original_minimum_authn_epoch,
      operatorAccountId: row.original_operator_account_id,
    },
    originalDelegation:
      row.actor_requested_by === null
        ? null
        : {
            transactionId: row.original_delegation_transaction_id!,
            issuedValid: row.original_delegation_issued_valid!,
          },
    creation: {
      commandKind: row.creation_command_kind,
      idempotencyKey: row.creation_idempotency_key,
      requestDigest: row.creation_request_digest,
      target: { route: row.creation_target_route, id: row.creation_target_id },
    },
  };
  const sourceDigest = createHash('sha256')
    .update(
      canonicalize({
        operation: record.operation,
        target: record.creation.target,
        selection: {
          threadId: row.thread_id,
          authorId: row.author_account_id,
          upperCreatedAt: row.upper_created_at,
          upperPostId: row.upper_post_id,
        },
      })!,
    )
    .digest('hex');
  if (sourceDigest !== record.sourceDigest || durableInitiatorCommitment(record) !== row.receipt_commitment)
    return null;
  return record;
};
