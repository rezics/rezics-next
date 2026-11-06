import { memoizedValue } from '../../memoized.ts';
import { IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK } from './agent-identity-inventory-work.ts';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { IdentitySourceConsumerMaintenanceWork } from '../../semantic/identity-source-consumer-maintenance.ts';
import {
  currentCommand,
  currentCommandResources,
  hasLiveCommandTransaction,
  noEffect,
  runCommand,
  withSingleCommandAttempt,
  CommandUnavailableError,
  type CommandTransaction,
} from '../../command/command.ts';
import { withConnection } from '../../database/pool.ts';
import { partitionOf, routeOf } from '../../route/route.ts';
import { agentIdentityCopyRetentionGap } from './agent-identity-source.ts';
import { lockNativeFamilyCoverage, type NativeFamilyCoverage } from './family-coverage-state.ts';
import type { AccountErasureSearchObservation } from '../../search/account-erasure-source.ts';
import zoneSource from './zone-consumers.sql';
import { nativePool } from './handles.ts';
import { searchObservationSource } from './handles.ts';
import {
  AGENT_IDENTITY_HISTORY_ABSENCE_COST,
  AGENT_IDENTITY_HISTORY_GUARD_COST,
  addNativeWork,
  assertAgentIdentityHistoryUnit,
  commandHistoryKind,
  currentAgentIdentityHistoryUnit,
  lockAgentIdentityReceivingArtifact,
  lockRecordedAgentIdentityHistory,
  nativeWork,
  reserveIdentityHistoryWork,
  resolveAgentIdentitySDKWork,
  verifyAgentIdentityRecoveryArtifactReadiness,
} from '../application/index.ts';
import {
  ACCOUNT_ROLE_BITS,
  HISTORY_PRODUCER_FAMILIES,
  type HistoryArtifact,
  type HistoryBarrier,
  type HistoryOwnerCoverage,
  type HistoryOwnerCoverageResult,
  type HistoryProducerFamily,
  type HistoryReceivingContext,
  type HistoryReceivingDependencies,
  type HistoryReceivingDiscriminant,
  type HistoryReceivingReceipt,
  ZONE_HISTORY_EVENT_TYPES,
  ZONE_HISTORY_RECEIPT_KINDS,
  type ZoneHistoryCleanupBinding,
  type ZoneHistoryConsumerObservation,
  type ZoneHistoryEventType,
  classifyEvent,
  decodeLocator,
  encodeLocator,
  validateLocator,
  validateScope,
} from '../contract/index.ts';

type ReceiptBinding = Readonly<{
  barrier: HistoryBarrier;
  discriminant: HistoryReceivingDiscriminant;
  partition: number;
  locator: Buffer;
  roleDigest: Buffer;
  epoch: number;
}>;
const receipts = new WeakMap<HistoryReceivingReceipt, ReceiptBinding>();
const coverages = new WeakMap<
  HistoryOwnerCoverage,
  Readonly<{
    barrier: HistoryBarrier;
    family: HistoryProducerFamily;
    native: NativeFamilyCoverage;
  }>
>();

function validateBarrier(barrier: HistoryBarrier): void {
  if (
    routeOf(barrier.accountId) !== barrier.accountRoute ||
    !Number.isSafeInteger(barrier.version) ||
    barrier.version < 1 ||
    typeof barrier.at !== 'string' ||
    !Number.isFinite(Date.parse(barrier.at))
  )
    throw new TypeError('Invalid history barrier');
}
export function historyDeadline(context: HistoryReceivingContext, partition: number): void {
  if (!Number.isFinite(context.deadline) || context.deadline <= Date.now())
    throw new CommandUnavailableError('deadline', partition);
}
export async function lockHistoryBarrier(tx: CommandTransaction, barrier: HistoryBarrier): Promise<boolean> {
  validateBarrier(barrier);
  const row = (
    await tx.query('SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2 FOR SHARE', [
      barrier.accountRoute,
      barrier.accountId,
    ])
  ).rows[0];
  return row?.version === barrier.version && row?.at === barrier.at;
}

function ZONE_RECEIPT_KIND_SET() {
  return memoizedValue(ZONE_RECEIPT_KIND_SET, () => new Set<string>(ZONE_HISTORY_RECEIPT_KINDS));
}
function ZONE_EVENT_TYPE_SET() {
  return memoizedValue(ZONE_EVENT_TYPE_SET, () => new Set<string>(ZONE_HISTORY_EVENT_TYPES));
}

function sameZoneBinding(a: ZoneHistoryCleanupBinding, b: ZoneHistoryCleanupBinding): boolean {
  return (
    a.kind === b.kind &&
    a.accountId === b.accountId &&
    a.accountRoute === b.accountRoute &&
    a.barrierVersion === b.barrierVersion &&
    a.barrierAt === b.barrierAt &&
    a.zoneId === b.zoneId &&
    a.zoneRoute === b.zoneRoute &&
    a.originalHome === b.originalHome &&
    a.originalEpoch === b.originalEpoch &&
    a.ownerId === b.ownerId &&
    a.ownerTransactionId === b.ownerTransactionId &&
    a.zoneRevision === b.zoneRevision &&
    a.lifecycleRevision === b.lifecycleRevision &&
    a.deletionGeneration === b.deletionGeneration &&
    a.protectionRevision === b.protectionRevision
  );
}

function sameDiscriminant(
  a: HistoryReceivingDiscriminant | undefined,
  b: HistoryReceivingDiscriminant | undefined,
): boolean {
  const left = a ?? { kind: 'account-erasure' as const };
  const right = b ?? { kind: 'account-erasure' as const };
  return left.kind === 'account-erasure'
    ? right.kind === 'account-erasure'
    : right.kind === 'zone-cleanup' && sameZoneBinding(left.binding, right.binding);
}

