import { durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import type { DurableInitiatorReader, DurableInitiatorRecord } from '../access/durable-initiator.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import { principalCommandIdentity } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { editionDigest, editionRow, editionSource, sameSource, sourceOf, type EditionRow } from './edition-store.ts';

export const EDITION_PUBLISH = 'content.edition.publish';
export function publicationSourceDigest(row: EditionRow, operationId: string): string {
  return editionDigest({
    operation: { route: row.route, id: operationId, kind: EDITION_PUBLISH, sourceId: row.edition_id },
    target: { route: row.route, id: row.edition_id },
    source: sourceOf(row),
    creationTransactionId: row.recorded_transaction_id,
  });
}
type PublicationRow = {
  route: number;
  operation_id: string;
  edition_id: string;
  recorded_transaction_id: string;
  initiator_account_id: string;
  actor_client_id: string;
  actor_scopes: string[];
  actor_requested_by: string | null;
  actor_authn_epoch: string;
  original_minimum_authn_epoch: string;
  original_operator_account_id: string | null;
  original_delegation_transaction_id: string | null;
  original_delegation_issued_valid: string | null;
  source_digest: string;
  creation_idempotency_key: string;
  creation_request_digest: string;
};

/** Concrete Content-owned operation/source/receipt reader; no configurable success predicate. */
export const readEditionInitiator: DurableInitiatorReader = async (client, operation) => {
  if (
    operation.kind !== EDITION_PUBLISH ||
    routeOf(operation.id) !== operation.route ||
    routeOf(operation.sourceId) !== operation.route
  )
    return null;
  const row = (
    await client.query<PublicationRow>(
      `SELECT p.* FROM content.edition_publication p
     JOIN editorial.write_basis w ON w.partition_no=$4 AND w.transaction_id=p.recorded_transaction_id
       AND w.principal_kind='account' AND w.principal_id=p.initiator_account_id
       AND w.client_id=p.actor_client_id AND w.requested_by IS NOT DISTINCT FROM p.actor_requested_by
     WHERE p.route=$1 AND p.operation_id=$2 AND p.edition_id=$3`,
      [operation.route, operation.id, operation.sourceId, partitionOf(operation.route)],
    )
  ).rows[0];
  if (!row) return null;
  const edition = await editionRow(client, row.edition_id);
  if (
    !edition ||
    edition.state !== 'published' ||
    edition.creator_account_id !== row.initiator_account_id ||
    !sameSource(
      await editionSource(client, edition.post_id, edition.revision_id, edition.target_subject_id),
      sourceOf(edition),
    )
  )
    return null;
  const authnEpoch = Number(row.actor_authn_epoch);
  if (
    !Number.isSafeInteger(authnEpoch) ||
    authnEpoch <= 0 ||
    !row.actor_scopes.every((scope) => typeof scope === 'string') ||
    (row.actor_requested_by === null
      ? row.original_delegation_transaction_id !== null || row.original_delegation_issued_valid !== null
      : row.original_delegation_transaction_id === null || row.original_delegation_issued_valid === null)
  )
    return null;
  const record: DurableInitiatorRecord = {
    operation: { route: row.route, id: row.operation_id, kind: EDITION_PUBLISH, sourceId: row.edition_id },
    initiatorAccountId: row.initiator_account_id,
    actor: {
      kind: 'account',
      accountId: row.initiator_account_id,
      clientId: row.actor_client_id,
      scopes: row.actor_scopes,
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
      commandKind: EDITION_PUBLISH,
      idempotencyKey: row.creation_idempotency_key,
      requestDigest: row.creation_request_digest,
      target: { route: row.route, id: row.edition_id },
    },
  };
  if (
    publicationSourceDigest(edition, operation.id) !== record.sourceDigest ||
    editionDigest([principalCommandIdentity(record.actor), EDITION_PUBLISH, row.edition_id, '1']) !==
      record.creation.requestDigest
  )
    return null;
  const receipt = (
    await client.query<{
      transaction_id: string;
      digest: string;
      commitment: string;
      edition_id: string;
      edition_revision: string;
    }>(
      `SELECT transaction_id, encode(request_digest,'hex') AS digest,
        response->>'durableInitiator' AS commitment, response->>'editionId' AS edition_id,
        response->>'editionRevision' AS edition_revision
      FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
        AND command_kind=$3 AND idempotency_key=ANY($4::text[]) LIMIT 1`,
      [
        partitionOf(row.route),
        row.initiator_account_id,
        EDITION_PUBLISH,
        nativeReceiptKeyCandidates(client, EDITION_PUBLISH, row.initiator_account_id, row.creation_idempotency_key),
      ],
    )
  ).rows[0];
  if (
    !receipt ||
    receipt.transaction_id !== record.recordedTransactionId ||
    receipt.digest !== record.creation.requestDigest ||
    receipt.edition_id !== row.edition_id ||
    receipt.edition_revision !== '2' ||
    receipt.commitment !== durableInitiatorCommitment(record)
  )
    return null;
  return record;
};
