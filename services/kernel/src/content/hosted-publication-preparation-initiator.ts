import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { DurableInitiatorUnavailableError } from '../access/contract/index.ts';
import type {
  DurableInitiatorRecord,
  DurableInitiatorReader,
  DurableOperationAnchor,
} from '../access/durable-initiator.ts';
import { authoritativeTimeValue } from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import type { AccessClient, AccountActor, Access } from '../request/access.ts';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { CurrentConsentReader } from '../access/auth-consent.ts';
import { createInitiatorRestorer, readNativeAccessTime } from './access-port.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';

export const HOSTED_PREPARATION_OPERATION = 'content.hosted-catalogue.preparation';
export const HOSTED_PREPARATION_START = 'content.hosted-catalogue.preparation.start';

export type HostedPublicationPreparationAuthority = Readonly<{
  restoreInitiator: ReturnType<typeof createInitiatorRestorer>['restoreInitiator'];
}>;

type SourceRow = {
  route: number;
  catalogue_id: string;
  stage_id: string;
  initiator_account_id: string;
  owner_epoch: string;
  source_revision_id: string;
  expected_head_revision_id: string;
  expected_publication_id: string | null;
  mode: 'whole' | 'selection';
  source_kind: 'snapshot' | 'prefix' | 'ordered';
  source_has_descriptor: boolean;
  source_descriptor_revision_id: string | null;
  source_base_revision_id: string;
  source_base_placement_count: string | null;
  source_base_root_count: string | null;
  source_high_water: string;
  source_ordered_generation_id: string | null;
  source_ordered_sequence: string | null;
  expires_at: string;
};

type StoredAuthority = { record: unknown };

function operationOf(row: SourceRow): DurableOperationAnchor {
  return { route: row.route, id: row.stage_id, kind: HOSTED_PREPARATION_OPERATION, sourceId: row.stage_id };
}

function sourceDigest(row: SourceRow, transactionId: string): string {
  const canonical = canonicalize({
    operation: operationOf(row),
    target: { route: row.route, id: row.catalogue_id },
    source: {
      catalogueId: row.catalogue_id,
      stageId: row.stage_id,
      initiatorAccountId: row.initiator_account_id,
      ownerEpoch: row.owner_epoch,
      sourceRevisionId: row.source_revision_id,
      expectedHeadRevisionId: row.expected_head_revision_id,
      expectedPublicationId: row.expected_publication_id,
      mode: row.mode,
      sourceKind: row.source_kind,
      sourceHasDescriptor: row.source_has_descriptor,
      sourceDescriptorRevisionId: row.source_descriptor_revision_id,
      sourceBaseRevisionId: row.source_base_revision_id,
      sourceBasePlacementCount: row.source_base_placement_count,
      sourceBaseRootCount: row.source_base_root_count,
      sourceHighWater: row.source_high_water,
      sourceOrderedGenerationId: row.source_ordered_generation_id,
      sourceOrderedSequence: row.source_ordered_sequence,
      expiresAt: new Date(row.expires_at).toISOString(),
    },
    transactionId,
  });
  if (canonical === undefined) throw new TypeError('Hosted preparation source must be canonical JSON');
  return createHash('sha256').update(canonical).digest('hex');
}

