import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import type { WorkClient } from '../work/client.ts';
import {
  currentCommand,
  currentCommandReceipt,
  currentCommandResources,
  type CommandTransaction,
} from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import type { originalAccountIdentitySource } from '../access/agent-verification-identity.ts';
import {
  agentIdentitySourceKey,
  commandAgentIdentitySource,
  type AgentIdentitySourceKey,
} from './agent-identity-source.ts';
import { lockRecordedAgentIdentityHistory } from './agent-identity-sdk-fence.ts';
import {
  reserveIdentityHistoryWork,
  nativeWork,
  addNativeWork,
  identityHistoryConnection,
  IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK,
  unpricedIdentityHistoryWork,
} from './agent-identity-inventory-work.ts';
import { decodeLocator, encodeLocator } from './locator.ts';
import { commandHistoryKind, COMMAND_HISTORY_KINDS } from './record.ts';
import type { HistoryArtifact, HistoryBarrier } from './registry.ts';
import {
  readAgentIdentitySDKRetirementGap,
  currentAgentIdentityHistoryUnit,
  type AgentIdentityRetirementStage,
} from './agent-identity-retirement.ts';
import {
  historyDeadline,
  historyReceivingGap,
  verifyCurrentHistoryReceiving,
  verifyHistoryReceivingReceipt,
  readHistoryReceivingReceipt,
  type HistoryReceivingContext,
  type HistoryReceivingDependencies,
  type HistoryReceivingReceipt,
} from './receiving.ts';

/** First owner declaration: exact original Accounts key and native tuple, never an erasure Source authority.
 * Native receipt/outbox closure and SDK future-writer closure are independent branches. */
export const AGENT_IDENTITY_INVENTORY = Object.freeze({
  producerVersion: 1,
  conversionCoverage: 'native-receipt-outbox/v1',
  maxCopies: 3,
  nativeFutureWriters: 'closed-at-original-commit',
  sdkFutureWriters: 'native-sdk-fence-requires-source-transfer',
} as const);
export type AgentIdentityOriginal = Readonly<{
  key: AgentIdentitySourceKey;
  partition: number;
  epoch: number;
  position: bigint;
  transactionId: string;
  digest: string;
}>;
const inventoryProof: unique symbol = Symbol('Agent identity native inventory');
/** A portable snapshot of durable native custody. Verification always re-reads its native fences and receipts. */
export type AgentIdentityInventoryProof = Readonly<{
  original: AgentIdentityOriginal;
  generation: string;
  domainGeneration: string;
  receiverEpoch: number;
  cutDigest: string;
  artifacts: readonly HistoryArtifact[];
  readonly [inventoryProof]: true;
}>;
export type AgentIdentityNativeInventory =
  | Readonly<{
      state: 'pending';
      gap: 'agent-identity-original-inventory-unsealed';
      proof: null;
    }>
  | Readonly<{
      state: 'sealed';
      gap: null;
      proof: AgentIdentityInventoryProof;
    }>;
export type AgentIdentityInventoryVerification =
  | Readonly<{
      state: 'pending';
      native: 'pending' | 'verified';
      gap: string;
    }>
  | Readonly<{ state: 'verified'; native: 'verified'; gap: null }>;
const recoveryInventoryProof: unique symbol = Symbol('Agent identity recovery native inventory');
export type AgentIdentityRecoveryInventoryProof = Readonly<{
  key: AgentIdentitySourceKey;
  partition: number;
  epoch: number;
  position: bigint;
  transactionId: string;
  digest: string;
  generation: string;
  domainGeneration: string;
  receiverEpoch: number;
  cutDigest: string;
  artifacts: readonly HistoryArtifact[];
  readonly [recoveryInventoryProof]: true;
}>;
export type AgentIdentityRecoveryInventory =
  | Readonly<{
      state: 'absent';
      gap: null;
      native: 'absent';
      proof: null;
      receipts: readonly [];
    }>
  | Readonly<{
      state: 'pending';
      gap: string;
      native: 'pending' | 'sealed';
      proof: null;
      receipts: readonly [];
    }>
  | Readonly<{
      state: 'sealed';
      gap: null;
      native: 'sealed';
      proof: AgentIdentityRecoveryInventoryProof;
      receipts: readonly HistoryReceivingReceipt[];
    }>;
export type AgentIdentityRecoveryInventoryVerification =
  | Readonly<{ state: 'pending'; native: 'pending' | 'verified'; gap: string }>
  | Readonly<{ state: 'verified'; native: 'verified'; gap: null }>;
const unsealed = () =>
  ({
    state: 'pending',
    gap: 'agent-identity-original-inventory-unsealed',
    proof: null,
  }) as const;
const sdkGap = 'agent-identity-sdk-recording-port-unavailable';
type ExpectedSerializerCut = Readonly<{
  locators: readonly Buffer[];
  eventTypes: readonly string[];
}>;
const expected = new WeakMap<CommandTransaction, ExpectedSerializerCut>();
const eventsFor = (kind: string): readonly string[] => {
  if (kind === 'access.agent-verification.pending') return ['com.rezics.access.account-updated.v1'];
  if (
    [
      'access.agent-verification.released',
      'access.agent-verification.revoked',
      'access.agent-verification.deleted',
    ].includes(kind)
  )
    return ['com.rezics.access.agent-verification.reversing.v1', 'com.rezics.access.account-updated.v1'];
  throw new TypeError('Unconverted original identity producer');
};
function params(key: AgentIdentitySourceKey): [number, number, string, string, string] {
  agentIdentitySourceKey(key);
  return [partitionOf(key.route), key.route, key.accountId, key.direction, key.receiptId];
}