function zoneIdFromSourceKey(sourceKey: string): string | null {
  const value = JSON.parse(sourceKey) as unknown;
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== 'zone' || typeof value[1] !== 'string') return null;
  return routeOf(value[1]) === null ? null : value[1];
}

/** Reads one exact Zone command's native consumer and receiving custody. A terminal owner
 * copy requires Semantic's explicit branch binding; actor/provenance copies can close under
 * the account barrier when the Zone belongs to another live owner. This returns an in-transaction
 * observation only and creates no acknowledgement or durable receipt. */
export async function observeZoneHistoryConsumerClosure(
  tx: CommandTransaction,
  artifact: HistoryArtifact,
  barrier: HistoryBarrier,
  binding?: ZoneHistoryCleanupBinding,
): Promise<ZoneHistoryConsumerObservation> {
  const pending = (gap: string): ZoneHistoryConsumerObservation => ({ state: 'pending', gap });
  if (!hasLiveCommandTransaction(tx) || currentCommand(tx).partition !== artifact.partition)
    return pending('zone-history-native-home-unavailable');
  if (artifact.locator.artifactType === 'durable-work/v1')
    return pending('zone-history-durable-work-inventory-unavailable');

  const own = artifact.accounts.find(
    (account) => account.accountId === barrier.accountId && account.accountRoute === barrier.accountRoute,
  );
  const ownerRole = own !== undefined && (own.roles & ACCOUNT_ROLE_BITS.owner) !== 0;
  if (binding) {
    if (
      binding.accountId !== barrier.accountId ||
      binding.accountRoute !== barrier.accountRoute ||
      binding.barrierVersion !== barrier.version ||
      binding.barrierAt !== barrier.at ||
      binding.ownerId !== barrier.accountId ||
      binding.zoneRoute !== routeOf(binding.zoneId) ||
      binding.originalHome !== artifact.partition ||
      partitionOf(binding.zoneRoute) !== binding.originalHome
    )
      return pending('zone-history-terminal-binding-changed');
  } else if (ownerRole) return pending('zone-history-terminal-account-branch-required');

  // The lookup is deliberately non-locking: discover the parent first, then lock Zone before
  // its native copy/hold rows, matching the existing Zone consumer fence order.
  const rawSource = (
    await tx.query<{ source_key: string }>(
      `SELECT source_key FROM core.record_history_locator
       WHERE partition_no=$1 AND artifact_type=$2 AND locator=$3
       ORDER BY source_key LIMIT 2`,
      [artifact.partition, artifact.locator.artifactType, Buffer.from(encodeLocator(artifact.locator))],
    )
  ).rows;
  if (rawSource.length !== 1) return pending('zone-history-source-inventory-unavailable');
  const foundZoneId = zoneIdFromSourceKey(rawSource[0]!.source_key);
  if (!foundZoneId) return pending('zone-history-source-inventory-unavailable');
  const zoneId = binding?.zoneId ?? foundZoneId;
  const route = binding?.zoneRoute ?? routeOf(zoneId);
  if (route === null || foundZoneId !== zoneId) return pending('zone-history-source-binding-changed');

  // Loaded on use: a static import of the Zone store from this History hub closes an import cycle that left
  // module-level declarations uninitialized and stopped the Kernel from booting (d97edeb000).
  const { lockZoneHead } = await import('../../zones/resource-store.ts');
  const zone = await lockZoneHead(tx, route, zoneId);
  if (!zone) return pending('zone-history-source-missing');
  if (binding) {
    if (
      zone.ownerId !== binding.ownerId ||
      zone.transactionId !== binding.ownerTransactionId ||
      zone.revision !== binding.zoneRevision ||
      zone.lifecycleRevision !== binding.lifecycleRevision
    )
      return pending('zone-history-current-owner-custody-changed');
  } else if (zone.ownerId === barrier.accountId) return pending('zone-history-terminal-account-branch-required');

  const home = (
    await tx.query<{ epoch: number; write_state: string }>(
      'SELECT epoch,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE',
      [artifact.partition],
    )
  ).rows[0];
  if (home?.write_state !== 'active') return pending('zone-history-native-home-unavailable');
  if (binding && home.epoch !== binding.originalEpoch) return pending('zone-history-home-epoch-changed');
  if (!(await lockHistoryBarrier(tx, barrier))) return pending('zone-history-terminal-barrier-unavailable');

  const sourceKey = JSON.stringify(['zone', zoneId]);
  const locatorBytes = Buffer.from(encodeLocator(artifact.locator));
  const sourceRows = await zoneSource.run(tx, {
    partition: artifact.partition,
    source_key: sourceKey,
    artifact_type: artifact.locator.artifactType,
    locator: locatorBytes,
  });
  if (sourceRows.length !== 1 || sourceRows[0]!.producer_version !== 1)
    return pending('zone-history-source-inventory-unavailable');
  const source = sourceRows[0]!;
  if (!source.originalTransaction || !source.originalPosition)
    return pending('zone-history-source-position-unavailable');

  const openHold = await tx.query(
    `SELECT hold_id FROM semantic.record_purge_hold
     WHERE partition_no=$1 AND source_key=$2 AND released=false
     ORDER BY hold_id LIMIT 1 FOR SHARE`,
    [artifact.partition, sourceKey],
  );
  if (openHold.rows.length) return pending('zone-history-receiving-hold-open');

  let eventLocator: Extract<HistoryArtifact['locator'], { artifactType: 'outbox-event/v1' }>;
  if (artifact.locator.artifactType === 'outbox-event/v1') {
    eventLocator = artifact.locator;
  } else {
    const events = await tx.query<{ locator: Buffer }>(
      `SELECT locator FROM core.record_history_locator
       WHERE source_key=$1 AND partition_no=$2 AND original_transaction=$3::uuid AND original_position=$4::bigint
         AND artifact_type='outbox-event/v1'
       ORDER BY locator LIMIT 2 FOR SHARE`,
      [sourceKey, artifact.partition, source.originalTransaction, source.originalPosition],
    );
    if (events.rows.length !== 1) return pending('zone-history-command-event-custody-unavailable');
    const decoded = decodeLocator('outbox-event/v1', events.rows[0]!.locator);
    if (decoded.artifactType !== 'outbox-event/v1' || decoded.position.toString() !== source.originalPosition)
      throw new TypeError('Zone receipt event locator differs from its source command');
    eventLocator = decoded;
  }

  const event = (
    await tx.query<{ type: string }>(
      `SELECT type FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=$3 FOR SHARE`,
      [artifact.partition, eventLocator.position.toString(), eventLocator.eventSeq],
    )
  ).rows[0];
  if (!event || !ZONE_EVENT_TYPE_SET().has(event.type)) return pending('zone-history-event-inventory-unavailable');
  const classification = classifyEvent(event.type);
  if (classification.kind !== 'non-personal') throw new TypeError('Zone base event classification changed');
  if (
    artifact.locator.artifactType === 'outbox-event/v1' &&
    (artifact.locator.position !== eventLocator.position || artifact.locator.eventSeq !== eventLocator.eventSeq)
  )
    throw new TypeError('Zone outbox locator differs from its source command');

  const delivery = (
    await tx.query<{ complete: boolean }>(
      `SELECT complete FROM semantic.erasure_delivery
       WHERE partition_no=$1 AND source_position=$2::bigint FOR SHARE`,
      [artifact.partition, source.originalPosition],
    )
  ).rows[0];
  if (!delivery) return pending('zone-erasure-locator-consumer-unobserved');
  if (!delivery.complete) return pending('zone-erasure-locator-consumer-open');

  return {
    state: 'closed',
    zoneId,
    sourceKey,
    sourceTransactionId: source.originalTransaction,
    sourcePosition: source.originalPosition,
    eventType: event.type as ZoneHistoryEventType,
    eventPosition: eventLocator.position.toString(),
    eventSeq: eventLocator.eventSeq,
    consumer: 'semantic_erasure_locator',
    receivingHolds: 'released',
  };
}

