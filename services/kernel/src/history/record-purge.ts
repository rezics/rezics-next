import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import {
  lockRecordPurgeAuthoritySource,
  readRecordPurgeAuthoritySource,
  type RecordPurgeAuthority,
  type RecordPurgeSource,
} from '../semantic/record-purge-authority.ts';
import { purgeSourceKey } from './record-source-lock.ts';
import { recordHistoryPurgeLocator } from './record-resource-adapter.ts';
import { minimizeHistoryReceipt } from './receipt.ts';
import { minimizeHistoryOutbox } from './outbox.ts';
import { minimizeRecordHistoryWork } from './durable.ts';
import type { HistoryArtifactType } from './contracts.ts';

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

function sameSource(a: RecordPurgeSource, b: RecordPurgeSource): boolean {
  const x = a.reference,
    y = b.reference;
  return (
    a.disposition === b.disposition &&
    a.sourceVersion === b.sourceVersion &&
    a.deletionTransactionId === b.deletionTransactionId &&
    a.deletionCommittedAt === b.deletionCommittedAt &&
    a.purgeAfter === b.purgeAfter &&
    x.deletionGeneration === y.deletionGeneration &&
    purgeSourceKey(a) === purgeSourceKey(b)
  );
}

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
    if (!current || !sameSource(current, source)) return noEffect(false);
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

/** One real physical effect and its local progress share the source transaction. Partial producer
 * coverage and foreign custody never prevent independent known local copies from progressing. */
export async function minimizeRecordHistoryPurge(
  deps: RecordHistoryPurgeDependencies,
  preparation: PreparedRecordHistoryPurge,
  context: RecordHistoryPurgeContext,
): Promise<RecordHistoryPurgeResult> {
  const saved = issued.get(preparation);
  if (!saved || saved.pool !== deps.pool) throw new TypeError('Record history preparation was not issued here');
  const outcome = await runCommand(
    deps.pool,
    {
      partition: saved.partition,
      deadline: Math.min(context.deadline, saved.deadline),
      clock: deps.clock,
    },
    async (tx) => {
      const source = await lockRecordPurgeAuthoritySource(tx, saved.authority);
      if (!source || !sameSource(source, saved.source))
        return noEffect({ state: 'pending' as const, examined: 0, minimized: 0 });
      await tx.query(
        `SELECT source_key FROM core.record_history_purge WHERE source_key=$1 AND deletion_generation=$2 FOR UPDATE`,
        [saved.key, source.reference.deletionGeneration],
      );
      const page = await tx.query<{ partition_no: number; artifact_type: HistoryArtifactType; locator: Buffer }>(
        `SELECT partition_no,artifact_type,locator FROM core.record_history_locator
       WHERE source_key=$1 AND state='pending' AND next_attempt<=now()
       ORDER BY next_attempt,partition_no,artifact_type,locator LIMIT 8 FOR UPDATE`,
        [saved.key],
      );
      // Prefer an available co-located copy within this bounded page.
      const copy = page.rows.find((row) => row.partition_no === saved.partition) ?? page.rows[0];
      let gap = 'record-original-producer-coverage-unsealed';
      let minimized = 0;
      if (copy) {
        let pending: string | null = 'record-source-bound-foreign-custody-unavailable';
        if (copy.partition_no === saved.partition) {
          const job = { partition_no: saved.partition, authority: saved.authority };
          pending =
            copy.artifact_type === 'command-receipt/v1'
              ? await minimizeHistoryReceipt(tx, job, copy.locator)
              : copy.artifact_type === 'outbox-event/v1'
                ? await minimizeHistoryOutbox(tx, job, copy.locator)
                : await minimizeRecordHistoryWork(tx, job, copy.locator);
        }
        gap = pending ?? gap;
        minimized = pending === null ? 1 : 0;
        await tx.query(
          `UPDATE core.record_history_locator SET state=$5,gap=$6,next_attempt=now()+interval '30 seconds'
         WHERE source_key=$1 AND partition_no=$2 AND artifact_type=$3 AND locator=$4`,
          [
            saved.key,
            copy.partition_no,
            copy.artifact_type,
            copy.locator,
            minimized ? 'minimized' : 'pending',
            pending,
          ],
        );
      }
      await tx.query(
        `UPDATE core.record_history_purge SET gap=$3,next_run=now()+interval '30 seconds'
       WHERE source_key=$1 AND deletion_generation=$2`,
        [saved.key, source.reference.deletionGeneration, gap],
      );
      // No writer has sealed historical coverage/finite source cut yet. EOF is not absence.
      return noEffect({
        state: minimized ? ('progress' as const) : ('pending' as const),
        examined: page.rows.length,
        minimized,
      });
    },
  );
  return outcome.value;
}
