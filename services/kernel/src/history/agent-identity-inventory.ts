import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { currentCommand, currentCommandReceipt, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf } from '../route/route.ts';
import type { originalAccountIdentitySource } from '../access/agent-verification-identity.ts';
import {
  agentIdentitySourceKey,
  commandAgentIdentitySource,
  type AgentIdentitySourceKey,
} from './agent-identity-source.ts';
import { decodeLocator, encodeLocator } from './locator.ts';
import { commandHistoryKind, COMMAND_HISTORY_KINDS } from './record.ts';
import type { HistoryArtifact, HistoryBarrier } from './registry.ts';
import {
  readAgentIdentitySDKRetirementGap,
  verifyAgentIdentityRetirementStage,
  type AgentIdentityRetirementStage,
} from './agent-identity-retirement.ts';
import {
  historyDeadline,
  readHistoryReceivingReceipt,
  type HistoryReceivingContext,
  type HistoryReceivingDependencies,
} from './receiving.ts';

/** First owner declaration: exact original Accounts key and native tuple, never an erasure Source authority.
 * Native receipt/outbox closure and SDK future-writer closure are independent branches. */
export const AGENT_IDENTITY_INVENTORY = Object.freeze({
  producerVersion: 1,
  conversionCoverage: 'native-receipt-outbox/v1',
  maxCopies: 3,
  nativeFutureWriters: 'closed-at-original-commit',
  sdkFutureWriters: 'pending-native-fence',
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
  | Readonly<{ state: 'pending'; gap: 'agent-identity-original-inventory-unsealed'; proof: null }>
  | Readonly<{ state: 'sealed'; gap: null; proof: AgentIdentityInventoryProof }>;
export type AgentIdentityInventoryVerification = Readonly<{
  state: 'pending';
  native: 'pending' | 'verified';
  gap: string;
}>;
const unsealed = () => ({ state: 'pending', gap: 'agent-identity-original-inventory-unsealed', proof: null }) as const;
const sdkGap = 'agent-identity-sdk-recording-port-unavailable';
const expected = new WeakMap<CommandTransaction, readonly Buffer[]>();
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
): Promise<void> {
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

/** Executor calls before JSON.stringify of any event data or response. Types and slots are copied
 * synchronously; getters/toJSON cannot reduce the expected work while serialization is running. */
export function captureAgentIdentityInventory(
  tx: CommandTransaction,
  kind: string | undefined,
  events: readonly { type: string }[],
): void {
  const declaration = commandAgentIdentitySource(tx);
  if (!declaration || declaration.original.handoff === null) return;
  if (expected.has(tx) || declaration.kind !== kind) throw new TypeError('Repeated identity serializer obligations');
  const types = eventsFor(kind!);
  if (types.length !== events.length || events.some((event, index) => event.type !== types[index]))
    throw new TypeError('Unconverted identity serializer obligations');
  const receipt = currentCommandReceipt(tx);
  const [namespace, version, mac] = receipt.storageKey.split('.');
  const commandKindId = COMMAND_HISTORY_KINDS[kind as keyof typeof COMMAND_HISTORY_KINDS];
  if (namespace !== 'rk1' || !commandKindId) throw new TypeError('Original native identity receipt unavailable');
  expected.set(
    tx,
    Object.freeze([
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
  );
}

/** After EVERY actual serializer hook and final physical fence, still in the original transaction.
 * Durable validation matches each expected slot to its genuine association and physical row. */
export async function finalizeAgentIdentityInventory(tx: CommandTransaction, position: bigint): Promise<void> {
  const declaration = commandAgentIdentitySource(tx);
  if (!declaration || declaration.original.handoff === null) return;
  const locators = expected.get(tx);
  if (!locators || position !== declaration.original.position)
    throw new TypeError('Identity serializer obligations incomplete');
  const updated = await tx.query(
    `UPDATE core.agent_identity_inventory SET expected_locators=$6,expected_event_types=$7,state='sealed'
     WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3 AND source_direction=$4
       AND source_receipt_id=$5 AND state='declared' AND xmin::text=pg_current_xact_id()::text`,
    [...params(declaration.original.key), locators, eventsFor(declaration.kind)],
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

export async function readAgentIdentityNativeInventory(
  pool: Pool,
  key: AgentIdentitySourceKey,
  context: HistoryReceivingContext,
): Promise<AgentIdentityNativeInventory> {
  const fixed = structuredClone(key);
  const partition = params(fixed)[0];
  historyDeadline(context, partition);
  return withConnection(pool, async (tx) => {
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
  deps: HistoryReceivingDependencies,
  barrier: HistoryBarrier,
  key: AgentIdentitySourceKey,
  context: HistoryReceivingContext,
) {
  const fixedBarrier = Object.freeze({ ...barrier });
  const inventory = await readAgentIdentityNativeInventory(deps.pool, key, context);
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
    { kind: key.direction, account: key.accountId, receipt: key.receiptId },
    context,
  );
  return { ...inventory, state: 'pending' as const, native: 'sealed' as const, gap };
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
): Promise<AgentIdentityInventoryVerification> {
  const pending = (gap: string): AgentIdentityInventoryVerification => ({ state: 'pending', native: 'pending', gap });
  if (currentCommand(tx).partition !== params(key)[0])
    throw new TypeError('Identity inventory requires its SAME source home');
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
  for (const artifact of current.proof.artifacts) {
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
      // Even a completed dispatch retains its SDK inputs/results until its real owner binds custody.
      const consumer = await tx.query(
        `SELECT consumer FROM core.history_event_consumer WHERE partition_no=$1 AND position=$2 AND event_seq=$3
         ORDER BY consumer LIMIT 1 FOR SHARE`,
        [artifact.partition, locator.position.toString(), locator.eventSeq],
      );
      if (consumer.rows.length) return pending('outbox-receiving-custody-unavailable');
    }
    if (physical?.rows.length !== 1) return pending(`agent-identity-physical-copy-pending:${locator.artifactType}`);
  }
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
      reference.barrier.accountId !== barrier.accountId ||
      reference.barrier.accountRoute !== barrier.accountRoute ||
      reference.barrier.version !== barrier.version ||
      reference.barrier.at !== barrier.at
    )
      return pending('agent-identity-sdk-retirement-reference-mismatch');
    const verified = await verifyAgentIdentityRetirementStage(tx, sdkStage);
    if (verified.state === 'pending') return { state: 'pending', native: 'verified', gap: verified.gap };
    // A portable verified result alone cannot close the inventory: no durable native SDK
    // fence/receiving locator exists in the pinned SDK. All original copies stay required.
  }
  // No discovery/absence/status flag can certify the missing actual SDK native fence.
  return { state: 'pending', native: 'verified', gap: sdkGap };
}