async function sourceRow(client: AccessClient, route: number, catalogueId: string, stageId: string) {
  return (
    await client.query<SourceRow>(
      `SELECT route,catalogue_id,stage_id,initiator_account_id,owner_epoch::text AS owner_epoch,
          source_revision_id,expected_head_revision_id,expected_publication_id,mode,source_kind,
          source_has_descriptor,source_descriptor_revision_id,source_base_revision_id,
          source_base_placement_count::text AS source_base_placement_count,
          source_base_root_count::text AS source_base_root_count,source_high_water::text AS source_high_water,
          source_ordered_generation_id,source_ordered_sequence::text AS source_ordered_sequence,expires_at::text AS expires_at
       FROM content.hosted_publication_staging
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
      [route, catalogueId, stageId],
    )
  ).rows[0];
}

/** Persist only the allowlisted DurableInitiator record beside its native stage. */
export async function writeHostedPublicationPreparationInitiator(
  client: AccessClient,
  input: Readonly<{
    catalogueId: string;
    stageId: string;
    actor: AccountActor;
    transactionId: string;
    idempotencyKey: string;
    requestDigest: Uint8Array;
    capture: Pick<DurableInitiatorRecord, 'originalAccount' | 'originalDelegation'>;
  }>,
): Promise<DurableInitiatorRecord> {
  const route = routeOf(input.catalogueId);
  if (route === null || routeOf(input.stageId) !== route) throw new TypeError('Invalid hosted preparation source');
  const row = await sourceRow(client, route, input.catalogueId, input.stageId);
  if (
    !row ||
    row.route !== route ||
    row.initiator_account_id !== input.actor.accountId ||
    row.owner_epoch !== String(input.actor.authnEpoch)
  )
    throw new TypeError('Hosted preparation source does not match its admitted author');
  const record: DurableInitiatorRecord = {
    operation: operationOf(row),
    initiatorAccountId: input.actor.accountId,
    actor: input.actor,
    recordedTransactionId: input.transactionId,
    sourceDigest: sourceDigest(row, input.transactionId),
    ...input.capture,
    creation: {
      commandKind: HOSTED_PREPARATION_START,
      idempotencyKey: input.idempotencyKey,
      requestDigest: Buffer.from(input.requestDigest).toString('hex'),
      target: { route, id: input.catalogueId },
    },
  };
  await client.query(
    `INSERT INTO content.hosted_publication_preparation_authority (route,catalogue_id,stage_id,record)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (route,catalogue_id,stage_id) DO NOTHING`,
    [route, input.catalogueId, input.stageId, JSON.stringify(record)],
  );
  return record;
}

/** Exact native operation/source/receipt reader consumed by Access restoration. */
export const readHostedPublicationPreparationInitiator: DurableInitiatorReader = async (client, operation, time) => {
  if (
    operation.kind !== HOSTED_PREPARATION_OPERATION ||
    routeOf(operation.id) !== operation.route ||
    operation.sourceId !== operation.id
  )
    return null;
  const authority = (
    await client.query<StoredAuthority>(
      `SELECT record FROM content.hosted_publication_preparation_authority
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
      [operation.route, operation.id, operation.sourceId],
    )
  ).rows[0];
  if (!authority) return null;
  const record = (typeof authority.record === 'string' ? JSON.parse(authority.record) : authority.record) as
    | DurableInitiatorRecord
    | undefined;
  if (!record || record.operation.kind !== HOSTED_PREPARATION_OPERATION) return null;
  const row = await sourceRow(client, operation.route, record.creation.target.id, operation.sourceId);
  if (
    !row ||
    row.initiator_account_id !== record.initiatorAccountId ||
    row.owner_epoch !== String(record.actor.authnEpoch) ||
    Date.parse(row.expires_at) <= Date.parse(authoritativeTimeValue(time)) ||
    record.operation.route !== row.route ||
    record.operation.id !== row.stage_id ||
    record.operation.sourceId !== row.stage_id ||
    record.creation.commandKind !== HOSTED_PREPARATION_START ||
    record.creation.target.route !== row.route ||
    record.creation.target.id !== row.catalogue_id ||
    sourceDigest(row, record.recordedTransactionId) !== record.sourceDigest
  )
    return null;
  const expectedDigest = requestDigest(HOSTED_PREPARATION_START, record.actor, {
    catalogueId: row.catalogue_id,
    input: {
      stageId: row.stage_id,
      expectedRevisionId: row.expected_head_revision_id,
      expectedPublicationId: row.expected_publication_id,
      mode: row.mode,
    },
  });
  if (Buffer.from(expectedDigest).toString('hex') !== record.creation.requestDigest) return null;
  const basis = (
    await client.query(
      `SELECT 1 FROM editorial.write_basis
       WHERE partition_no=$1 AND transaction_id=$2 AND principal_kind='account' AND principal_id=$3
         AND client_id=$4 AND requested_by IS NOT DISTINCT FROM $5 LIMIT 1`,
      [
        partitionOf(operation.route),
        record.recordedTransactionId,
        record.initiatorAccountId,
        record.actor.clientId,
        record.actor.requestedBy,
      ],
    )
  ).rows[0];
  if (!basis) return null;
  const receipt = (
    await client.query<{
      transaction_id: string;
      digest: string;
      commitment: string;
      catalogue_id: string;
      stage_id: string;
    }>(
      `SELECT transaction_id,encode(request_digest,'hex') AS digest,
          response->>'durableInitiator' AS commitment,response->>'catalogueId' AS catalogue_id,
          response->>'stageId' AS stage_id
       FROM core.receipt
       WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
         AND command_kind=$3 AND idempotency_key=ANY($4::text[]) LIMIT 1`,
      [
        partitionOf(operation.route),
        record.initiatorAccountId,
        HOSTED_PREPARATION_START,
        nativeReceiptKeyCandidates(
          client,
          HOSTED_PREPARATION_START,
          record.initiatorAccountId,
          record.creation.idempotencyKey,
        ),
      ],
    )
  ).rows[0];
  const commitment = createHash('sha256').update(canonicalize(record)!).digest('hex');
  if (
    !receipt ||
    receipt.transaction_id !== record.recordedTransactionId ||
    receipt.digest !== record.creation.requestDigest ||
    receipt.catalogue_id !== row.catalogue_id ||
    receipt.stage_id !== row.stage_id ||
    receipt.commitment !== commitment
  )
    return null;
  return record;
};

export async function deleteHostedPublicationPreparationInitiator(
  client: AccessClient,
  catalogueId: string,
  stageId: string,
): Promise<void> {
  const route = routeOf(catalogueId);
  if (route === null || routeOf(stageId) !== route) throw new TypeError('Invalid hosted preparation source');
  await client.query(
    `DELETE FROM content.hosted_publication_preparation_authority
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [route, catalogueId, stageId],
  );
}

/** Load the immutable identity operand for a worker command. The command's own
 * prepare phase restores this actor again at its live attempt time before any
 * authorization evidence can admit the page.
 */
export async function readHostedPublicationPreparationActor(
  input: Readonly<{
    pool: Pool;
    clock: KernelClock;
    deadline: number;
    catalogueId: string;
    stageId: string;
  }>,
): Promise<AccountActor> {
  const route = routeOf(input.catalogueId);
  if (route === null || routeOf(input.stageId) !== route) throw new TypeError('Invalid hosted preparation source');
  const time = await readNativeAccessTime({ pool: input.pool, deadline: input.deadline }, input.clock);
  const record = await withConnection(input.pool, (client) =>
    readHostedPublicationPreparationInitiator(
      client,
      { route, id: input.stageId, sourceId: input.stageId, kind: HOSTED_PREPARATION_OPERATION },
      time,
    ),
  );
  if (!record) throw new DurableInitiatorUnavailableError();
  return record.actor;
}

export function createHostedPublicationPreparationAuthority(input: {
  pool: Pool;
  access: Access;
  readConsent: CurrentConsentReader;
}): HostedPublicationPreparationAuthority {
  const restorer = createInitiatorRestorer({
    pool: input.pool,
    access: input.access,
    readConsent: input.readConsent,
    readOperation: readHostedPublicationPreparationInitiator,
  });
  return Object.freeze({ restoreInitiator: restorer.restoreInitiator });
}
