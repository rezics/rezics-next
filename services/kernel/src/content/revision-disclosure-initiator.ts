import { durableInitiatorCommitment } from './access-port.ts';
import type { DurableInitiatorReader, DurableInitiatorRecord } from '../access/durable-initiator.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import { requestDigest } from '../command/request.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  REVISION_DISCLOSURE_ISSUE,
  type RevisionDisclosureRow,
  type RevisionDisclosureSource,
} from './revision-disclosure-model.ts';
import { revisionDisclosureDigest, revisionDisclosureHex, sourceOf, targetOf } from './revision-disclosure-store.ts';
import readInitiator from './revision-disclosure-initiator.sql';

export function revisionDisclosureSourceDigest(
  row: Pick<
    RevisionDisclosureRow,
    'route' | 'disclosure_id' | 'catalogue_id' | 'issued_transaction_id' | 'licence' | 'issuer_account_id'
  > &
    RevisionDisclosureSource,
  operationId: string,
): string {
  return revisionDisclosureDigest({
    operation: {
      route: row.route,
      id: operationId,
      kind: REVISION_DISCLOSURE_ISSUE,
      sourceId: row.disclosure_id,
    },
    target: { route: row.route, id: row.postId },
    catalogueId: row.catalogue_id,
    source: {
      threadId: row.threadId,
      postId: row.postId,
      revisionId: row.revisionId,
      sha256: row.sha256,
      licence: row.licence,
      creatorAccountId: row.issuer_account_id,
      incarnation: row.incarnation,
    },
    creationTransactionId: row.issued_transaction_id,
  });
}

function actorFrom(row: RevisionDisclosureRow): DurableInitiatorRecord['actor'] | null {
  const authnEpoch = Number(row.actor_authn_epoch);
  if (
    !Number.isSafeInteger(authnEpoch) ||
    authnEpoch <= 0 ||
    !Array.isArray(row.actor_scopes) ||
    !row.actor_scopes.every((scope) => typeof scope === 'string') ||
    (row.actor_requested_by === null
      ? row.original_delegation_transaction_id !== null || row.original_delegation_issued_valid !== null
      : row.original_delegation_transaction_id === null || row.original_delegation_issued_valid === null)
  )
    return null;
  return {
    kind: 'account',
    accountId: row.issuer_account_id,
    clientId: row.actor_client_id,
    scopes: row.actor_scopes,
    requestedBy: row.actor_requested_by,
    authnEpoch,
  };
}

/** Concrete Content-owned issue/source/receipt reader. */
export const readRevisionDisclosureInitiator: DurableInitiatorReader = async (client, operation) => {
  if (
    operation.kind !== REVISION_DISCLOSURE_ISSUE ||
    routeOf(operation.id) !== operation.route ||
    routeOf(operation.sourceId) !== operation.route
  )
    return null;
  const row = await readInitiator.run(client, {
    route: operation.route,
    operation_id: operation.id,
    disclosure_id: operation.sourceId,
    partition_no: partitionOf(operation.route),
  });
  if (!row || row.revoked_at !== null) return null;
  const actor = actorFrom(row);
  if (!actor) return null;
  const source = sourceOf(row);
  const record: DurableInitiatorRecord = {
    operation: {
      route: row.route,
      id: row.operation_id,
      kind: REVISION_DISCLOSURE_ISSUE,
      sourceId: row.disclosure_id,
    },
    initiatorAccountId: row.issuer_account_id,
    actor,
    recordedTransactionId: row.issued_transaction_id,
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
      commandKind: REVISION_DISCLOSURE_ISSUE,
      idempotencyKey: row.creation_idempotency_key,
      requestDigest: row.creation_request_digest,
      target: { route: row.route, id: row.post_id },
    },
  };
  if (
    revisionDisclosureSourceDigest({ ...row, ...source }, operation.id) !== record.sourceDigest ||
    revisionDisclosureHex(
      requestDigest(REVISION_DISCLOSURE_ISSUE, record.actor, {
        catalogueId: row.catalogue_id,
        target: targetOf(row),
      }),
    ) !== record.creation.requestDigest
  )
    return null;
  const receipt = (
    await client.query<{
      transaction_id: string;
      digest: string;
      commitment: string;
      disclosure_id: string;
    }>(
      `SELECT transaction_id, encode(request_digest,'hex') AS digest,
        response->>'durableInitiator' AS commitment, response->>'disclosureId' AS disclosure_id
      FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
        AND command_kind=$3 AND idempotency_key=ANY($4::text[]) LIMIT 1`,
      [
        partitionOf(row.route),
        row.issuer_account_id,
        REVISION_DISCLOSURE_ISSUE,
        nativeReceiptKeyCandidates(
          client,
          REVISION_DISCLOSURE_ISSUE,
          row.issuer_account_id,
          row.creation_idempotency_key,
        ),
      ],
    )
  ).rows[0];
  if (
    !receipt ||
    receipt.transaction_id !== record.recordedTransactionId ||
    receipt.digest !== record.creation.requestDigest ||
    receipt.disclosure_id !== row.disclosure_id ||
    receipt.commitment !== durableInitiatorCommitment(record)
  )
    return null;
  return record;
};