async function isZoneHistoryArtifact(tx: CommandTransaction, artifact: HistoryArtifact): Promise<boolean> {
  if (artifact.locator.artifactType === 'command-receipt/v1') {
    const kind = commandHistoryKind(artifact.locator.commandKindId);
    return kind !== undefined && ZONE_RECEIPT_KIND_SET().has(kind);
  }
  if (artifact.locator.artifactType === 'outbox-event/v1') {
    const event = (
      await tx.query<{ type: string }>(
        `SELECT type FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=$3 FOR SHARE`,
        [artifact.partition, artifact.locator.position.toString(), artifact.locator.eventSeq],
      )
    ).rows[0];
    return event !== undefined && ZONE_EVENT_TYPE_SET().has(event.type);
  }
  return false;
}

function scopeDigest(artifact: HistoryArtifact): Buffer {
  validateLocator(artifact.locator.artifactType, artifact.locator);
  validateScope(artifact.locator.artifactType, {
    artifactType: artifact.locator.artifactType,
    accounts: artifact.accounts,
  });
  if (
    !Number.isInteger(artifact.partition) ||
    artifact.partition < 0 ||
    artifact.partition > 4095 ||
    (artifact.locator.artifactType !== 'durable-work/v1' && artifact.locator.partitionNo !== artifact.partition)
  )
    throw new TypeError('Invalid receiving artifact home');
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

async function nativeScope(tx: CommandTransaction, partition: number, type: string, locator: Buffer) {
  const rows = (
    await tx.query<{
      account_route: number;
      account_id: string;
      roles: number;
      minimizer_version: number;
      state: string;
      proof_barrier: string | null;
    }>(
      `SELECT account_route,account_id,roles,minimizer_version,state,proof_barrier FROM core.history_locator
     WHERE partition_no=$1 AND artifact_type=$2 AND locator=$3
     ORDER BY account_route,account_id LIMIT 65 FOR SHARE`,
      [partition, type, locator],
    )
  ).rows;
  if (rows.length === 0 || rows.length > 64 || rows.some((row) => row.minimizer_version !== 1)) return null;
  return rows;
}

/** Called by the physical minimizer in the SAME transaction as its local locator effect. No
 * caller boolean or process capability substitutes for the native minimized source proof. */
export async function recordHistoryReceivingProof(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  partition: number,
  locator: HistoryArtifact['locator'],
  pool?: Pool,
  context?: HistoryReceivingContext,
): Promise<string | null> {
  if (partition !== partitionOf(barrier.accountRoute)) return 'history-receiving-barrier-home-unavailable';
  if (hasLiveCommandTransaction(tx) && currentCommand(tx).partition !== partition)
    return 'history-receiving-artifact-home-unavailable';
  const zoneArtifact = await isZoneHistoryArtifact(tx, { partition, locator, accounts: [] });
  if (context?.discriminant?.kind === 'zone-cleanup' && !zoneArtifact)
    return 'zone-history-receiving-artifact-mismatch';
  if (zoneArtifact) {
    const zoneClosure = await observeZoneHistoryConsumerClosure(
      tx,
      { partition, locator, accounts: [] },
      barrier,
      context?.discriminant?.kind === 'zone-cleanup' ? context.discriminant.binding : undefined,
    );
    if (zoneClosure.state === 'pending') return zoneClosure.gap;
  }
  if (locator.artifactType === 'durable-work/v1') {
    const { currentAgentIdentityHistoryUnit, assertAgentIdentityHistoryUnit } =
      await import('./agent-identity-retirement.ts');
    const unit = currentAgentIdentityHistoryUnit();
    if (unit?.prepaid) {
      const resources = currentCommandResources(tx);
      assertAgentIdentityHistoryUnit(resources.pool, context ?? resources);
      if (pool && pool !== resources.pool) throw new TypeError('History receiving pool differs from its command');
    }
    if (unit?.stage?.handoff.custodyId === locator.workId)
      return recordIdentityReceivingProof(tx, barrier, partition, locator, context ?? unit.context);
    if (unit?.prepaid) return 'identity-history-current-unit-unavailable';
  }
  if (!(await lockHistoryBarrier(tx, barrier))) throw new TypeError('History barrier mismatch');
  const encoded = Buffer.from(encodeLocator(locator));
  const custodyGap = await historyReceivingGap(tx, partition, locator, barrier, pool, context);
  if (custodyGap) return custodyGap;
  if (!(await historyPhysicalProof(tx, partition, locator))) throw new TypeError('History physical copy remains');
  const rows = await nativeScope(tx, partition, locator.artifactType, encoded);
  const own = rows?.find((row) => row.account_id === barrier.accountId && row.account_route === barrier.accountRoute);
  if (!own || own.state !== 'minimized' || own.proof_barrier !== barrier.accountId)
    throw new TypeError('History physical receiving proof unavailable');
  const native = (
    await tx.query('SELECT epoch,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE', [partition])
  ).rows[0];
  if (!native || native.write_state !== 'active') throw new CommandUnavailableError('moved', partition);
  const roleDigest = scopeDigest({
    partition,
    locator,
    accounts: rows!.map((row) => ({
      accountRoute: row.account_route,
      accountId: row.account_id,
      roles: row.roles,
    })),
  });
  await tx.query(
    `INSERT INTO core.history_receiving_proof(partition_no,account_route,account_id,artifact_type,locator,
      barrier_version,barrier_at,partition_epoch,role_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT DO NOTHING`,
    [
      partition,
      barrier.accountRoute,
      barrier.accountId,
      locator.artifactType,
      encoded,
      barrier.version,
      barrier.at,
      native.epoch,
      roleDigest,
    ],
  );
  return null;
}

export async function historyReceivingGap(
  tx: CommandTransaction,
  partition: number,
  locator: HistoryArtifact['locator'],
  barrier?: HistoryBarrier,
  pool?: Pool,
  context?: HistoryReceivingContext,
): Promise<string | null> {
  // Only a live native command may inspect the receiving union. Released Search
  // observations are rechecked by the recovery owner inside that command.
  if (!hasLiveCommandTransaction(tx)) return 'history-receiving-command-resources-unavailable';
  if (currentCommand(tx).partition !== partition) return 'history-receiving-artifact-home-unavailable';
  if (barrier && partitionOf(barrier.accountRoute) !== partition) return 'history-receiving-barrier-home-unavailable';
  const resources = currentCommandResources(tx);
  if (pool && pool !== resources.pool) throw new TypeError('History receiving pool differs from its command');
  let mapping: Awaited<ReturnType<typeof import('./agent-identity-work.ts').resolveAgentIdentitySDKWork>> = null;
  if (locator.artifactType === 'durable-work/v1') {
    const { resolveAgentIdentitySDKWork } = await import('./agent-identity-work.ts');
    mapping = await resolveAgentIdentitySDKWork(tx, locator.workId);
    if (mapping && !mapping.gap) {
      const m = (
        await tx.query(
          `SELECT history_authority,sdk_readiness,sdk_closure FROM core.agent_identity_work
        WHERE custody_id=$1 FOR SHARE`,
          [locator.workId],
        )
      ).rows[0];
      if (!m?.history_authority || !m.sdk_readiness || !m.sdk_closure)
        return 'identity-history-guarded-closure-pending';
      // This receiving copy has its own real Source/SDK authority. Source payload
      // retention and its later minimization remain independent inventory obligations.
      await tx.query(`SELECT core.check_agent_identity_history($1,$2,$3,$4,'closure')`, [
        locator.workId,
        m.sdk_readiness.binding,
        m.history_authority,
        m.sdk_closure,
      ]);
      await tx.query(`SELECT core.check_agent_identity_history_absence($1)`, [locator.workId]);
      return null;
    }
  }
  const identityGap = await agentIdentityCopyRetentionGap(
    tx,
    partition,
    locator.artifactType,
    Buffer.from(encodeLocator(locator)),
  );
  if (identityGap) return identityGap;
  if (locator.artifactType === 'command-receipt/v1' || locator.artifactType === 'outbox-event/v1') {
    const { verifyAgentIdentityRecoveryArtifactReadiness } = await import('./agent-identity-recovery-receiving.ts');
    const recovery = await verifyAgentIdentityRecoveryArtifactReadiness(
      tx,
      { partition, locator, accounts: [] },
      barrier,
      resources.pool,
      {
        deadline: resources.deadline,
        ...searchObservationSource(context?.accountErasureSearchObservation),
        ...(context?.recoveryReceivingReserved === undefined
          ? {}
          : { recoveryReceivingReserved: context.recoveryReceivingReserved }),
      },
    );
    if (recovery.state === 'pending') return recovery.gap;
    if (recovery.state === 'ready') return null;
  }
  if (locator.artifactType === 'durable-work/v1') return mapping?.gap ?? null;
  if (locator.artifactType !== 'outbox-event/v1') return null;
  const charge = async (rows: number, points: number, statements: number, bytes: number) => {
    const { reserveIdentityHistoryWork, nativeWork } = await import('./agent-identity-inventory-work.ts');
    await reserveIdentityHistoryWork(resources.pool, nativeWork(rows, points, statements, bytes), {
      deadline: resources.deadline,
    });
  };
  await charge(33, 33, 1, 65536);
  // Enumerate the closed runtime fanout (32 plus overflow). A completed effect can
  // retain SDK arguments; only its actual immutable receiving association can close it.
  const consumers = (
    await tx.query(
      `SELECT consumer,workflow_id,state FROM core.history_event_consumer
     WHERE partition_no=$1 AND position=$2 AND event_seq=$3 ORDER BY consumer LIMIT 33 FOR SHARE`,
      [partition, locator.position.toString(), locator.eventSeq],
    )
  ).rows;
  if (consumers.length > 32) return 'outbox-receiving-custody-unavailable';
  for (const consumer of consumers) {
    if (partition !== 0 || !barrier) return 'outbox-receiving-custody-unavailable';
    if (consumer.state !== 'transferred' && consumer.state !== 'completed')
      return 'outbox-receiving-custody-unavailable';
    // Resolve the ORIGINAL outbox handoff, never parse a workflow name or treat a
    // successful wrapper as the mapped receiving execution. Unknown wrappers refuse.
    await charge(8, 8, 1, 16384);
    const association = (
      await tx.query(
        `SELECT m.custody_id FROM core.agent_identity_work m
       JOIN core.agent_identity_sdk_obligation o ON o.partition_no=(m.source->>'partition')::integer
         AND o.source_route=get_byte(uuid_send((m.source_key::jsonb->>1)::uuid),10)*256+
                            get_byte(uuid_send((m.source_key::jsonb->>1)::uuid),11)
         AND o.source_account_id=(m.source_key::jsonb->>1)::uuid
         AND o.source_direction=m.source_key::jsonb->>0 AND o.source_receipt_id=(m.source_key::jsonb->>2)::uuid
         AND m.source_key=o.delivery_key AND m.workflow_id=o.workflow_id
       JOIN core.outbox e ON e.partition_no=o.handoff_partition AND e.epoch=o.handoff_epoch
         AND e.position=o.handoff_position
         AND e.type=o.handoff_event_type
       JOIN core.agent_identity_inventory i ON i.partition_no=o.partition_no AND i.source_route=o.source_route
         AND i.source_account_id=o.source_account_id AND i.source_direction=o.source_direction
         AND i.source_receipt_id=o.source_receipt_id
       JOIN core.receipt r ON r.partition_no=o.handoff_partition AND r.epoch=o.handoff_epoch
         AND r.position=o.handoff_position AND r.transaction_id=o.handoff_transaction_id
         AND r.principal_kind=i.native_principal_kind AND r.principal_id=i.native_principal_id
         AND r.command_kind=i.native_command_kind AND r.idempotency_key=i.native_receipt_key
       JOIN core.agent_identity_work_source s ON s.partition_no=o.partition_no AND s.source_key=m.source_key
         AND s.custody_id=m.custody_id AND s.source=m.source AND s.source_generation=m.receiver_generation
       WHERE m.workflow_id=$4 AND m.creation_captured AND o.handoff_partition=$1 AND o.handoff_position=$2 AND e.event_seq=$3
         AND $5='agent_verification_reversal' AND e.type='com.rezics.access.agent-verification.reversing.v1'
       ORDER BY o.source_route,o.source_account_id,o.source_direction,o.source_receipt_id LIMIT 2 FOR SHARE OF o,e,r,m,s,i`,
        [partition, locator.position.toString(), locator.eventSeq, consumer.workflow_id, consumer.consumer],
      )
    ).rows;
    if (association.length !== 1) return 'outbox-receiving-custody-unavailable';
    const { lockAgentIdentityReceivingArtifact } = await import('./agent-identity-sdk-fence.ts');
    await charge(69, 69, 4, 24576);
    const artifact = await lockAgentIdentityReceivingArtifact(tx, association[0]!.custody_id);
    if (!artifact) return 'outbox-receiving-custody-unavailable';
    {
      const { reserveIdentityHistoryWork, addNativeWork } = await import('./agent-identity-inventory-work.ts');
      const {
        AGENT_IDENTITY_HISTORY_GUARD_COST: AGENT_IDENTITY_HISTORY_GUARD_COSTGetter,
        AGENT_IDENTITY_HISTORY_ABSENCE_COST: AGENT_IDENTITY_HISTORY_ABSENCE_COSTGetter,
      } = await import('./agent-identity-sdk-fence.ts');
      const AGENT_IDENTITY_HISTORY_GUARD_COST = AGENT_IDENTITY_HISTORY_GUARD_COSTGetter();
      const AGENT_IDENTITY_HISTORY_ABSENCE_COST = AGENT_IDENTITY_HISTORY_ABSENCE_COSTGetter();
      await reserveIdentityHistoryWork(
        resources.pool,
        addNativeWork(
          IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.durableReceiving,
          AGENT_IDENTITY_HISTORY_GUARD_COST,
          AGENT_IDENTITY_HISTORY_ABSENCE_COST,
        ),
        { deadline: resources.deadline },
      );
    }
    if (!(await nativeReceipt(tx, barrier, artifact, pool))) return 'outbox-receiving-custody-unavailable';
  }
  return null;
}

export async function historyPhysicalProof(
  tx: CommandTransaction,
  partition: number,
  locator: HistoryArtifact['locator'],
): Promise<boolean> {
  if (locator.artifactType === 'command-receipt/v1') {
    const kind = commandHistoryKind(locator.commandKindId);
    if (!kind || locator.partitionNo !== partition) return false;
    const token = `rk1.${locator.keyVersion}.${Buffer.from(locator.keyToken, 'hex').toString('base64url')}`;
    const proof = await tx.query(
      `SELECT 1 FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2
      AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5
      AND payload_state='minimized' AND response='null'::jsonb FOR SHARE`,
      [partition, locator.principalKind, locator.principalId, kind, token],
    );
    return proof.rows.length === 1;
  }
  if (locator.artifactType === 'outbox-event/v1') {
    if (locator.partitionNo !== partition) return false;
    const proof = await tx.query(
      `SELECT 1 FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=$3
      AND payload_state='minimized' AND data='{}'::jsonb AND subject IS NULL FOR SHARE`,
      [partition, locator.position.toString(), locator.eventSeq],
    );
    return proof.rows.length === 1;
  }
  const proof = await tx.query(
    `SELECT 1 FROM core.history_work WHERE partition_no=$1 AND work_id=$2
    AND state='retired' AND absence_verified AND request IS NULL AND scope IS NULL FOR SHARE`,
    [partition, locator.workId],
  );
  return proof.rows.length === 1;
}

function sameBarrier(left: HistoryBarrier, right: HistoryBarrier): boolean {
  return (
    left.accountId === right.accountId &&
    left.accountRoute === right.accountRoute &&
    left.version === right.version &&
    left.at === right.at
  );
}

async function nativeReceipt(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  artifact: HistoryArtifact,
  pool?: Pool,
  context?: HistoryReceivingContext,
): Promise<ReceiptBinding | null> {
  // No foreign root read may occur while the artifact home is held. A released
  // observation cannot carry that root lock into this transaction.
  if (artifact.partition !== partitionOf(barrier.accountRoute)) return null;
  const zoneArtifact = await isZoneHistoryArtifact(tx, artifact);
  if (context?.discriminant?.kind === 'zone-cleanup' && !zoneArtifact) return null;
  if (zoneArtifact) {
    const closure = await observeZoneHistoryConsumerClosure(
      tx,
      artifact,
      barrier,
      context?.discriminant?.kind === 'zone-cleanup' ? context.discriminant.binding : undefined,
    );
    if (closure.state === 'pending') return null;
  }
  if (!(await lockHistoryBarrier(tx, barrier))) return null;
  if (await historyReceivingGap(tx, artifact.partition, artifact.locator, barrier, pool, context)) return null;
  const digest = scopeDigest(artifact);
  const encoded = Buffer.from(encodeLocator(artifact.locator));
  const rows = await nativeScope(tx, artifact.partition, artifact.locator.artifactType, encoded);
  const own = rows?.find((row) => row.account_id === barrier.accountId && row.account_route === barrier.accountRoute);
  if (
    !own ||
    own.state !== 'minimized' ||
    own.proof_barrier !== barrier.accountId ||
    !scopeDigest({
      ...artifact,
      accounts: rows!.map((row) => ({
        accountRoute: row.account_route,
        accountId: row.account_id,
        roles: row.roles,
      })),
    }).equals(digest)
  )
    return null;
  const native = (
    await tx.query('SELECT epoch,write_state FROM core.partition WHERE partition_no=$1 FOR SHARE', [artifact.partition])
  ).rows[0];
  if (!native || native.write_state !== 'active') throw new CommandUnavailableError('moved', artifact.partition);
  const proof = (
    await tx.query(
      `SELECT role_digest FROM core.history_receiving_proof WHERE partition_no=$1 AND account_route=$2 AND account_id=$3
     AND artifact_type=$4 AND locator=$5 AND barrier_version=$6 AND barrier_at=$7 AND partition_epoch=$8 FOR SHARE`,
      [
        artifact.partition,
        barrier.accountRoute,
        barrier.accountId,
        artifact.locator.artifactType,
        encoded,
        barrier.version,
        barrier.at,
        native.epoch,
      ],
    )
  ).rows[0];
  if (
    !proof ||
    !Buffer.from(proof.role_digest).equals(digest) ||
    !(await historyPhysicalProof(tx, artifact.partition, artifact.locator))
  )
    return null;
  return {
    barrier: Object.freeze({ ...barrier }),
    discriminant: structuredClone(context?.discriminant ?? { kind: 'account-erasure' as const }),
    partition: artifact.partition,
    locator: encoded,
    roleDigest: digest,
    epoch: native.epoch,
  };
}

export async function readHistoryReceivingReceipt(
  deps: HistoryReceivingDependencies,
  barrier: HistoryBarrier,
  artifact: HistoryArtifact,
  context: HistoryReceivingContext,
): Promise<HistoryReceivingReceipt | null> {
  validateBarrier(barrier);
  historyDeadline(context, artifact.partition);
  const discriminant = structuredClone(context.discriminant ?? { kind: 'account-erasure' as const });
  // Do not expose a capability retaining caller-owned mutable arrays or buffers.
  const fixedArtifact = structuredClone(artifact);
  const fixedBarrier = Object.freeze({ ...barrier });
  const { reserveIdentityHistoryWork, nativeWork, addNativeWork, IDENTITY_HISTORY_COMMAND_CONTROL } =
    await import('./agent-identity-inventory-work.ts');
  const {
    AGENT_IDENTITY_HISTORY_GUARD_COST: AGENT_IDENTITY_HISTORY_GUARD_COSTGetter,
    AGENT_IDENTITY_HISTORY_ABSENCE_COST: AGENT_IDENTITY_HISTORY_ABSENCE_COSTGetter,
  } = await import('./agent-identity-sdk-fence.ts');
  const AGENT_IDENTITY_HISTORY_GUARD_COST = AGENT_IDENTITY_HISTORY_GUARD_COSTGetter();
  const AGENT_IDENTITY_HISTORY_ABSENCE_COST = AGENT_IDENTITY_HISTORY_ABSENCE_COSTGetter();
  await reserveIdentityHistoryWork(
    nativePool(deps.pool),
    addNativeWork(
      IDENTITY_HISTORY_COMMAND_CONTROL,
      fixedArtifact.locator.artifactType === 'durable-work/v1'
        ? addNativeWork(
            nativeWork(76, 75, 13, 131872),
            AGENT_IDENTITY_HISTORY_GUARD_COST,
            AGENT_IDENTITY_HISTORY_ABSENCE_COST,
          )
        : nativeWork(76, 75, 8, 24448),
    ),
    context,
  );
  // Recovery and SDK guards consume real command resources. A PoolClient with an
  // open transaction is insufficient, even though its query method has the same type.
  // This command releases its checkout before the caller can visit another home.
  const binding = await withSingleCommandAttempt(
    async () =>
      (
        await runCommand(
          nativePool(deps.pool),
          { partition: fixedArtifact.partition, deadline: context.deadline },
          async (tx) => {
            const current = await nativeReceipt(tx, fixedBarrier, fixedArtifact, nativePool(deps.pool), context);
            historyDeadline(context, fixedArtifact.partition);
            return noEffect(current);
          },
        )
      ).value,
  );
  if (!binding) return null;
  const receipt = Object.freeze({}) as HistoryReceivingReceipt;
  receipts.set(receipt, { ...binding, discriminant });
  return receipt;
}

/** Final owners call this on their actual account-home command. Locks live through its COMMIT. */
export async function verifyHistoryReceivingReceipt(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  artifact: HistoryArtifact,
  receipt: HistoryReceivingReceipt,
  context?: HistoryReceivingContext,
): Promise<boolean> {
  const bound = receipts.get(receipt);
  if (
    !bound ||
    currentCommand(tx).partition !== partitionOf(barrier.accountRoute) ||
    !sameBarrier(bound.barrier, barrier) ||
    !sameDiscriminant(bound.discriminant, context?.discriminant) ||
    bound.partition !== artifact.partition ||
    !bound.locator.equals(Buffer.from(encodeLocator(artifact.locator))) ||
    !bound.roleDigest.equals(scopeDigest(artifact))
  )
    return false;
  if (artifact.locator.artifactType === 'durable-work/v1') {
    const { pool, deadline } = currentCommandResources(tx);
    const { reserveIdentityHistoryWork, addNativeWork } = await import('./agent-identity-inventory-work.ts');
    const {
      AGENT_IDENTITY_HISTORY_GUARD_COST: AGENT_IDENTITY_HISTORY_GUARD_COSTGetter,
      AGENT_IDENTITY_HISTORY_ABSENCE_COST: AGENT_IDENTITY_HISTORY_ABSENCE_COSTGetter,
    } = await import('./agent-identity-sdk-fence.ts');
    const AGENT_IDENTITY_HISTORY_GUARD_COST = AGENT_IDENTITY_HISTORY_GUARD_COSTGetter();
    const AGENT_IDENTITY_HISTORY_ABSENCE_COST = AGENT_IDENTITY_HISTORY_ABSENCE_COSTGetter();
    await reserveIdentityHistoryWork(
      pool,
      addNativeWork(
        IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.durableReceiving,
        AGENT_IDENTITY_HISTORY_GUARD_COST,
        AGENT_IDENTITY_HISTORY_ABSENCE_COST,
      ),
      { deadline },
    );
  }
  const { pool } = currentCommandResources(tx);
  const current = await nativeReceipt(tx, barrier, artifact, pool, context);
  return current !== null && current.epoch === bound.epoch && current.roleDigest.equals(bound.roleDigest);
}

export async function readHistoryOwnerCoverage(
  deps: HistoryReceivingDependencies,
  barrier: HistoryBarrier,
  family: HistoryProducerFamily,
  context: HistoryReceivingContext,
): Promise<HistoryOwnerCoverageResult> {
  validateBarrier(barrier);
  if (!HISTORY_PRODUCER_FAMILIES.includes(family)) throw new TypeError('Unknown history producer family');
  historyDeadline(context, partitionOf(barrier.accountRoute));
  const fixedBarrier = Object.freeze({ ...barrier });
  return withConnection(nativePool(deps.pool), async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [
        `${Math.max(1, context.deadline - Date.now())}ms`,
      ]);
      const result = await lockNativeFamilyCoverage(tx, fixedBarrier, family);
      historyDeadline(context, partitionOf(fixedBarrier.accountRoute));
      await tx.query('COMMIT');
      if (result.state === 'pending') return result;
      const coverage = Object.freeze({}) as HistoryOwnerCoverage;
      coverages.set(coverage, {
        barrier: fixedBarrier,
        family,
        native: result.binding,
      });
      return { state: 'complete', coverage };
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
}

export async function verifyHistoryOwnerCoverage(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  family: HistoryProducerFamily,
  coverage: HistoryOwnerCoverage,
): Promise<boolean> {
  const binding = coverages.get(coverage);
  if (
    !binding ||
    binding.family !== family ||
    !sameBarrier(binding.barrier, barrier) ||
    currentCommand(tx).partition !== partitionOf(barrier.accountRoute)
  )
    return false;
  const current = await lockNativeFamilyCoverage(tx, barrier, family);
  return (
    current.state === 'complete' &&
    current.binding.proofId === binding.native.proofId &&
    current.binding.domain === binding.native.domain &&
    current.binding.revision === binding.native.revision &&
    current.binding.definition === binding.native.definition
  );
}

/** Operational use only. Reuses the exact artifact receiving proof and source locks. */
export async function recordHistoryFamilyArtifactWatch(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  artifact: HistoryArtifact,
): Promise<boolean> {
  if (!(await nativeReceipt(tx, barrier, artifact))) return false;
  const locator = artifact.locator;
  const sourceKey =
    locator.artifactType === 'command-receipt/v1'
      ? [
          locator.principalKind,
          locator.principalId,
          commandHistoryKind(locator.commandKindId),
          `rk1.${locator.keyVersion}.${Buffer.from(locator.keyToken, 'hex').toString('base64url')}`,
        ]
      : locator.artifactType === 'outbox-event/v1'
        ? [locator.position.toString(), locator.eventSeq]
        : [locator.workId];
  await tx.query(
    `INSERT INTO core.history_family_watch(partition_no,artifact_type,locator,source_key)
     VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [artifact.partition, locator.artifactType, Buffer.from(encodeLocator(locator)), JSON.stringify(sourceKey)],
  );
  return true;
}

/** The selected identity copy's final receiving write. All current authority is
 * independently re-resolved here, in the actual receiving/progress transaction. */
async function recordIdentityReceivingProof(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  partition: number,
  locator: Extract<HistoryArtifact['locator'], { artifactType: 'durable-work/v1' }>,
  context: HistoryReceivingContext,
): Promise<string | null> {
  const { currentAgentIdentityHistoryUnit, assertAgentIdentityHistoryUnit } =
    await import('./agent-identity-retirement.ts');
  const { currentCommandResources } = await import('../../command/command.ts');
  const {
    lockRecordedAgentIdentityHistory,
    AGENT_IDENTITY_HISTORY_GUARD_COST: AGENT_IDENTITY_HISTORY_GUARD_COSTGetter,
    AGENT_IDENTITY_HISTORY_ABSENCE_COST: AGENT_IDENTITY_HISTORY_ABSENCE_COSTGetter,
  } = await import('./agent-identity-sdk-fence.ts');
  const AGENT_IDENTITY_HISTORY_GUARD_COST = AGENT_IDENTITY_HISTORY_GUARD_COSTGetter();
  const AGENT_IDENTITY_HISTORY_ABSENCE_COST = AGENT_IDENTITY_HISTORY_ABSENCE_COSTGetter();
  const { reserveIdentityHistoryWork, addNativeWork, HISTORY_RECEIVING_INVALIDATION } =
    await import('./agent-identity-inventory-work.ts');
  const unit = currentAgentIdentityHistoryUnit();
  if (!unit?.stage || !unit.client || partition !== 0) return 'identity-history-current-unit-unavailable';
  const { pool, deadline } = currentCommandResources(tx);
  assertAgentIdentityHistoryUnit(pool, context, unit.client);
  const held = await lockRecordedAgentIdentityHistory(tx, unit.client, unit.stage, unit.context);
  if (held.state === 'pending') return held.gap;
  if (!sameBarrier(barrier, held.receipt.binding.barrier)) return 'identity-sdk-retirement-barrier-changed';
  await reserveIdentityHistoryWork(
    pool,
    addNativeWork(IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativeGuardProbe, AGENT_IDENTITY_HISTORY_ABSENCE_COST),
    {
      deadline,
    },
  );
  await tx.query(`SELECT core.check_agent_identity_history_absence($1)`, [locator.workId]);
  const encoded = Buffer.from(encodeLocator(locator));
  await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.roleScope, { deadline });
  const rows = await nativeScope(tx, partition, locator.artifactType, encoded);
  const own = rows?.find((r) => r.account_route === barrier.accountRoute && r.account_id === barrier.accountId);
  if (!own || own.state !== 'minimized' || own.proof_barrier !== barrier.accountId)
    return 'identity-history-locator-not-minimized';
  const roleDigest = scopeDigest({
    partition,
    locator,
    accounts: rows!.map((r) => ({
      accountRoute: r.account_route,
      accountId: r.account_id,
      roles: r.roles,
    })),
  });
  // INSERT guard: association + current native guard + eight absence points + work,
  // exact locator, 64 role-digest keys, two FK checks and the original invalidation.
  await reserveIdentityHistoryWork(
    pool,
    addNativeWork(
      IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.receivingInsert,
      AGENT_IDENTITY_HISTORY_GUARD_COST,
      AGENT_IDENTITY_HISTORY_ABSENCE_COST,
      HISTORY_RECEIVING_INVALIDATION,
    ),
    { deadline },
  );
  await tx.query(
    `INSERT INTO core.history_receiving_proof(partition_no,account_route,account_id,artifact_type,locator,
    barrier_version,barrier_at,partition_epoch,role_digest) VALUES(0,$1,$2,'durable-work/v1',$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING`,
    [
      barrier.accountRoute,
      barrier.accountId,
      encoded,
      barrier.version,
      barrier.at,
      held.receipt.binding.receiver.epoch,
      roleDigest,
    ],
  );
  assertAgentIdentityHistoryUnit(pool, context, unit.client);
  return null;
}

/** Current native receiving proof in the held home. This grants no new writer authority. */
export async function verifyCurrentHistoryReceiving(
  tx: CommandTransaction,
  barrier: HistoryBarrier,
  artifact: HistoryArtifact,
): Promise<boolean> {
  if (currentCommand(tx).partition !== artifact.partition) return false;
  const { pool } = (await import('../../command/command.ts')).currentCommandResources(tx);
  return (await nativeReceipt(tx, barrier, artifact, pool)) !== null;
}
