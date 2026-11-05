import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { RecordPurgeAuthority, RecordPurgeSource, NativeRecordPurgeReference } from './record-purge-authority.ts';

export type RecordPurgeCustodyDependencies = Readonly<{ pool: Pool; clock?: () => Date }>;
export type RecordPurgeCustodyContext = Readonly<{ deadline: number }>;
export type RecordPurgeReceivingTarget = Readonly<{ partition: number; receivingId: string }>;
declare const recordReceivingHold: unique symbol;
declare const recordInventoryCut: unique symbol;
export type RecordPurgeReceivingHold = Readonly<{ [recordReceivingHold]: true }>;
export type RecordPurgeInventoryCut = Readonly<{ [recordInventoryCut]: true }>;

import {
  authoritativeTimeValue,
  CommandUnavailableError,
  currentCommand,
  noEffect,
  registerCommandCallback,
  runCommand,
} from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ACCOUNT_ROLE_BITS } from '../history/contracts.ts';
import type { AccountReference } from '../history/locator.ts';
import { declareCommandHistory, registerCommandHistoryKind } from '../history/record.ts';
import {
  declareCommandRecordSources,
  recordHistorySourceKey,
  type RecordHistorySourceReference,
} from '../history/record-source.ts';
import {
  lockRecordPurgeAuthoritySource,
  prepareRecordPurgeAuthority,
  readRecordPurgeAuthoritySource,
} from './record-purge-authority.ts';

// Permanent owner-assigned codec IDs; existing receipt command strings remain unchanged.
const resourceHistoryCommands = {
  'context.create': 3000,
  'context:delete': 3001,
  'context:restore': 3002,
  'definitions.extension.publish': 3003,
  'definitions.extension.activate': 3004,
  'zone.create': 3010,
  'zone.configure': 3011,
  'zone.publish': 3012,
  'zone.delete': 3013,
  'zone.restore': 3014,
  'zone.takedown': 3015,
  'zone.release_takedown': 3016,
} as const;
for (const [kind, id] of Object.entries(resourceHistoryCommands)) registerCommandHistoryKind(kind, id);

type Locator = Readonly<{
  reference: NativeRecordPurgeReference;
  key: string;
  holdId: string;
  target: RecordPurgeReceivingTarget;
}>;
// Handles carry lookup hints only. Every effect validates durable native rows again.
const holds = new WeakMap<RecordPurgeReceivingHold, Locator>();
const cuts = new WeakMap<RecordPurgeInventoryCut, Readonly<{ key: string; id: string }>>();
const locked = new WeakMap<CommandTransaction, Set<RecordPurgeReceivingHold>>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function original(ref: NativeRecordPurgeReference): RecordHistorySourceReference {
  return 'subjectId' in ref
    ? {
        kind: 'contribution',
        subjectId: ref.subjectId,
        candidateId: ref.candidateId,
        revision: ref.revision,
        documentId: ref.documentId,
      }
    : ref.kind === 'context'
      ? { kind: 'context', contextId: ref.contextId }
      : { kind: 'zone', zoneId: ref.zoneId };
}
function identity(ref: NativeRecordPurgeReference) {
  const owner = 'subjectId' in ref ? ref.subjectId : ref.kind === 'context' ? ref.contextId : ref.zoneId;
  const record = 'candidateId' in ref ? ref.candidateId : owner;
  const route = routeOf(owner);
  if (route === null || !uuid.test(ref.deletionGeneration)) throw new TypeError('Invalid record purge reference');
  return {
    owner,
    record,
    route,
    partition: partitionOf(route),
    key: recordHistorySourceKey(original(ref)),
    kind: 'subjectId' in ref ? 'contribution' : ref.kind,
  };
}
function targetCopy(target: RecordPurgeReceivingTarget): RecordPurgeReceivingTarget {
  if (
    !Number.isInteger(target.partition) ||
    target.partition < 0 ||
    target.partition > 4095 ||
    !uuid.test(target.receivingId)
  )
    throw new TypeError('Invalid record purge receiving target');
  return Object.freeze({ partition: target.partition, receivingId: target.receivingId });
}
async function epoch(tx: CommandTransaction): Promise<number> {
  const partition = currentCommand(tx).partition;
  const row = await tx.query<{ epoch: number }>(
    "SELECT epoch FROM core.partition WHERE partition_no=$1 AND write_state='active' AND moved_to IS NULL FOR SHARE",
    [partition],
  );
  if (!row.rows[0]) throw new CommandUnavailableError('moved', partition);
  return row.rows[0].epoch;
}
function handle(locator: Locator): RecordPurgeReceivingHold {
  const result = Object.freeze(Object.create(null)) as RecordPurgeReceivingHold;
  holds.set(result, Object.freeze(locator));
  return result;
}
type NativeHold = {
  hold_id: string;
  source: RecordPurgeSource;
  source_epoch: number;
  transaction_id: string;
  released: boolean;
};
async function sourceHold(tx: CommandTransaction, ref: NativeRecordPurgeReference, target: RecordPurgeReceivingTarget) {
  const id = identity(ref);
  return (
    await tx.query<NativeHold>(
      `SELECT hold_id,source,source_epoch,transaction_id,released FROM semantic.record_purge_hold
     WHERE partition_no=$1 AND source_key=$2 AND deletion_generation=$3
     AND receiving_partition=$4 AND receiving_id=$5 FOR UPDATE`,
      [id.partition, id.key, ref.deletionGeneration, target.partition, target.receivingId],
    )
  ).rows[0];
}
function sameSource(a: RecordPurgeSource, b: RecordPurgeSource): boolean {
  return (
    identity(a.reference).key === identity(b.reference).key &&
    a.reference.deletionGeneration === b.reference.deletionGeneration &&
    a.sourceVersion === b.sourceVersion &&
    a.disposition === b.disposition &&
    a.deletionTransactionId === b.deletionTransactionId &&
    a.deletionCommittedAt === b.deletionCommittedAt &&
    a.purgeAfter === b.purgeAfter
  );
}

