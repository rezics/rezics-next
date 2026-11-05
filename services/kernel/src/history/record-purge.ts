import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import {
  lockRecordPurgeAuthoritySource,
  readRecordPurgeAuthoritySource,
  type RecordPurgeAuthority,
  type RecordPurgeSource,
} from '../semantic/record-purge-authority.ts';
import { sameRecordPurgeSource, type RecordHistoryLocalJob } from './record-source-lock.ts';
import { recordHistoryPurgeLocator } from './record-resource-adapter.ts';
import { minimizeHistoryReceipt } from './receipt.ts';
import { minimizeHistoryOutbox } from './outbox.ts';
import { minimizeRecordHistoryWork } from './durable.ts';
import { nativeRecordPurgeCustody } from './record-native-custody.ts';
import {
  enrollRecordHistorySourceSets,
  prepareRecordHistorySourceSetPage,
  readRecordHistorySourceSetCopies,
  recordRecordHistoryCopyProgress,
  type RecordHistoryCopy,
} from './record-source-set-inventory.ts';

export type RecordHistoryPurgeDependencies = Readonly<{ pool: Pool; clock?: () => Date }>;
export type RecordHistoryPurgeContext = Readonly<{ deadline: number }>;
declare const recordHistoryPurge: unique symbol;
export type PreparedRecordHistoryPurge = { readonly [recordHistoryPurge]: true };
export type RecordHistoryPurgeResult = Readonly<{
  state: 'pending' | 'progress' | 'complete';
  examined: number;
  minimized: number;
}>;
type Binding = Readonly<{
  pool: Pool;
  authority: RecordPurgeAuthority;
  source: RecordPurgeSource;
  key: string;
  partition: number;
  deadline: number;
}>;
const issued = new WeakMap<PreparedRecordHistoryPurge, Binding>();