/** Only the original native writer issues this binding, before any nested serializer. */
export async function declareAgentIdentityInventory(
  tx: CommandTransaction,
  original: ReturnType<typeof originalAccountIdentitySource>,
  accounts: readonly import('./locator.ts').AccountReference[],
): Promise<void> {
  if (original.writerKind === 'recovery') {
    await declareAgentIdentityRecoveryInventory(tx, original, accounts);
    return;
  }
  // The owner may declare the genuine NEW recovery writer for native copies.
  // It cannot recreate the original command's finite cut or SDK enqueue seam.
  if (original.handoff === null) return;
  const receipt = currentCommandReceipt(tx);
  const inserted = await tx.query(
    `INSERT INTO core.agent_identity_inventory
     (partition_no,source_route,source_account_id,source_direction,source_receipt_id,source_digest,
      source_epoch,source_position,source_transaction_id,producer_version,conversion_coverage,
      receiver_epoch,domain_generation,native_command_kind,native_principal_kind,native_principal_id,native_receipt_key)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,1,'native-receipt-outbox/v1',p.epoch,d.generation,$10,$11,$12,$13
     FROM core.partition p CROSS JOIN core.history_family_domain d
     WHERE p.partition_no=$1 AND p.write_state='active' AND p.epoch=$7 AND d.singleton`,
    [
      ...params(original.key),
      original.digest,
      original.epoch,
      original.position.toString(),
      original.transactionId,
      receipt.kind,
      receipt.principal.kind,
      receipt.principal.id,
      receipt.storageKey,
    ],
  );
  if (inserted.rowCount !== 1) throw new TypeError('Original identity inventory home unavailable');
  await tx.query(
    `INSERT INTO core.agent_identity_sdk_obligation
     (partition_no,source_route,source_account_id,source_direction,source_receipt_id,workflow_id,delivery_key,
      handoff_partition,handoff_epoch,handoff_position,handoff_transaction_id,handoff_event_type)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      ...params(original.key),
      original.workflowId,
      original.deliveryKey,
      original.handoff.partition,
      original.handoff.epoch,
      original.handoff.position,
      original.handoff.transactionId,
      original.handoff.eventType,
    ],
  );
}

/** The later recovery command has its own finite native cut. It contains exactly its real
 * receipt and one account-updated event; it never mutates the original command inventory. */
async function declareAgentIdentityRecoveryInventory(
  tx: CommandTransaction,
  original: ReturnType<typeof originalAccountIdentitySource>,
  accounts: readonly import('./locator.ts').AccountReference[],
): Promise<void> {
  const receipt = currentCommandReceipt(tx);
  const command = currentCommand(tx);
  if (
    original.writerKind !== 'recovery' ||
    receipt.kind !== 'access.agent-identity.recover' ||
    command.transactionId !== original.transactionId ||
    command.partition !== original.partition ||
    original.position < 1n ||
    accounts.length < 1 ||
    accounts.length > 64
  )
    throw new TypeError('Invalid recovery identity native writer');
  const [namespace, version, mac] = receipt.storageKey.split('.');
  const token = Buffer.from(mac ?? '', 'base64url');
  if (namespace !== 'rk1' || !/^(0|[1-9]\d*)$/.test(version ?? '') || Number(version) > 255 || token.length !== 32)
    throw new TypeError('Recovery identity receipt codec unavailable');
  const expectedAccounts = JSON.stringify(
    [...accounts]
      .sort((a, b) => a.accountRoute - b.accountRoute || a.accountId.localeCompare(b.accountId))
      .map(({ accountRoute, accountId, roles }) => [accountRoute, accountId, roles]),
  );
  const inserted = await tx.query(
    `INSERT INTO core.agent_identity_recovery_inventory
     (partition_no,source_route,source_account_id,source_direction,source_receipt_id,source_digest,
      recovery_epoch,recovery_position,recovery_transaction_id,receiver_epoch,domain_generation,
      native_command_kind,native_principal_kind,native_principal_id,native_receipt_key,native_request_digest,
      expected_accounts,state)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,p.epoch,d.generation,$10,$11,$12,$13,r.request_digest,$14,'declared'
     FROM core.partition p CROSS JOIN core.history_family_domain d
     JOIN access.agent_identity_recovery a ON a.route=$2 AND a.account_id=$3
       AND a.direction=$4 AND a.receipt_id=$5 AND a.intent_digest=$6
       AND a.source_partition=$1 AND a.recovery_epoch=$7 AND a.recovery_position=$8
       AND a.recovery_transaction_id=$9 AND a.xmin::text=pg_current_xact_id()::text
     JOIN core.receipt r ON r.partition_no=$1 AND r.principal_kind=$11 AND r.principal_id=$12
       AND r.command_kind=$10 AND r.idempotency_key=$13 AND r.transaction_id=$9
       AND r.epoch=$7 AND r.position=$8 AND r.payload_state='present'
       AND r.xmin::text=pg_current_xact_id()::text
     WHERE p.partition_no=$1 AND p.write_state='active' AND p.epoch=$7 AND p.position=$8-1 AND d.singleton`,
    [
      ...params(original.key),
      original.digest,
      original.epoch,
      original.position.toString(),
      original.transactionId,
      receipt.kind,
      receipt.principal.kind,
      receipt.principal.id,
      receipt.storageKey,
      expectedAccounts,
    ],
  );
  if (inserted.rowCount !== 1) throw new TypeError('Recovery identity inventory home unavailable');
}

/** Executor calls before JSON.stringify of any event data or response. Types and slots are copied
 * synchronously; getters/toJSON cannot reduce the expected work while serialization is running. */
export function captureAgentIdentityInventory(
  tx: CommandTransaction,
  kind: string | undefined,
  events: readonly { type: string }[],
): void {
  const declaration = commandAgentIdentitySource(tx);
  if (!declaration || (declaration.original.writerKind === 'original' && declaration.original.handoff === null)) return;
  if (expected.has(tx) || declaration.kind !== kind) throw new TypeError('Repeated identity serializer obligations');
  const types =
    declaration.original.writerKind === 'recovery' ? ['com.rezics.access.account-updated.v1'] : eventsFor(kind!);
  if (types.length !== events.length || events.some((event, index) => event.type !== types[index]))
    throw new TypeError('Unconverted identity serializer obligations');
  const receipt = currentCommandReceipt(tx);
  const [namespace, version, mac] = receipt.storageKey.split('.');
  const commandKindId = COMMAND_HISTORY_KINDS[kind as keyof typeof COMMAND_HISTORY_KINDS];
  if (namespace !== 'rk1' || !commandKindId) throw new TypeError('Original native identity receipt unavailable');
  expected.set(
    tx,
    Object.freeze({
      locators: Object.freeze([
        Buffer.from(
          encodeLocator({
            artifactType: 'command-receipt/v1',
            partitionNo: declaration.original.partition,
            principalKind: receipt.principal.kind,
            principalId: receipt.principal.id,
            commandKindId,
            keyVersion: Number(version),
            keyToken: Buffer.from(mac!, 'base64url').toString('hex'),
          }),
        ),
        ...types.map((_, eventSeq) =>
          Buffer.from(
            encodeLocator({
              artifactType: 'outbox-event/v1',
              partitionNo: declaration.original.partition,
              position: declaration.original.position,
              eventSeq,
            }),
          ),
        ),
      ]),
      eventTypes: Object.freeze([...types]),
    }),
  );
}

/** After EVERY actual serializer hook and final physical fence, still in the original transaction.
 * Durable validation matches each expected slot to its genuine association and physical row. */
export async function finalizeAgentIdentityInventory(tx: CommandTransaction, position: bigint): Promise<void> {
  const declaration = commandAgentIdentitySource(tx);
  if (!declaration || (declaration.original.writerKind === 'original' && declaration.original.handoff === null)) return;
  const cut = expected.get(tx);
  if (!cut || position !== declaration.original.position)
    throw new TypeError('Identity serializer obligations incomplete');
  if (declaration.original.writerKind === 'recovery') {
    const updated = await tx.query(
      `UPDATE core.agent_identity_recovery_inventory SET expected_locators=$6,expected_event_types=$7,
         native_writer_state='closed',state='sealed'
       WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3 AND source_direction=$4
         AND source_receipt_id=$5 AND state='declared' AND xmin::text=pg_current_xact_id()::text`,
      [...params(declaration.original.key), cut.locators, cut.eventTypes],
    );
    if (updated.rowCount !== 1) throw new TypeError('Recovery identity native inventory did not seal');
    return;
  }
  const updated = await tx.query(
    `UPDATE core.agent_identity_inventory SET expected_locators=$6,expected_event_types=$7,state='sealed'
     WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3 AND source_direction=$4
       AND source_receipt_id=$5 AND state='declared' AND xmin::text=pg_current_xact_id()::text`,
    [...params(declaration.original.key), cut.locators, cut.eventTypes],
  );
  if (updated.rowCount !== 1) throw new TypeError('Original identity native inventory did not seal');
}
export function releaseAgentIdentityInventory(tx: CommandTransaction): void {
  expected.delete(tx);
}

function roleDigest(artifact: HistoryArtifact): Buffer {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...artifact.accounts]
          .sort((a, b) => a.accountRoute - b.accountRoute || a.accountId.localeCompare(b.accountId))
          .map(({ accountRoute, accountId, roles }) => [accountRoute, accountId, roles]),
      ),
    )
    .digest();
}
function cutDigest(original: AgentIdentityOriginal, artifacts: readonly HistoryArtifact[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        agentIdentitySourceKey(original.key),
        original.partition,
        original.epoch,
        original.position.toString(),
        original.transactionId,
        original.digest,
        artifacts.map((artifact) => [
          Buffer.from(encodeLocator(artifact.locator)).toString('hex'),
          roleDigest(artifact).toString('hex'),
        ]),
      ]),
    )
    .digest('hex');
}

/** At most three exact original associations and 64 roles each; no historical scans, inferred
 * empty sources, transaction-wide attachments, JSON source parsing or caller conversion flag. */
export async function readAgentIdentityInventoryInTransaction(
  tx: CommandTransaction,
  key: AgentIdentitySourceKey,
): Promise<AgentIdentityNativeInventory> {
  const row = (
    await tx.query(
      `SELECT i.*,p.epoch AS current_epoch,d.generation AS current_domain
     FROM core.agent_identity_inventory i
     JOIN core.partition p ON p.partition_no=i.partition_no AND p.write_state='active'
     CROSS JOIN core.history_family_domain d
     WHERE i.partition_no=$1 AND i.source_route=$2 AND i.source_account_id=$3 AND i.source_direction=$4
       AND i.source_receipt_id=$5 AND d.singleton FOR SHARE OF i,p,d`,
      params(key),
    )
  ).rows[0];
  if (
    !row ||
    row.state !== 'sealed' ||
    row.producer_version !== 1 ||
    row.conversion_coverage !== AGENT_IDENTITY_INVENTORY.conversionCoverage ||
    row.native_writer_state !== 'closed' ||
    row.source_epoch !== row.current_epoch ||
    row.receiver_epoch !== row.current_epoch ||
    String(row.domain_generation) !== String(row.current_domain)
  )
    return unsealed();
  const locators: Buffer[] = row.expected_locators;
  if (!locators || locators.length < 2 || locators.length > AGENT_IDENTITY_INVENTORY.maxCopies) return unsealed();
  const copies = (
    await tx.query(
      `SELECT artifact_type,locator,source_digest,source_epoch,source_position,source_transaction_id,
       receiver_epoch,domain_generation FROM core.agent_identity_history_copy
     WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3 AND source_direction=$4 AND source_receipt_id=$5
     ORDER BY artifact_type,locator LIMIT 4 FOR SHARE`,
      params(key),
    )
  ).rows;
  if (
    copies.length !== locators.length ||
    copies.some(
      (copy) =>
        !locators.some((locator) => Buffer.from(locator).equals(copy.locator)) ||
        copy.source_digest !== row.source_digest ||
        copy.source_epoch !== row.source_epoch ||
        String(copy.source_position) !== String(row.source_position) ||
        copy.source_transaction_id !== row.source_transaction_id ||
        copy.receiver_epoch !== row.receiver_epoch ||
        String(copy.domain_generation) !== String(row.domain_generation),
    )
  )
    return unsealed();
  const artifacts: HistoryArtifact[] = [];
  // Source order is the expected serializer order, independent of page order and row count.
  for (const encoded of locators) {
    const copy = copies.find((copy) => Buffer.from(encoded).equals(copy.locator))!;
    const roles = (
      await tx.query(
        `SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
       WHERE partition_no=$1 AND artifact_type=$2 AND locator=$3 ORDER BY account_route,account_id LIMIT 65 FOR SHARE`,
        [row.partition_no, copy.artifact_type, encoded],
      )
    ).rows;
    if (!roles.length || roles.length > 64 || roles.some((role) => role.minimizer_version !== 1)) return unsealed();
    artifacts.push({
      partition: row.partition_no,
      locator: decodeLocator(copy.artifact_type, encoded),
      accounts: roles.map((role) => ({
        accountRoute: role.account_route,
        accountId: role.account_id,
        roles: role.roles,
      })),
    });
  }
  const original: AgentIdentityOriginal = {
    key: { ...key },
    partition: row.partition_no,
    epoch: row.source_epoch,
    position: BigInt(row.source_position),
    transactionId: row.source_transaction_id,
    digest: row.source_digest,
  };
  return {
    state: 'sealed',
    gap: null,
    proof: Object.freeze({
      original,
      generation: String(row.generation),
      domainGeneration: String(row.domain_generation),
      receiverEpoch: row.receiver_epoch,
      cutDigest: cutDigest(original, artifacts),
      artifacts,
      [inventoryProof]: true as const,
    }),
  };
}

function recoveryAccountManifest(accounts: readonly import('./locator.ts').AccountReference[]): string {
  return JSON.stringify(
    [...accounts]
      .sort((a, b) => a.accountRoute - b.accountRoute || a.accountId.localeCompare(b.accountId))
      .map(({ accountRoute, accountId, roles }) => [accountRoute, accountId, roles]),
  );
}

function recoveryCutDigest(proof: Omit<AgentIdentityRecoveryInventoryProof, typeof recoveryInventoryProof>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        agentIdentitySourceKey(proof.key),
        proof.partition,
        proof.epoch,
        proof.position.toString(),
        proof.transactionId,
        proof.digest,
        proof.generation,
        proof.domainGeneration,
        proof.receiverEpoch,
        proof.artifacts.map((artifact) => [
          Buffer.from(encodeLocator(artifact.locator)).toString('hex'),
          roleDigest(artifact).toString('hex'),
        ]),
      ]),
    )
    .digest('hex');
}

/** Exact native cut for the NEW recovery command only. The original finite cut and SDK seam
 * remain independent, including for a source whose original cut was lost. */
export async function readAgentIdentityRecoveryInventoryInTransaction(
  tx: CommandTransaction,
  key: AgentIdentitySourceKey,
): Promise<AgentIdentityRecoveryInventory> {
  const pending = (gap: string, native: 'pending' | 'sealed' = 'pending'): AgentIdentityRecoveryInventory => ({
    state: 'pending',
    gap,
    native,
    proof: null,
    receipts: [],
  });
  const row = (
    await tx.query<{
      partition_no: number;
      source_digest: string;
      recovery_epoch: number;
      recovery_position: string;
      recovery_transaction_id: string;
      receiver_epoch: number;
      domain_generation: string;
      generation: string;
      state: string;
      producer_version: number;
      conversion_coverage: string;
      native_writer_state: string;
      native_command_kind: string;
      native_principal_kind: 'account' | 'anonymous';
      native_principal_id: string;
      native_receipt_key: string;
      native_request_digest: Buffer;
      expected_accounts: unknown;
      expected_locators: Buffer[];
      expected_event_types: string[];
      current_epoch: number;
      current_domain: string;
      current_request_digest: Buffer;
    }>(
      `SELECT i.*,p.epoch AS current_epoch,d.generation AS current_domain,r.request_digest AS current_request_digest
       FROM core.agent_identity_recovery_inventory i
       JOIN core.partition p ON p.partition_no=i.partition_no AND p.write_state='active'
       JOIN core.history_family_domain d ON d.singleton
       JOIN access.agent_identity_recovery a ON a.route=i.source_route AND a.account_id=i.source_account_id
         AND a.direction=i.source_direction AND a.receipt_id=i.source_receipt_id
         AND a.source_partition=i.partition_no AND a.intent_digest=i.source_digest
         AND a.recovery_epoch=i.recovery_epoch AND a.recovery_position=i.recovery_position
         AND a.recovery_transaction_id=i.recovery_transaction_id
         AND a.recovery_receipt_key=i.native_receipt_key
       JOIN core.receipt r ON r.partition_no=i.partition_no AND r.principal_kind=i.native_principal_kind
         AND r.principal_id=i.native_principal_id AND r.command_kind=i.native_command_kind
         AND r.idempotency_key=i.native_receipt_key AND r.transaction_id=i.recovery_transaction_id
         AND r.epoch=i.recovery_epoch AND r.position=i.recovery_position
         AND r.payload_state IN ('present','minimized') AND r.response='null'::jsonb
         AND r.request_digest=i.native_request_digest
       WHERE i.partition_no=$1 AND i.source_route=$2 AND i.source_account_id=$3
         AND i.source_direction=$4 AND i.source_receipt_id=$5 FOR SHARE OF i,p,d,a,r`,
      params(key),
    )
  ).rows[0];
  if (!row) {
    const recovery = (
      await tx.query(
        `SELECT 1 FROM access.agent_identity_recovery
         WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4 FOR SHARE`,
        [key.route, key.accountId, key.direction, key.receiptId],
      )
    ).rows[0];
    return recovery
      ? pending('agent-identity-recovery-inventory-unsealed')
      : { state: 'absent', gap: null, native: 'absent', proof: null, receipts: [] };
  }
  if (
    row.state !== 'sealed' ||
    row.producer_version !== 1 ||
    row.conversion_coverage !== 'native-receipt-outbox/v1' ||
    row.native_writer_state !== 'closed' ||
    row.receiver_epoch !== row.current_epoch ||
    String(row.domain_generation) !== String(row.current_domain) ||
    !/^[0-9a-f]{64}$/.test(row.source_digest) ||
    !Buffer.from(row.native_request_digest).equals(Buffer.from(row.current_request_digest))
  )
    return pending('agent-identity-recovery-inventory-unsealed');
  const expectedLocators = row.expected_locators;
  const eventTypes = row.expected_event_types;
  if (
    !expectedLocators ||
    expectedLocators.length !== 2 ||
    !eventTypes ||
    eventTypes.length !== 1 ||
    eventTypes[0] !== 'com.rezics.access.account-updated.v1' ||
    !Array.isArray(row.expected_accounts) ||
    row.expected_accounts.length < 1 ||
    row.expected_accounts.length > 64
  )
    return pending('agent-identity-recovery-inventory-unsealed');
  const copies = (
    await tx.query<{
      artifact_type: 'command-receipt/v1' | 'outbox-event/v1';
      locator: Buffer;
      source_digest: string;
      source_epoch: number;
      source_position: string;
      source_transaction_id: string;
      receiver_epoch: number;
      domain_generation: string;
    }>(
      `SELECT artifact_type,locator,source_digest,source_epoch,source_position::text,source_transaction_id,
         receiver_epoch,domain_generation
       FROM core.agent_identity_history_copy
       WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3 AND source_direction=$4
         AND source_receipt_id=$5 AND source_epoch=$6 AND source_position=$7 AND source_transaction_id=$8
       ORDER BY artifact_type,locator LIMIT 3 FOR SHARE`,
      [...params(key), row.recovery_epoch, row.recovery_position, row.recovery_transaction_id],
    )
  ).rows;
  if (
    copies.length !== 2 ||
    copies.some(
      (copy) =>
        !expectedLocators.some((locator) => Buffer.from(locator).equals(copy.locator)) ||
        copy.source_digest !== row.source_digest ||
        copy.source_epoch !== row.recovery_epoch ||
        String(copy.source_position) !== String(row.recovery_position) ||
        copy.source_transaction_id !== row.recovery_transaction_id ||
        copy.receiver_epoch !== row.receiver_epoch ||
        String(copy.domain_generation) !== String(row.domain_generation),
    )
  )
    return pending('agent-identity-recovery-copy-cut-incomplete');
  const artifacts: HistoryArtifact[] = [];
  for (const encoded of expectedLocators) {
    const copy = copies.find((candidate) => Buffer.from(encoded).equals(candidate.locator));
    if (!copy) return pending('agent-identity-recovery-copy-cut-incomplete');
    const refs = (
      await tx.query<{
        account_route: number;
        account_id: string;
        roles: number;
        minimizer_version: number;
      }>(
        `SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
         WHERE partition_no=$1 AND artifact_type=$2 AND locator=$3
         ORDER BY account_route,account_id LIMIT 65 FOR SHARE`,
        [row.partition_no, copy.artifact_type, encoded],
      )
    ).rows;
    if (
      !refs.length ||
      refs.length > 64 ||
      refs.some((ref) => ref.minimizer_version !== 1) ||
      recoveryAccountManifest(
        refs.map((ref) => ({ accountRoute: ref.account_route, accountId: ref.account_id, roles: ref.roles })),
      ) !== JSON.stringify(row.expected_accounts)
    )
      return pending('agent-identity-recovery-role-union-changed');
    const locator = decodeLocator(copy.artifact_type, encoded);
    if (copy.artifact_type === 'command-receipt/v1') {
      const receipt = (
        await tx.query(
          `SELECT 1 FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3
           AND command_kind=$4 AND idempotency_key=$5 AND transaction_id=$6 AND epoch=$7 AND position=$8
           AND request_digest=$9 AND response='null'::jsonb AND payload_state IN ('present','minimized') FOR SHARE`,
          [
            row.partition_no,
            row.native_principal_kind,
            row.native_principal_id,
            row.native_command_kind,
            row.native_receipt_key,
            row.recovery_transaction_id,
            row.recovery_epoch,
            row.recovery_position,
            row.native_request_digest,
          ],
        )
      ).rows[0];
      if (!receipt) return pending('agent-identity-recovery-receipt-changed');
    } else {
      const event = (
        await tx.query(
          `SELECT 1 FROM core.outbox WHERE partition_no=$1 AND epoch=$2 AND position=$3 AND event_seq=0
           AND event_count=1 AND type=$4 AND payload_state IN ('present','minimized')
           AND ((payload_state='present' AND subject=$5 AND data=jsonb_build_object('accountId',$5::text)) OR
                (payload_state='minimized' AND subject IS NULL AND data='{}'::jsonb)) FOR SHARE`,
          [
            row.partition_no,
            row.recovery_epoch,
            row.recovery_position,
            'com.rezics.access.account-updated.v1',
            key.accountId,
          ],
        )
      ).rows[0];
      if (!event) return pending('agent-identity-recovery-event-changed');
    }
    artifacts.push({
      partition: row.partition_no,
      locator,
      accounts: refs.map((ref) => ({
        accountRoute: ref.account_route,
        accountId: ref.account_id,
        roles: ref.roles,
      })),
    });
  }
  if (
    !artifacts.some((artifact) => artifact.locator.artifactType === 'command-receipt/v1') ||
    !artifacts.some((artifact) => artifact.locator.artifactType === 'outbox-event/v1')
  )
    return pending('agent-identity-recovery-copy-cut-incomplete');
  const unsigned = {
    key: { ...key },
    partition: row.partition_no,
    epoch: row.recovery_epoch,
    position: BigInt(row.recovery_position),
    transactionId: row.recovery_transaction_id,
    digest: row.source_digest,
    generation: String(row.generation),
    domainGeneration: String(row.domain_generation),
    receiverEpoch: row.receiver_epoch,
    cutDigest: '',
    artifacts: Object.freeze(artifacts),
  };
  const proof = Object.freeze({
    ...unsigned,
    cutDigest: recoveryCutDigest(unsigned),
    [recoveryInventoryProof]: true as const,
  });
  return {
    state: 'sealed',
    gap: null,
    native: 'sealed',
    proof,
    receipts: [],
  };
}

export type AgentIdentityRecoveryArtifactInspection =
  | Readonly<{ state: 'absent'; gap: null; proof: null }>
  | Readonly<{ state: 'pending'; gap: string; proof: null }>
  | Readonly<{
      state: 'sealed';
      gap: null;
      proof: AgentIdentityRecoveryInventoryProof;
      artifact: HistoryArtifact;
      recoveryEvent: HistoryArtifact;
    }>;

/** Resolve one artifact-leading recovery association and re-read its exact two-slot cut.
 * No source JSON, account-prefix, or history population scan participates. */
export async function readAgentIdentityRecoveryArtifactInTransaction(
  tx: CommandTransaction,
  artifact: HistoryArtifact,
  pool?: Pool,
): Promise<AgentIdentityRecoveryArtifactInspection> {
  const absent: AgentIdentityRecoveryArtifactInspection = { state: 'absent', gap: null, proof: null };
  const pending = (gap: string): AgentIdentityRecoveryArtifactInspection => ({ state: 'pending', gap, proof: null });
  if (artifact.locator.artifactType === 'durable-work/v1' || artifact.partition !== artifact.locator.partitionNo)
    return absent;
  const resources = currentCommandResources(tx);
  if (pool && pool !== resources.pool) throw new TypeError('Recovery artifact pool differs from its command');
  await reserveIdentityHistoryWork(resources.pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.recoveryAssociation, {
    deadline: resources.deadline,
  });
  const matches = (
    await tx.query<{
      source_route: number;
      source_account_id: string;
      source_direction: AgentIdentitySourceKey['direction'];
      source_receipt_id: string;
    }>(
      `SELECT i.source_route,i.source_account_id,i.source_direction,i.source_receipt_id
       FROM core.agent_identity_recovery_inventory i
       JOIN core.agent_identity_history_copy c ON c.partition_no=i.partition_no
         AND c.source_route=i.source_route AND c.source_account_id=i.source_account_id
         AND c.source_direction=i.source_direction AND c.source_receipt_id=i.source_receipt_id
         AND c.source_digest=i.source_digest AND c.source_epoch=i.recovery_epoch
         AND c.source_position=i.recovery_position AND c.source_transaction_id=i.recovery_transaction_id
         AND c.receiver_epoch=i.receiver_epoch AND c.domain_generation=i.domain_generation
         AND c.artifact_type=$2 AND c.locator=$3 AND c.locator=ANY(i.expected_locators)
       AND EXISTS (SELECT 1 FROM access.agent_identity_recovery a WHERE a.route=i.source_route
         AND a.account_id=i.source_account_id AND a.direction=i.source_direction AND a.receipt_id=i.source_receipt_id
         AND a.source_partition=i.partition_no AND a.intent_digest=i.source_digest
         AND a.recovery_epoch=i.recovery_epoch AND a.recovery_position=i.recovery_position
         AND a.recovery_transaction_id=i.recovery_transaction_id AND a.recovery_receipt_key=i.native_receipt_key)
       WHERE i.partition_no=$1 ORDER BY i.source_route,i.source_account_id,i.source_direction,i.source_receipt_id
       LIMIT 2 FOR SHARE OF i,c`,
      [artifact.partition, artifact.locator.artifactType, Buffer.from(encodeLocator(artifact.locator))],
    )
  ).rows;
  if (!matches.length) return absent;
  if (matches.length !== 1) return pending('agent-identity-recovery-copy-fanout-unavailable');
  await reserveIdentityHistoryWork(resources.pool, AGENT_IDENTITY_RECOVERY_INVENTORY_READ_COST, {
    deadline: resources.deadline,
  });
  const key: AgentIdentitySourceKey = {
    route: matches[0]!.source_route,
    accountId: matches[0]!.source_account_id,
    direction: matches[0]!.source_direction,
    receiptId: matches[0]!.source_receipt_id,
  };
  const current = await readAgentIdentityRecoveryInventoryInTransaction(tx, key);
  if (current.state !== 'sealed') return pending(current.gap ?? 'agent-identity-recovery-inventory-unsealed');
  const exact = current.proof.artifacts.find(
    (candidate) =>
      candidate.partition === artifact.partition &&
      candidate.locator.artifactType === artifact.locator.artifactType &&
      Buffer.from(encodeLocator(candidate.locator)).equals(Buffer.from(encodeLocator(artifact.locator))),
  );
  if (!exact) return pending('agent-identity-recovery-artifact-scope-changed');
  const recoveryEvent = current.proof.artifacts.find(
    (candidate) => candidate.locator.artifactType === 'outbox-event/v1',
  );
  if (!recoveryEvent) return pending('agent-identity-recovery-copy-cut-incomplete');
  return {
    state: 'sealed',
    gap: null,
    proof: current.proof,
    artifact: exact,
    recoveryEvent,
  };
}

// The in-transaction cut and released snapshot are separate reached declarations.
// BEGIN, timeout setting, COMMIT and failure ROLLBACK add four statements, one
// returned setting row and its 128-byte bound before the snapshot's checkout.
export const AGENT_IDENTITY_RECOVERY_INVENTORY_READ_COST = nativeWork(135, 135, 6, 32768);
export const AGENT_IDENTITY_RECOVERY_INVENTORY_SNAPSHOT_COST = addNativeWork(
  AGENT_IDENTITY_RECOVERY_INVENTORY_READ_COST,
  nativeWork(1, 0, 4, 128),
);

/** Released exact recovery cut plus the ordinary History receiving API; no SDK mapping is read. */
export async function readAgentIdentityRecoveryInventory(
  deps: HistoryReceivingDependencies,
  barrier: HistoryBarrier,
  key: AgentIdentitySourceKey,
  context: HistoryReceivingContext,
): Promise<AgentIdentityRecoveryInventory> {
  const fixedBarrier = Object.freeze({ ...barrier });
  const fixedKey = structuredClone(key);
  const partition = params(fixedKey)[0];
  historyDeadline(context, partition);
  await reserveIdentityHistoryWork(deps.pool, AGENT_IDENTITY_RECOVERY_INVENTORY_SNAPSHOT_COST, context);
  const inventory = await withConnection(deps.pool, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [
        `${Math.max(1, context.deadline - Date.now())}ms`,
      ]);
      const result = await readAgentIdentityRecoveryInventoryInTransaction(tx, fixedKey);
      historyDeadline(context, partition);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
  if (inventory.state !== 'sealed') return inventory;
  const receipts: HistoryReceivingReceipt[] = [];
  for (const artifact of inventory.proof.artifacts) {
    const receipt = await readHistoryReceivingReceipt(deps, fixedBarrier, artifact, context);
    if (!receipt)
      return {
        state: 'pending',
        gap: `agent-identity-recovery-receiving-pending:${artifact.locator.artifactType}`,
        native: 'sealed',
        proof: null,
        receipts: [],
      };
    receipts.push(receipt);
  }
  return { ...inventory, receipts: Object.freeze(receipts) };
}

/** Same source-home final command: recheck the recovery discriminator and every real receiver receipt. */
export async function verifyAgentIdentityRecoveryInventory(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  key: AgentIdentitySourceKey,
  proof: AgentIdentityRecoveryInventoryProof,
  receipts: readonly HistoryReceivingReceipt[],
): Promise<AgentIdentityRecoveryInventoryVerification> {
  const pending = (gap: string): AgentIdentityRecoveryInventoryVerification => ({
    state: 'pending',
    native: 'pending',
    gap,
  });
  if (currentCommand(tx).partition !== params(key)[0])
    throw new TypeError('Recovery inventory requires its SAME source home');
  if (!proof || proof[recoveryInventoryProof] !== true || receipts.length !== 2)
    return pending('agent-identity-recovery-native-cut-stale');
  const { pool, deadline } = currentCommandResources(tx);
  await reserveIdentityHistoryWork(
    pool,
    unpricedIdentityHistoryWork('recovery-final-native-receiving-composition', nativeWork(275, 275, 18, 49152)),
    { deadline },
  );
  const current = await readAgentIdentityRecoveryInventoryInTransaction(tx, key);
  if (
    current.state !== 'sealed' ||
    current.proof.cutDigest !== proof.cutDigest ||
    recoveryCutDigest(proof) !== proof.cutDigest ||
    current.proof.generation !== proof.generation ||
    current.proof.domainGeneration !== proof.domainGeneration ||
    current.proof.receiverEpoch !== proof.receiverEpoch
  )
    return pending('agent-identity-recovery-native-cut-stale');
  if (partitionOf(barrier.accountRoute) !== proof.partition)
    return pending('agent-identity-recovery-source-barrier-home-unavailable');
  for (let index = 0; index < proof.artifacts.length; index++) {
    if (!(await verifyHistoryReceivingReceipt(tx, barrier, current.proof.artifacts[index]!, receipts[index]!)))
      return pending(`agent-identity-recovery-receiving-pending:${proof.artifacts[index]!.locator.artifactType}`);
  }
  return { state: 'verified', native: 'verified', gap: null };
}

export async function readAgentIdentityNativeInventory(
  pool: Pool,
  key: AgentIdentitySourceKey,
  context: HistoryReceivingContext,
): Promise<AgentIdentityNativeInventory> {
  const fixed = structuredClone(key);
  const partition = params(fixed)[0];
  historyDeadline(context, partition);
  await reserveIdentityHistoryWork(
    pool,
    addNativeWork(IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativeInventory, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.snapshot),
    context,
  );
  return identityHistoryConnection(pool, context, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [
        `${Math.max(1, context.deadline - Date.now())}ms`,
      ]);
      const result = await readAgentIdentityInventoryInTransaction(tx, fixed);
      historyDeadline(context, partition);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
}

/** Every foreign receiving probe runs AFTER releasing the read home. A missing receipt is
 * precise pending. Native seal never asserts SDK enrollment, Account root or Semantic custody. */
export async function readAgentIdentityInventory(
  deps: HistoryReceivingDependencies & Readonly<{ client?: WorkClient }>,
  barrier: HistoryBarrier,
  key: AgentIdentitySourceKey,
  context: HistoryReceivingContext,
) {
  const fixedBarrier = Object.freeze({ ...barrier });
  const fixedKey = structuredClone(key);
  const inventory = await readAgentIdentityNativeInventory(deps.pool, fixedKey, context);
  if (inventory.state !== 'sealed') return inventory;
  for (const artifact of inventory.proof.artifacts) {
    if (!(await readHistoryReceivingReceipt(deps, fixedBarrier, artifact, context)))
      return {
        ...inventory,
        state: 'pending' as const,
        native: 'sealed' as const,
        gap: `agent-identity-receiving-pending:${artifact.locator.artifactType}`,
      };
  }
  const gap = await readAgentIdentitySDKRetirementGap(
    deps.pool,
    {
      kind: fixedKey.direction,
      account: fixedKey.accountId,
      receipt: fixedKey.receiptId,
    },
    context,
    deps.client
      ? {
          client: deps.client,
          original: inventory.proof.original,
          barrier: fixedBarrier,
        }
      : undefined,
  );
  // A released observation never grants later source-home cleanup authority.
  if (gap === null)
    return {
      ...inventory,
      state: 'received' as const,
      native: 'verified' as const,
      gap: null,
    };
  return {
    ...inventory,
    state: 'pending' as const,
    native: 'sealed' as const,
    gap,
  };
}

/** SAME source-home command. All queries address local core rows. The portable snapshot is
 * untrusted until current generation, restore/writer seal, full roles, each durable barrier
 * receipt and each physical disposition have been rechecked and locked through COMMIT. */
export async function verifyAgentIdentityInventory(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  key: AgentIdentitySourceKey,
  proof: AgentIdentityInventoryProof,
  sdkStage?: AgentIdentityRetirementStage,
  receiving?: Readonly<{ client: WorkClient; artifact: HistoryArtifact }>,
): Promise<AgentIdentityInventoryVerification> {
  const pending = (gap: string): AgentIdentityInventoryVerification => ({
    state: 'pending',
    native: 'pending',
    gap,
  });
  if (currentCommand(tx).partition !== params(key)[0])
    throw new TypeError('Identity inventory requires its SAME source home');
  const { pool, deadline } = currentCommandResources(tx);
  await reserveIdentityHistoryWork(pool, nativeWork(202, 202, 5, 65536), { deadline });
  const current = await readAgentIdentityInventoryInTransaction(tx, key);
  if (
    current.state !== 'sealed' ||
    !proof ||
    proof.generation !== current.proof.generation ||
    proof.domainGeneration !== current.proof.domainGeneration ||
    proof.receiverEpoch !== current.proof.receiverEpoch ||
    proof.cutDigest !== current.proof.cutDigest ||
    cutDigest(proof.original, proof.artifacts) !== proof.cutDigest
  )
    return pending('agent-identity-native-cut-stale');
  // The caller's source may belong to another retained role. There is no native
  // cross-home barrier courier here; do not read that foreign Account home while held.
  if (partitionOf(barrier.accountRoute) !== current.proof.original.partition)
    return pending('agent-identity-source-barrier-home-unavailable');
  // Receiving rows bind the exact barrier below. Current native barrier revalidation
  // belongs to the optional Source owner stage and its existing funding reservation.
  for (const artifact of current.proof.artifacts) {
    await reserveIdentityHistoryWork(pool, nativeWork(4, 4, 3, 1024), { deadline });
    const locator = artifact.locator;
    const encoded = Buffer.from(encodeLocator(locator));
    const received = (
      await tx.query(
        `SELECT r.role_digest FROM core.history_receiving_proof r
       JOIN core.history_seal s ON s.partition_no=r.partition_no AND s.account_route=r.account_route AND s.account_id=r.account_id
       JOIN core.history_locator l ON l.partition_no=r.partition_no AND l.account_route=r.account_route AND l.account_id=r.account_id
         AND l.artifact_type=r.artifact_type AND l.locator=r.locator
       WHERE r.partition_no=$1 AND r.account_route=$2 AND r.account_id=$3 AND r.artifact_type=$4 AND r.locator=$5
         AND r.barrier_version=$6 AND r.barrier_at=$7 AND r.partition_epoch=$8
         AND s.phase<>'open' AND s.barrier_id=$3 AND l.state='minimized' AND l.proof_barrier=$3 FOR SHARE OF r,s,l`,
        [
          artifact.partition,
          barrier.accountRoute,
          barrier.accountId,
          locator.artifactType,
          encoded,
          barrier.version,
          barrier.at,
          current.proof.receiverEpoch,
        ],
      )
    ).rows[0];
    if (!received || !Buffer.from(received.role_digest).equals(roleDigest(artifact)))
      return pending(`agent-identity-receiving-pending:${locator.artifactType}`);
    let physical;
    if (locator.artifactType === 'command-receipt/v1') {
      physical = await tx.query(
        `SELECT 1 FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4
         AND idempotency_key=$5 AND transaction_id=$6 AND epoch=$7 AND position=$8
         AND payload_state='minimized' AND response='null'::jsonb FOR SHARE`,
        [
          artifact.partition,
          locator.principalKind,
          locator.principalId,
          commandHistoryKind(locator.commandKindId),
          `rk1.${locator.keyVersion}.${Buffer.from(locator.keyToken, 'hex').toString('base64url')}`,
          current.proof.original.transactionId,
          current.proof.original.epoch,
          current.proof.original.position.toString(),
        ],
      );
    } else if (locator.artifactType === 'outbox-event/v1') {
      physical = await tx.query(
        `SELECT 1 FROM core.outbox WHERE partition_no=$1 AND epoch=$2 AND position=$3 AND event_seq=$4
         AND payload_state='minimized' AND data='{}'::jsonb AND subject IS NULL FOR SHARE`,
        [artifact.partition, current.proof.original.epoch, locator.position.toString(), locator.eventSeq],
      );
      const gap = await historyReceivingGap(tx, artifact.partition, locator, barrier, pool);
      if (gap) return pending(gap);
    }
    if (physical?.rows.length !== 1) return pending(`agent-identity-physical-copy-pending:${locator.artifactType}`);
  }
  await reserveIdentityHistoryWork(pool, nativeWork(1, 1, 1, 1024), { deadline });
  const obligation = (
    await tx.query(
      `SELECT generation,future_writer_state FROM core.agent_identity_sdk_obligation
     WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3 AND source_direction=$4 AND source_receipt_id=$5 FOR SHARE`,
      params(key),
    )
  ).rows[0];
  if (!obligation || String(obligation.generation) !== current.proof.generation)
    return pending('agent-identity-sdk-obligation-stale');
  if (sdkStage) {
    const reference = sdkStage.reference;
    if (
      reference.receipt.kind !== key.direction ||
      reference.receipt.account !== key.accountId ||
      reference.receipt.receipt !== key.receiptId ||
      reference.sourceDigest !== current.proof.original.digest ||
      reference.source.partition !== current.proof.original.partition ||
      reference.source.epoch !== current.proof.original.epoch ||
      reference.source.position !== current.proof.original.position ||
      reference.source.transactionId !== current.proof.original.transactionId ||
      reference.barrier.accountId !== barrier.accountId ||
      reference.barrier.accountRoute !== barrier.accountRoute ||
      reference.barrier.version !== barrier.version ||
      reference.barrier.at !== barrier.at
    )
      return pending('agent-identity-sdk-retirement-reference-mismatch');
    const unit = currentAgentIdentityHistoryUnit();
    const client = receiving?.client ?? unit?.client;
    if (!client || !receiving?.artifact) return pending('identity-history-current-unit-unavailable');
    const artifact = receiving.artifact;
    if (
      artifact.partition !== current.proof.original.partition ||
      artifact.locator.artifactType !== 'durable-work/v1' ||
      artifact.locator.workId !== sdkStage.handoff.custodyId
    )
      return pending('identity-sdk-retirement-receiving-binding-changed');
    const held = await lockRecordedAgentIdentityHistory(tx, client, sdkStage, currentCommandResources(tx));
    if (held.state === 'pending') return { state: 'pending', native: 'verified', gap: held.gap };
    // This verifies the actual original durable-work physical row, full immutable
    // role union, later receiving COMMIT, generation-2 guard and eight-table absence.
    const { AGENT_IDENTITY_HISTORY_GUARD_COST, AGENT_IDENTITY_HISTORY_ABSENCE_COST } =
      await import('./agent-identity-sdk-fence.ts');
    const { addNativeWork } = await import('./agent-identity-inventory-work.ts');
    await reserveIdentityHistoryWork(
      pool,
      addNativeWork(
        IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.durableReceiving,
        AGENT_IDENTITY_HISTORY_GUARD_COST,
        AGENT_IDENTITY_HISTORY_ABSENCE_COST,
      ),
    );
    if (!(await verifyCurrentHistoryReceiving(tx, barrier, artifact)))
      return pending('identity-sdk-physical-receiving-pending');
    return { state: 'verified', native: 'verified', gap: null };
  }
  // A discovery/absence/status flag cannot establish native SDK or source transfer custody.
  return { state: 'pending', native: 'verified', gap: sdkGap };
}