export async function prepareRecordPurgeReceivingHold(
  deps: RecordPurgeCustodyDependencies,
  authority: RecordPurgeAuthority,
  targetInput: RecordPurgeReceivingTarget,
  context: RecordPurgeCustodyContext,
): Promise<RecordPurgeReceivingHold | null> {
  const target = targetCopy(targetInput);
  const source = await readRecordPurgeAuthoritySource(deps, authority, context);
  if (!source) return null;
  const id = identity(source.reference);
  // This command fully commits and releases its checkout before the receiver is entered.
  const saved = await runCommand(
    deps.pool,
    { partition: id.partition, clock: deps.clock, deadline: context.deadline },
    async (tx) => {
      const current = await lockRecordPurgeAuthoritySource(tx, authority);
      if (!current || !sameSource(current, source)) return noEffect(false);
      const homeEpoch = await epoch(tx);
      await tx.query(
        `INSERT INTO semantic.record_purge_hold
       (partition_no,source_key,deletion_generation,receiving_partition,receiving_id,hold_id,route,kind,
        owner_id,record_id,source_epoch,source,transaction_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
        [
          id.partition,
          id.key,
          source.reference.deletionGeneration,
          target.partition,
          target.receivingId,
          randomUUID(),
          id.route,
          id.kind,
          id.owner,
          id.record,
          homeEpoch,
          source,
          currentCommand(tx).transactionId,
        ],
      );
      const hold = await sourceHold(tx, source.reference, target);
      if (!hold || hold.released || hold.source_epoch !== homeEpoch || !sameSource(hold.source, current))
        throw new Error('record_purge_source_custody_changed');
      return noEffect(true);
    },
  );
  if (!saved.value) return null;
  // A separate source transaction verifies committed provenance. It creates no new hold on restart.
  return acceptCommittedHold(deps, authority, source.reference, target, context, true);
}
async function acceptCommittedHold(
  deps: RecordPurgeCustodyDependencies,
  authority: RecordPurgeAuthority,
  ref: NativeRecordPurgeReference,
  target: RecordPurgeReceivingTarget,
  context: RecordPurgeCustodyContext,
  create: boolean,
): Promise<RecordPurgeReceivingHold | null> {
  const id = identity(ref);
  const read = await runCommand(
    deps.pool,
    { partition: id.partition, clock: deps.clock, deadline: context.deadline },
    async (tx) => {
      const source = await lockRecordPurgeAuthoritySource(tx, authority);
      if (!source) return noEffect(null);
      const hold = await sourceHold(tx, ref, target);
      if (!hold || hold.released) return noEffect(null);
      if (hold.source_epoch !== (await epoch(tx))) throw new CommandUnavailableError('moved', id.partition);
      if (hold.transaction_id === currentCommand(tx).transactionId || !sameSource(hold.source, source))
        throw new Error('record_purge_source_custody_unproven');
      return noEffect(hold);
    },
  );
  const hold = read.value;
  if (!hold) return null;
  const accepted = await runCommand(
    deps.pool,
    { partition: target.partition, clock: deps.clock, deadline: context.deadline },
    async (tx) => {
      const receiverEpoch = await epoch(tx);
      if (create)
        await tx.query(
          `INSERT INTO semantic.record_purge_receiving
       (partition_no,receiving_id,source_key,deletion_generation,hold_id,source_partition,source_epoch,
        receiver_epoch,source,source_transaction_id,accepted_transaction_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
          [
            target.partition,
            target.receivingId,
            id.key,
            ref.deletionGeneration,
            hold.hold_id,
            id.partition,
            hold.source_epoch,
            receiverEpoch,
            hold.source,
            hold.transaction_id,
            currentCommand(tx).transactionId,
          ],
        );
      const row = (
        await tx.query<{
          hold_id: string;
          source: RecordPurgeSource;
          receiver_epoch: number;
          source_epoch: number;
          source_transaction_id: string;
        }>(
          `SELECT hold_id,source,receiver_epoch,source_epoch,source_transaction_id FROM semantic.record_purge_receiving
       WHERE partition_no=$1 AND receiving_id=$2 AND source_key=$3 AND deletion_generation=$4 FOR UPDATE`,
          [target.partition, target.receivingId, id.key, ref.deletionGeneration],
        )
      ).rows[0];
      if (!row) return noEffect(false);
      if (row.receiver_epoch !== receiverEpoch) throw new CommandUnavailableError('moved', target.partition);
      if (
        row.hold_id !== hold.hold_id ||
        row.source_epoch !== hold.source_epoch ||
        row.source_transaction_id !== hold.transaction_id ||
        !sameSource(row.source, hold.source)
      )
        throw new Error('record_purge_receiving_custody_changed');
      return noEffect(true);
    },
  );
  return accepted.value
    ? handle({ reference: Object.freeze({ ...hold.source.reference }), key: id.key, holdId: hold.hold_id, target })
    : null;
}
export async function readRecordPurgeReceivingHold(
  deps: RecordPurgeCustodyDependencies,
  ref: NativeRecordPurgeReference,
  targetInput: RecordPurgeReceivingTarget,
  context: RecordPurgeCustodyContext,
): Promise<RecordPurgeReceivingHold | null> {
  const target = targetCopy(targetInput);
  const authority = await prepareRecordPurgeAuthority(deps, ref, context);
  return authority ? acceptCommittedHold(deps, authority, ref, target, context, false) : null;
}
export async function lockRecordPurgeReceivingHold(
  tx: CommandTransaction,
  hold: RecordPurgeReceivingHold,
): Promise<RecordPurgeSource | null> {
  const locator = holds.get(hold);
  if (!locator) throw new TypeError('Record purge receiving hold was not issued by Semantic');
  const { target, reference: ref } = locator;
  const command = currentCommand(tx);
  if (command.partition !== target.partition) throw new RangeError('Record purge receiver is in another home');
  const row = (
    await tx.query<{
      source: RecordPurgeSource;
      receiver_epoch: number;
      accepted_transaction_id: string;
      completion_transaction_id: string | null;
    }>(
      `SELECT source,receiver_epoch,accepted_transaction_id,completion_transaction_id
     FROM semantic.record_purge_receiving WHERE partition_no=$1 AND receiving_id=$2 AND source_key=$3
     AND deletion_generation=$4 AND hold_id=$5
     AND (source->>'purgeAfter')::timestamptz <= $6::timestamptz
     AND (source->>'purgeAfter')::timestamptz = (source->>'deletionCommittedAt')::timestamptz + interval '720 hours'
     FOR UPDATE`,
      [
        target.partition,
        target.receivingId,
        locator.key,
        ref.deletionGeneration,
        locator.holdId,
        authoritativeTimeValue(command.time),
      ],
    )
  ).rows[0];
  if (!row) return null;
  if (row.receiver_epoch !== (await epoch(tx))) throw new CommandUnavailableError('moved', target.partition);
  if (row.accepted_transaction_id === command.transactionId)
    throw new Error('record_purge_receiving_custody_uncommitted');
  if (row.completion_transaction_id !== null) return null;
  if (
    row.source.disposition !== 'ordinary-deletion' ||
    identity(row.source.reference).key !== locator.key ||
    row.source.reference.deletionGeneration !== ref.deletionGeneration
  )
    return null;
  const set = locked.get(tx) ?? new Set<RecordPurgeReceivingHold>();
  set.add(hold);
  locked.set(tx, set);
  return row.source;
}
export function recordRecordPurgeReceivingCompletion(tx: CommandTransaction, hold: RecordPurgeReceivingHold): void {
  const locator = holds.get(hold);
  if (!locator || !locked.get(tx)?.delete(hold))
    throw new TypeError('Record purge completion requires its locked native receiver');
  registerCommandCallback(tx, async (transactionId) => {
    const source = await lockRecordPurgeReceivingHold(tx, hold);
    if (!source) throw new Error('record_purge_receiving_custody_changed');
    const result = await tx.query(
      `UPDATE semantic.record_purge_receiving SET completion_transaction_id=$6
       WHERE partition_no=$1 AND receiving_id=$2 AND source_key=$3 AND deletion_generation=$4 AND hold_id=$5
       AND completion_transaction_id IS NULL`,
      [
        locator.target.partition,
        locator.target.receivingId,
        locator.key,
        locator.reference.deletionGeneration,
        locator.holdId,
        transactionId,
      ],
    );
    if (result.rowCount !== 1) throw new Error('record_purge_receiving_completion_changed');
    locked.get(tx)?.delete(hold);
  });
}
export async function releaseRecordPurgeReceivingHold(
  deps: RecordPurgeCustodyDependencies,
  ref: NativeRecordPurgeReference,
  targetInput: RecordPurgeReceivingTarget,
  context: RecordPurgeCustodyContext,
): Promise<Readonly<{ state: 'pending' | 'released' }>> {
  const target = targetCopy(targetInput),
    id = identity(ref);
  const completed = await runCommand(
    deps.pool,
    { partition: target.partition, clock: deps.clock, deadline: context.deadline },
    async (tx) => {
      const receiverEpoch = await epoch(tx);
      const row = (
        await tx.query<{
          hold_id: string;
          source: RecordPurgeSource;
          source_epoch: number;
          source_transaction_id: string;
        }>(
          `SELECT r.hold_id,r.source,r.source_epoch,r.source_transaction_id FROM semantic.record_purge_receiving r
       JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.completion_transaction_id
         AND b.position=r.completion_position AND b.epoch=r.receiver_epoch
       WHERE r.partition_no=$1 AND r.receiving_id=$2 AND r.source_key=$3 AND r.deletion_generation=$4
         AND r.receiver_epoch=$5 FOR UPDATE OF r`,
          [target.partition, target.receivingId, id.key, ref.deletionGeneration, receiverEpoch],
        )
      ).rows[0];
      return noEffect(row ?? null);
    },
  );
  if (!completed.value) return { state: 'pending' };
  const receipt = completed.value;
  const result = await runCommand(
    deps.pool,
    { partition: id.partition, clock: deps.clock, deadline: context.deadline },
    async (tx) => {
      // Release shares the native writer gate even after an unrelated source becomes ineligible.
      await lockNativeResource(tx, original(ref));
      const hold = await sourceHold(tx, ref, target);
      if (
        !hold ||
        hold.hold_id !== receipt.hold_id ||
        hold.transaction_id !== receipt.source_transaction_id ||
        hold.source_epoch !== receipt.source_epoch ||
        !sameSource(hold.source, receipt.source)
      )
        return noEffect(false);
      if (hold.source_epoch !== (await epoch(tx))) throw new CommandUnavailableError('moved', id.partition);
      await tx.query(`UPDATE semantic.record_purge_hold SET released=true WHERE partition_no=$1 AND hold_id=$2`, [
        id.partition,
        hold.hold_id,
      ]);
      return noEffect(true);
    },
  );
  return { state: result.value ? 'released' : 'pending' };
}

async function lockNativeResource(tx: CommandTransaction, ref: RecordHistorySourceReference): Promise<void> {
  if (ref.kind === 'contribution') {
    const route = routeOf(ref.subjectId)!;
    if (currentCommand(tx).partition !== partitionOf(route)) throw new RangeError('Record source is in another home');
    await tx.query('SELECT subject_id FROM semantic.subject WHERE route=$1 AND subject_id=$2 FOR UPDATE', [
      route,
      ref.subjectId,
    ]);
    await tx.query(
      'SELECT candidate_id FROM semantic.record_lifecycle WHERE route=$1 AND subject_id=$2 AND candidate_id=$3 FOR UPDATE',
      [route, ref.subjectId, ref.candidateId],
    );
    return;
  }
  const id = ref.kind === 'context' ? ref.contextId : ref.zoneId;
  const route = routeOf(id)!;
  if (currentCommand(tx).partition !== partitionOf(route)) throw new RangeError('Record source is in another home');
  const table = ref.kind === 'context' ? 'semantic.context' : 'zones.zone';
  const key = ref.kind === 'context' ? 'context_id' : 'zone_id';
  const rows = await tx.query(`SELECT ${key} FROM ${table} WHERE route=$1 AND ${key}=$2 FOR UPDATE`, [route, id]);
  if (!rows.rows.length) throw new Error('record_purge_native_source_missing');
}
/** Actual source writers enroll ownership before the history serializers run. Root identity alone is
 * associated: mounted Collections and other referenced resources acquire no deletion authority. */
export async function enrollResourceRecordSources(
  tx: CommandTransaction,
  sources: readonly Exclude<RecordHistorySourceReference, { kind: 'contribution' }>[],
  options: Readonly<{ kind: keyof typeof resourceHistoryCommands; birth?: boolean; events?: 0 | 1 }>,
): Promise<void> {
  declareCommandRecordSources(tx, sources);
  const accounts: AccountReference[] = [];
  for (const ref of sources) {
    await lockNativeResource(tx, ref);
    const id = ref.kind === 'context' ? ref.contextId : ref.zoneId,
      route = routeOf(id)!;
    if (ref.kind === 'zone') {
      const owner = (
        await tx.query<{ owner_id: string | null }>('SELECT owner_id FROM zones.zone WHERE route=$1 AND zone_id=$2', [
          route,
          id,
        ])
      ).rows[0]?.owner_id;
      if (owner) accounts.push({ accountRoute: routeOf(owner)!, accountId: owner, roles: ACCOUNT_ROLE_BITS.owner });
    }
    const command = currentCommand(tx),
      key = recordHistorySourceKey(ref);
    const table = ref.kind === 'context' ? 'semantic.context' : 'zones.zone';
    const field = ref.kind === 'context' ? 'recorded_transaction_id' : 'creation_transaction_id';
    const idField = ref.kind === 'context' ? 'context_id' : 'zone_id';
    // A historical/unconverted row can never gain completeness by its first current command.
    await tx.query(
      `INSERT INTO semantic.record_purge_writer(partition_no,source_key,route,kind,resource_id,enrolled,birth_transaction)
       SELECT $1,$2,$3,$4,$5,$7 AND ${field}=$6::uuid,$6::uuid FROM ${table} WHERE route=$3 AND ${idField}=$5
       ON CONFLICT DO NOTHING`,
      [command.partition, key, route, ref.kind, id, command.transactionId, options.birth ?? false],
    );
    const root = (
      await tx.query<{ sealed_cut: string | null }>(
        `SELECT sealed_cut FROM semantic.record_purge_writer WHERE partition_no=$1 AND source_key=$2 FOR UPDATE`,
        [command.partition, key],
      )
    ).rows[0];
    if (!root || root.sealed_cut) throw new Error('record_purge_source_inventory_sealed');
    await tx.query(
      `INSERT INTO semantic.record_purge_command(partition_no,source_key,transaction_id)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [command.partition, key, command.transactionId],
    );
  }
  // Identity roles come only from the actual Access admission, separately from resource ownership.
  await declareCommandHistory(tx, options.kind, {
    response: { artifactType: 'command-receipt/v1', accounts },
    events: Array.from({ length: options.events ?? 1 }, () => ({
      artifactType: 'outbox-event/v1' as const,
      accounts: [],
    })),
  });
}
export async function sealRecordPurgeSourceInventory(
  deps: RecordPurgeCustodyDependencies,
  authority: RecordPurgeAuthority,
  context: RecordPurgeCustodyContext,
): Promise<
  | Readonly<{ state: 'pending'; frontier: string | null; examined: number }>
  | Readonly<{ state: 'sealed'; cut: RecordPurgeInventoryCut; examined: number }>
> {
  const source = await readRecordPurgeAuthoritySource(deps, authority, context);
  if (!source) return { state: 'pending', frontier: null, examined: 0 };
  const id = identity(source.reference);
  const result = await runCommand<{ id: string | null; frontier: string | null; examined: number }>(
    deps.pool,
    { partition: id.partition, deadline: context.deadline, clock: deps.clock },
    async (tx) => {
      const current = await lockRecordPurgeAuthoritySource(tx, authority);
      if (!current) return noEffect({ id: null, frontier: null, examined: 0 });
      const sourceEpoch = await epoch(tx);
      const root = (
        await tx.query<{
          enrolled: boolean;
          frontier: string;
          sealed_cut: string | null;
          sealed_generation: string | null;
          sealed_version: string | null;
          sealed_epoch: number | null;
        }>(
          `SELECT enrolled,frontier::text,sealed_cut,sealed_generation,sealed_version,sealed_epoch FROM semantic.record_purge_writer
       WHERE partition_no=$1 AND source_key=$2 FOR UPDATE`,
          [id.partition, id.key],
        )
      ).rows[0];
      if (!root?.enrolled) return noEffect({ id: null, frontier: null, examined: root ? 1 : 0 });
      if (
        root.sealed_cut &&
        root.sealed_generation === source.reference.deletionGeneration &&
        root.sealed_version === source.sourceVersion &&
        root.sealed_epoch === sourceEpoch
      )
        return noEffect({ id: root.sealed_cut, frontier: root.frontier, examined: 1 });
      const frontier =
        root.sealed_generation === source.reference.deletionGeneration &&
        root.sealed_version === source.sourceVersion &&
        root.sealed_epoch === sourceEpoch
          ? root.frontier
          : '0';
      const page = await tx.query<{ key: string; position: string | null }>(
        `SELECT key::text,position::text FROM semantic.record_purge_command WHERE partition_no=$1 AND source_key=$2
       AND key>$3::bigint ORDER BY key LIMIT 4 FOR UPDATE`,
        [id.partition, id.key, frontier],
      );
      if (page.rows.some((row) => row.position === null))
        return noEffect({ id: null, frontier, examined: page.rows.length });
      const end = page.rows.at(-1)?.key ?? frontier,
        cutId = page.rows.length < 4 ? randomUUID() : null;
      await tx.query(
        `UPDATE semantic.record_purge_writer SET frontier=$3,sealed_generation=$4,sealed_version=$5,sealed_cut=$6,sealed_epoch=$7
      WHERE partition_no=$1 AND source_key=$2`,
        [id.partition, id.key, end, source.reference.deletionGeneration, source.sourceVersion, cutId, sourceEpoch],
      );
      return noEffect({ id: cutId, frontier: end, examined: page.rows.length });
    },
  );
  if (!result.value.id) return { state: 'pending', frontier: result.value.frontier, examined: result.value.examined };
  const cut = Object.freeze(Object.create(null)) as RecordPurgeInventoryCut;
  cuts.set(cut, Object.freeze({ key: id.key, id: result.value.id }));
  return { state: 'sealed', cut, examined: result.value.examined };
}
export async function verifyRecordPurgeSourceInventory(
  tx: CommandTransaction,
  authority: RecordPurgeAuthority,
  cut: RecordPurgeInventoryCut,
): Promise<boolean> {
  const locator = cuts.get(cut);
  if (!locator) throw new TypeError('Record purge inventory cut was not issued by Semantic');
  const source = await lockRecordPurgeAuthoritySource(tx, authority);
  if (!source || identity(source.reference).key !== locator.key) return false;
  const sourceEpoch = await epoch(tx);
  const row = await tx.query(
    `SELECT source_key FROM semantic.record_purge_writer WHERE partition_no=$1 AND source_key=$2
    AND enrolled AND sealed_cut=$3 AND sealed_generation=$4 AND sealed_version=$5 AND sealed_epoch=$6 FOR UPDATE`,
    [
      currentCommand(tx).partition,
      locator.key,
      locator.id,
      source.reference.deletionGeneration,
      source.sourceVersion,
      sourceEpoch,
    ],
  );
  return row.rows.length === 1;
}