export async function prepareRecordHistoryPurge(
  deps: RecordHistoryPurgeDependencies,
  authority: RecordPurgeAuthority,
  context: RecordHistoryPurgeContext,
): Promise<PreparedRecordHistoryPurge | null> {
  const deadline = context.deadline;
  // Native source errors remain unavailable. Only native lifecycle ineligibility produces null.
  const source = await readRecordPurgeAuthoritySource(deps, authority, { deadline });
  if (!source) return null;
  const locator = recordHistoryPurgeLocator(source.reference);
  const partition = locator.partition_no;
  const key = locator.source_key;
  const saved = await runCommand(deps.pool, { partition, deadline, clock: deps.clock }, async (tx) => {
    const current = await lockRecordPurgeAuthoritySource(tx, authority);
    if (!current || !sameRecordPurgeSource(current, source)) return noEffect(false);
    await tx.query(
      `INSERT INTO core.record_history_purge
       (source_key,deletion_generation,partition_no,reference_kind,resource_id,subject_id,candidate_id,revision,document_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [
        key,
        locator.deletion_generation,
        partition,
        locator.reference_kind,
        locator.resource_id,
        locator.subject_id,
        locator.candidate_id,
        locator.revision,
        locator.document_id,
      ],
    );
    return noEffect(true);
  });
  if (!saved.value) return null;
  const handle = Object.freeze(Object.create(null)) as PreparedRecordHistoryPurge;
  issued.set(handle, Object.freeze({ pool: deps.pool, authority, source, key, partition, deadline }));
  return handle;
}

async function minimizeCopy(
  tx: import('../command/command.ts').CommandTransaction,
  job: RecordHistoryLocalJob,
  copy: RecordHistoryCopy,
): Promise<string | null> {
  return copy.artifact_type === 'command-receipt/v1'
    ? minimizeHistoryReceipt(tx, job, copy.locator)
    : copy.artifact_type === 'outbox-event/v1'
      ? minimizeHistoryOutbox(tx, job, copy.locator)
      : minimizeRecordHistoryWork(tx, job, copy.locator);
}

/** Stable receiver locator, not an invented native source ID or authority. Restart recomputes
 * it from immutable native source disposition and exact generated artifact identity. */
function receivingTarget(saved: Binding, copy: RecordHistoryCopy) {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify([
      saved.key,
      saved.source.reference.deletionGeneration,
      saved.source.sourceVersion,
      saved.source.deletionTransactionId,
      copy.partition_no,
      copy.artifact_type,
      copy.locator.toString('hex'),
      copy.sourceSet?.locator.partition ?? null,
      copy.sourceSet?.locator.transactionId ?? null,
      copy.sourceSet?.locator.revision ?? null,
    ]),
  );
  // The native custody target is a UUID. Keep deterministic restart identity while using
  // its actual declared codec, rather than the provisional 64-character digest.
  const id = hash.digest('hex').slice(0, 32);
  return {
    partition: copy.partition_no,
    receivingId: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
  };
}

/** Release requires Source's verified native receiving completion. Neither the returned
 * minimizer result nor a local 'minimized' association can release a Source hold. */
async function releaseReceiving(
  deps: RecordHistoryPurgeDependencies,
  saved: Binding,
  copy: RecordHistoryCopy,
  context: RecordHistoryPurgeContext,
): Promise<boolean> {
  const custody = await nativeRecordPurgeCustody();
  if (!custody) return false;
  const released = await custody.releaseRecordPurgeReceivingHold(
    deps,
    saved.source.reference,
    receivingTarget(saved, copy),
    context,
  );
  if (released.state !== 'released') return false;
  await runCommand(
    deps.pool,
    { partition: copy.partition_no, deadline: context.deadline, clock: deps.clock },
    async (tx) => {
      await recordRecordHistoryCopyProgress(tx, saved.key, copy, null);
      return noEffect(undefined);
    },
  );
  return true;
}

async function minimizeReceiving(
  deps: RecordHistoryPurgeDependencies,
  saved: Binding,
  copy: RecordHistoryCopy,
  context: RecordHistoryPurgeContext,
): Promise<RecordHistoryPurgeResult> {
  const custody = await nativeRecordPurgeCustody();
  if (!custody) return { state: 'pending', examined: 0, minimized: 0 };
  // This branch also repairs a crash after native release but before local release progress.
  if (copy.gap === 'record-source-native-release-pending') {
    await releaseReceiving(deps, saved, copy, context);
    return { state: 'pending', examined: 0, minimized: 0 };
  }
  const target = receivingTarget(saved, copy);
  const hold =
    (await custody.readRecordPurgeReceivingHold(deps, saved.source.reference, target, context)) ??
    (await custody.prepareRecordPurgeReceivingHold(deps, saved.authority, target, context));
  if (!hold) return { state: 'pending', examined: 0, minimized: 0 };
  // All source checkouts have ended. The target lock must validate durable accepted Source
  // custody/current receiver epoch, not use the released source transaction or authority.
  const receiving = await runCommand<RecordHistoryPurgeResult>(
    deps.pool,
    { partition: copy.partition_no, deadline: context.deadline, clock: deps.clock },
    async (tx) => {
      const source = await custody.lockRecordPurgeReceivingHold(tx, hold);
      if (!source || !sameRecordPurgeSource(source, saved.source))
        return noEffect({ state: 'pending' as const, examined: 0, minimized: 0 });
      const pending = await minimizeCopy(
        tx,
        {
          partition_no: copy.partition_no,
          authority: saved.authority,
          receivingHold: hold,
          expectedSource: saved.source,
          ...(copy.sourceSet ? { sourceSet: copy.sourceSet } : {}),
        },
        copy,
      );
      if (pending !== null) {
        await recordRecordHistoryCopyProgress(tx, saved.key, copy, pending);
        return noEffect({ state: 'pending' as const, examined: 0, minimized: 0 });
      }
      await recordRecordHistoryCopyProgress(tx, saved.key, copy, 'record-source-native-release-pending', true);
      custody.recordRecordPurgeReceivingCompletion(tx, hold);
      // The existing native maintenance event supplies a real committed command position for
      // Source's completion callback. No payload or source-member vector is copied into it.
      return {
        value: { state: 'progress' as const, examined: 0, minimized: 1 },
        events: [{ type: 'com.rezics.history.minimized.v1', data: {} }],
      };
    },
  );
  if (receiving.value.minimized) await releaseReceiving(deps, saved, copy, context);
  return receiving.value;
}

/** One bounded source selection and at most one physical effect. Source and receiving homes
 * never retain checkouts together. Partial inventories still permit useful local cleanup. */
export async function minimizeRecordHistoryPurge(
  deps: RecordHistoryPurgeDependencies,
  preparation: PreparedRecordHistoryPurge,
  context: RecordHistoryPurgeContext,
): Promise<RecordHistoryPurgeResult> {
  const saved = issued.get(preparation);
  if (!saved || saved.pool !== deps.pool) throw new TypeError('Record history preparation was not issued here');
  const boundedContext = { deadline: Math.min(context.deadline, saved.deadline) };
  const custody = await nativeRecordPurgeCustody();
  const inventory = await custody?.sealRecordPurgeSourceInventory(deps, saved.authority, boundedContext);
  const setPage = await prepareRecordHistorySourceSetPage(
    deps,
    saved.authority,
    saved.source,
    saved.key,
    saved.partition,
    boundedContext,
  );
  const outcome = await runCommand(
    deps.pool,
    { partition: saved.partition, deadline: boundedContext.deadline, clock: deps.clock },
    async (tx) => {
      const source = await lockRecordPurgeAuthoritySource(tx, saved.authority);
      if (!source || !sameRecordPurgeSource(source, saved.source))
        return noEffect({ result: { state: 'pending' as const, examined: 0, minimized: 0 }, foreign: null });
      await tx.query(
        `SELECT source_key FROM core.record_history_purge WHERE source_key=$1 AND deletion_generation=$2 FOR UPDATE`,
        [saved.key, source.reference.deletionGeneration],
      );
      const setGap = await enrollRecordHistorySourceSets(tx, saved.key, source.reference.deletionGeneration, setPage);
      const page = await tx.query<RecordHistoryCopy>(
        `SELECT partition_no,artifact_type,locator,gap FROM core.record_history_locator
         WHERE source_key=$1 AND (state='pending' OR gap='record-source-native-release-pending') AND next_attempt<=now()
         ORDER BY next_attempt,partition_no,artifact_type,locator LIMIT 8`,
        [saved.key],
      );
      const sets = await readRecordHistorySourceSetCopies(
        tx,
        saved.key,
        source.reference.deletionGeneration,
        8 - page.rows.length,
      );
      const copies = [...page.rows, ...sets];
      const copy = copies.find((row) => row.partition_no === saved.partition) ?? copies[0];
      let gap = setGap ?? 'record-original-producer-coverage-unsealed';
      if (inventory?.state === 'sealed') {
        if (!custody || !(await custody.verifyRecordPurgeSourceInventory(tx, saved.authority, inventory.cut)))
          gap = 'record-native-source-inventory-cut-unproven';
        else gap = setGap ?? 'record-history-copy-inventory-unsealed';
      } else if (custody) gap = 'record-native-source-inventory-unsealed';
      let minimized = 0;
      if (copy && copy.partition_no === saved.partition) {
        const pending = await minimizeCopy(
          tx,
          {
            partition_no: saved.partition,
            authority: saved.authority,
            ...(copy.sourceSet ? { sourceSet: copy.sourceSet } : {}),
          },
          copy,
        );
        gap = pending ?? gap;
        minimized = pending === null ? 1 : 0;
        await recordRecordHistoryCopyProgress(tx, saved.key, copy, pending);
      } else if (copy && !custody) gap = 'record-source-bound-foreign-custody-unavailable';
      await tx.query(
        `UPDATE core.record_history_purge SET gap=$3,next_run=now()+interval '30 seconds'
         WHERE source_key=$1 AND deletion_generation=$2`,
        [saved.key, source.reference.deletionGeneration, gap],
      );
      // A native Source cut is distinct from sealed all-copy/receiving inventory and native
      // consumer closure. Unconverted historical writers and genuine term authority stay pending.
      return noEffect({
        result: {
          state: minimized ? ('progress' as const) : ('pending' as const),
          examined: copies.length + (inventory?.examined ?? 0),
          minimized,
        },
        foreign: copy && copy.partition_no !== saved.partition ? copy : null,
      });
    },
  );
  if (!outcome.value.foreign) return outcome.value.result;
  const receiving = await minimizeReceiving(deps, saved, outcome.value.foreign, boundedContext);
  return { ...receiving, examined: outcome.value.result.examined + receiving.examined };
}
