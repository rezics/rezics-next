import type { Pool } from 'pg';
import { currentCommand, noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import type { IdentityJobRef, IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import {
  identityEpochStore,
  IdentityEpochStoreError,
  recordIdentityEpochNativeCommit,
} from '../semantic/identity-epoch-store.ts';
import { withReadTransaction } from '../semantic/read.ts';
import gateSql from './writer-guard-gate.sql';
import dispatchSql from './writer-guard-dispatch.sql';
import { prepareBoundedSortKeys } from './bounded-sort-keys.ts';
import { documentActions, validateIndexObservation } from './document.ts';
import { SEARCH_IDENTITY_WRITER_CHANGED } from './identity-epoch-participant-events.ts';
import { readIdentityIndexIncarnation, readSearchWriterPhysicalTarget } from './identity-epoch-participant-physical.ts';
import enroll from './identity-epoch-participant-enroll.sql';
import settle from './identity-epoch-participant-settle.sql';
import fence from './identity-epoch-participant-fence.sql';
import type { OpenSearch } from './opensearch.ts';
import { subjectPartition, type SubjectListingSource, type SubjectSource } from './source.ts';
import { writeIndexActions } from './write-actions.ts';

export const SEARCH_IDENTITY_WRITER_CHUNK = 100;
const changed = () => [{ type: SEARCH_IDENTITY_WRITER_CHANGED, data: {} }];
const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);

function keys(partition: number, ids: readonly string[]): string[] {
  if (ids.length < 1 || ids.length > SEARCH_IDENTITY_WRITER_CHUNK)
    throw new TypeError('Identity writer requires one through 100 raw keys');
  if (ids.some((id) => subjectPartition(id) !== partition) || new Set(ids).size !== ids.length)
    throw new TypeError('Identity writer requires unique keys in its native home');
  return [...ids].sort();
}

async function native(tx: CommandTransaction, transactionId: string): Promise<IdentityNativeReceipt> {
  const command = currentCommand(tx);
  if (command.basis !== null) throw new TypeError('Identity writer is trusted native projection work');
  const owner = await readPartition(tx, command.partition);
  if (!owner || owner.writeState !== 'active') throw unavailable('Search writer home is unavailable');
  // runCommand's final fence commits this exact next component or retries the entire transaction.
  return { partition: command.partition, epoch: owner.epoch, position: owner.position + 1n, transactionId };
}

/** A locator only. All adoption reads retained native rows under the current home owner. */
export type SearchWriterBarrierLocator = Readonly<{ partition: number; token: string }>;
export type SearchWriterBarrier = Readonly<{
  locator: SearchWriterBarrierLocator;
  consumer: string;
  physicalTarget: string;
  writeAlias: string;
  incarnation: string;
  physicalGeneration: number;
  enrollmentGeneration: bigint;
  fenceGeneration: bigint;
  native: IdentityNativeReceipt;
  ordinary: 'draining' | 'drained';
  /** The delivered receiving binding only accepts Library. No Search first-apply proof exists yet. */
  firstApply: 'unavailable';
  prepared: 'unavailable';
}>;
export type SearchRetainedCopy = Readonly<{
  original: string;
  sourcePosition: bigint | null;
  visible: IdentityNativeReceipt | null;
  enrollment: IdentityNativeReceipt | null;
  state: 'enrolled' | 'dispatched' | 'settled' | 'cancelled';
}>;
export type SearchWriterGuard = Readonly<{
  /** No caller body/version or saved positive can be submitted. */
  write(partition: number, ids: readonly string[], obligation: bigint): Promise<void>;
  fenceOriginal(job: IdentityJobRef, original: string): Promise<SearchIdentityWriterFence>;
  /** Closes first absence under the same native gate as enrollment; does not assert population. */
  closeGeneration(partition: number): Promise<SearchWriterBarrier>;
  /** Publication consumes retained state, never fields from a diagnostic read or caller certificate. */
  adoptGenerationPublicationBarrier(locator: SearchWriterBarrierLocator): Promise<SearchWriterBarrier>;
  readRetainedCopies(
    locator: SearchWriterBarrierLocator,
    after: string | null,
  ): Promise<
    Readonly<{
      copies: readonly SearchRetainedCopy[];
      next: string | null;
    }>
  >;
  /** Revokes at most 100 undispatched enrollments. Dispatched uncertainty remains a drain barrier. */
  recoverInterrupted(
    locator: SearchWriterBarrierLocator,
    after: string | null,
  ): Promise<
    Readonly<{
      examined: number;
      revoked: number;
      uncertain: number;
      next: string | null;
    }>
  >;
}>;

type GateRow = {
  consumer: string;
  incarnation: string;
  write_alias: string;
  owner_epoch: number;
  enrollment_generation: string;
  fence_generation: string;
  closed_token: string | null;
  closed_transaction_id: string | null;
  closed_position: string | null;
};
type CopyRow = {
  original_id: string;
  incarnation: string;
  owner_epoch: number;
  writer_token: string | null;
  dispatch_state: SearchRetainedCopy['state'];
  source_position: string | null;
  visible_transaction_id: string | null;
  visible_position: string | null;
  writer_transaction_id: string | null;
  writer_position: string | null;
};

/** Ordinary writer custody, independent of the fixed participant and privacy-reduction continuation.
 * A submitted request with uncertain outcome retains its enrollment indefinitely until native reconciliation.
 * Time, retries, a refreshed 409 or a later physical UUID cannot release that request.
 */
export function createSearchWriterGuard(options: {
  pool: Pool;
  search: OpenSearch;
  index: string;
  consumer: string;
  source: SubjectSource;
  listing: SubjectListingSource;
}): SearchWriterGuard {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.consumer)) throw new TypeError('Invalid Search consumer');
  const match = /subjects-g([1-9][0-9]*)$/.exec(options.index);
  const generation = Number(match?.[1]);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('Invalid physical generation');
  const point = (partition: number, epoch: number, transactionId: string | null, position: string | null) =>
    transactionId === null ? null : { partition, epoch, transactionId, position: BigInt(position!) };
  function locator(value: SearchWriterBarrierLocator, after: string | null = null) {
    if (
      !Number.isInteger(value.partition) ||
      value.partition < 0 ||
      value.partition > 4095 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.token)
    )
      throw new TypeError('Invalid native Search barrier locator');
    if (after !== null && subjectPartition(after) !== value.partition) throw new TypeError('Invalid copy frontier');
  }
  async function gate(tx: CommandTransaction, receipt: IdentityNativeReceipt, incarnation: string, writeAlias: string) {
    const rows = await tx.query(gateSql.sql, [
      receipt.partition,
      options.index,
      options.consumer,
      incarnation,
      receipt.epoch,
      writeAlias,
    ]);
    if (rows.rowCount !== 1) throw unavailable('Search consumer, incarnation or home requires native handoff custody');
    return rows.rows[0]!;
  }
  async function retained(tx: CommandTransaction, value: SearchWriterBarrierLocator) {
    const owner = await readPartition(tx, value.partition);
    const row = (
      await tx.query<GateRow>(
        `SELECT * FROM search.identity_writer_gate WHERE partition_no=$1 AND physical_target=$2 AND closed_token=$3`,
        [value.partition, options.index, value.token],
      )
    ).rows[0];
    if (
      !owner ||
      owner.writeState !== 'active' ||
      !row ||
      row.owner_epoch !== owner.epoch ||
      row.consumer !== options.consumer ||
      owner.position < BigInt(row.closed_position!)
    )
      throw unavailable('Search publication barrier is missing, moved or foreign');
    return row;
  }
  async function inspect(value: SearchWriterBarrierLocator): Promise<SearchWriterBarrier> {
    locator(value);
    const { incarnation, writeAlias } = await readSearchWriterPhysicalTarget(options.search, options.index);
    const barrier = await withReadTransaction(options.pool, async (tx) => {
      const row = await retained(tx, value);
      if (row.incarnation !== incarnation || row.write_alias !== writeAlias)
        throw unavailable('Search publication physical incarnation changed');
      const pending = await tx.query(
        `SELECT original_id FROM search.identity_writer WHERE partition_no=$1 AND physical_target=$2
         AND writer_token IS NOT NULL ORDER BY original_id LIMIT 1`,
        [value.partition, options.index],
      );
      return {
        locator: { partition: value.partition, token: value.token },
        consumer: row.consumer,
        physicalTarget: options.index,
        writeAlias: row.write_alias,
        incarnation: row.incarnation,
        physicalGeneration: generation,
        enrollmentGeneration: BigInt(row.enrollment_generation),
        fenceGeneration: BigInt(row.fence_generation),
        native: point(value.partition, row.owner_epoch, row.closed_transaction_id, row.closed_position)!,
        ordinary: pending.rows.length ? ('draining' as const) : ('drained' as const),
        firstApply: 'unavailable' as const,
        prepared: 'unavailable' as const,
      };
    });
    if ((await readIdentityIndexIncarnation(options.search, options.index)) !== incarnation)
      throw unavailable('Search publication physical incarnation changed during adoption');
    return barrier;
  }
  return {
    fenceOriginal: (job, original) =>
      fenceSearchIdentityWriter(options.pool, { job, original, index: options.index, search: options.search }),
    adoptGenerationPublicationBarrier: inspect,
    async closeGeneration(partition) {
      const { incarnation, writeAlias } = await readSearchWriterPhysicalTarget(options.search, options.index);
      const token = crypto.randomUUID();
      const closed = await runCommand(options.pool, { partition }, async (tx, context) => {
        const receipt = await native(tx, context.transactionId);
        const row = await gate(tx, receipt, incarnation, writeAlias);
        if (row.closed_token) return noEffect(row.closed_token);
        await tx.query(
          `UPDATE search.identity_writer_gate SET closed_token=$3,closed_transaction_id=$4,
          closed_position=$5,fence_generation=fence_generation+1 WHERE partition_no=$1 AND physical_target=$2`,
          [partition, options.index, token, receipt.transactionId, receipt.position.toString()],
        );
        return { value: token, events: changed() };
      });
      return inspect({ partition, token: closed.value });
    },
    async readRetainedCopies(value, after) {
      locator(value, after);
      return withReadTransaction(options.pool, async (tx) => {
        const target = await retained(tx, value);
        const rows = (
          await tx.query<CopyRow>(
            `SELECT original_id::text,source_position,visible_transaction_id,
          visible_position,writer_transaction_id,writer_position,writer_token,dispatch_state,owner_epoch,incarnation
          FROM search.identity_writer WHERE partition_no=$1 AND physical_target=$2
          AND ($3::uuid IS NULL OR original_id>$3) ORDER BY original_id LIMIT 100`,
            [value.partition, options.index, after],
          )
        ).rows;
        if (rows.some((row) => row.owner_epoch !== target.owner_epoch || row.incarnation !== target.incarnation))
          throw unavailable('Retained Search copy requires native handoff custody');
        return {
          copies: rows.map((row) => ({
            original: row.original_id,
            state: row.dispatch_state,
            sourcePosition: row.source_position === null ? null : BigInt(row.source_position),
            visible: point(value.partition, row.owner_epoch, row.visible_transaction_id, row.visible_position),
            enrollment:
              row.writer_token === null
                ? null
                : point(value.partition, row.owner_epoch, row.writer_transaction_id, row.writer_position),
          })),
          next: rows.length === 100 ? rows.at(-1)!.original_id : null,
        };
      });
    },
    async recoverInterrupted(value, after) {
      locator(value, after);
      const result = await runCommand(options.pool, { partition: value.partition }, async (tx, context) => {
        const receipt = await native(tx, context.transactionId);
        const target = await retained(tx, value);
        await gate(tx, receipt, target.incarnation, target.write_alias);
        const rows = (
          await tx.query<CopyRow>(
            `SELECT original_id::text,dispatch_state,owner_epoch,incarnation FROM search.identity_writer
          WHERE partition_no=$1 AND physical_target=$2 AND writer_token IS NOT NULL
          AND ($3::uuid IS NULL OR original_id>$3) ORDER BY original_id LIMIT 100 FOR UPDATE`,
            [value.partition, options.index, after],
          )
        ).rows;
        if (rows.some((row) => row.owner_epoch !== target.owner_epoch || row.incarnation !== target.incarnation))
          throw unavailable('Interrupted Search writer requires native handoff custody');
        const revocable = rows.filter((row) => row.dispatch_state === 'enrolled').map((row) => row.original_id);
        if (revocable.length)
          await tx.query(
            `UPDATE search.identity_writer SET writer_token=NULL,dispatch_state='cancelled',
          settled_transaction_id=$4,settled_position=$5 WHERE partition_no=$1 AND physical_target=$2
          AND original_id=ANY($3::uuid[]) AND dispatch_state='enrolled'`,
            [value.partition, options.index, revocable, receipt.transactionId, receipt.position.toString()],
          );
        const progress = {
          examined: rows.length,
          revoked: revocable.length,
          uncertain: rows.length - revocable.length,
          next: rows.length === 100 ? rows.at(-1)!.original_id : null,
        };
        return revocable.length ? { value: progress, events: changed() } : noEffect(progress);
      });
      return result.value;
    },
    async write(partition, input, obligation) {
      if (typeof obligation !== 'bigint' || obligation < 0n)
        throw new TypeError('Search writer requires a native nonnegative obligation');
      const ids = keys(partition, input);
      const { incarnation, writeAlias } = await readSearchWriterPhysicalTarget(options.search, options.index);
      const token = crypto.randomUUID();
      const enrollment = await runCommand(options.pool, { partition }, async (tx, context) => {
        const receipt = await native(tx, context.transactionId);
        const target = await gate(tx, receipt, incarnation, writeAlias);
        if (target.closed_token) throw unavailable('Search generation is closed to writer enrollment');
        await tx.query(
          `UPDATE search.identity_writer_gate SET enrollment_generation=enrollment_generation+1
          WHERE partition_no=$1 AND physical_target=$2`,
          [partition, options.index],
        );
        const result = await tx.query(enroll.sql, [
          partition,
          options.index,
          incarnation,
          receipt.epoch,
          token,
          receipt.transactionId,
          receipt.position.toString(),
          ids,
        ]);
        if (result.rowCount !== ids.length)
          throw unavailable('Search writer is enrolled, structurally closed, or awaiting owner custody');
        return { value: receipt, events: changed() };
      });
      const receipt = enrollment.value;
      let dispatched = false;
      let revoked = false;
      let sourcePosition: bigint | null = null;
      const release = async () => {
        await runCommand(options.pool, { partition }, async (tx, context) => {
          const completion = await native(tx, context.transactionId);
          if (completion.epoch !== receipt.epoch) throw unavailable('Search writer owner changed before custody');
          const result = await tx.query(settle.sql, [
            partition,
            options.index,
            incarnation,
            receipt.epoch,
            token,
            receipt.transactionId,
            receipt.position.toString(),
            ids,
            completion.transactionId,
            completion.position.toString(),
            sourcePosition?.toString() ?? null,
          ]);
          if (result.rowCount !== ids.length) throw unavailable('Search writer enrollment changed before custody');
          return { value: null, events: changed() };
        });
      };
      try {
        const snapshot = await options.source.read(partition, ids);
        const floor = receipt.position > obligation ? receipt.position : obligation;
        const subjects = validateIndexObservation(snapshot, partition, ids, floor);
        const visible = ids.filter((id) => {
          const subject = subjects.get(id);
          return subject?.visibility === 'visible' && subject.redirect === null;
        });
        const counts = visible.length ? await options.listing.read(partition, visible) : undefined;
        const actions = await prepareBoundedSortKeys(
          options.search,
          options.index,
          documentActions(snapshot, ids, counts),
        );
        const current = await readSearchWriterPhysicalTarget(options.search, options.index);
        if (current.incarnation !== incarnation || current.writeAlias !== writeAlias)
          throw unavailable('Search physical index changed before dispatch');
        // Native CAS makes pre-dispatch recovery revoke a delayed continuation before external I/O.
        await runCommand(options.pool, { partition }, async (tx, context) => {
          const dispatch = await native(tx, context.transactionId);
          if (dispatch.epoch !== receipt.epoch) throw unavailable('Search writer home changed before dispatch');
          await gate(tx, dispatch, incarnation, writeAlias);
          const result = await tx.query(dispatchSql.sql, [
            partition,
            options.index,
            incarnation,
            receipt.epoch,
            token,
            ids,
          ]);
          if (result.rowCount !== ids.length) {
            revoked = true;
            throw unavailable('Search writer was revoked before dispatch');
          }
          return { value: null, events: changed() };
        });
        // Set BEFORE calling the transport: a thrown/lost response says nothing about native application.
        dispatched = true;
        await writeIndexActions(options.search, options.index, actions, { rejectConflicts: true, writeAlias });
        const observed = await readSearchWriterPhysicalTarget(options.search, options.index);
        if (observed.incarnation !== incarnation || observed.writeAlias !== writeAlias)
          throw unavailable('Search physical index changed after dispatch');
        sourcePosition = snapshot.position;
      } catch (error) {
        // No engine mutation was invoked on this branch. A failed release still retains native custody.
        if (!dispatched && !revoked) await release();
        throw error;
      }
      // Source and engine have released before this one-home native command. Failure retains enrollment.
      await release();
    },
  };
}

export type SearchIdentityWriterFence = Readonly<{
  state: 'draining' | 'closed';
  gate: IdentityNativeReceipt;
  writer: IdentityNativeReceipt | null;
  settlement: IdentityNativeReceipt | null;
  sourcePosition: bigint | null;
}>;

/** Install the real home-local structural close, including first absence, and observe in-flight custody.
 * This is a local operational record, NEVER a fixed participant completion or a complete-support proof.
 * There is deliberately no timeout, force-release, caller completion flag or reopen method.
 */
export async function fenceSearchIdentityWriter(
  pool: Pool,
  options: Readonly<{ job: IdentityJobRef; original: string; index: string; search: OpenSearch }>,
): Promise<SearchIdentityWriterFence> {
  const partition = subjectPartition(options.original);
  const { incarnation } = await readSearchWriterPhysicalTarget(options.search, options.index);
  const result = await runCommand(pool, { partition }, async (tx, context) => {
    await identityEpochStore.admitHomeEffect(tx, { kind: 'structural', job: options.job, original: options.original });
    const receipt = await native(tx, context.transactionId);
    const previous = (
      await tx.query(
        `SELECT * FROM search.identity_writer
       WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3 FOR UPDATE`,
        [partition, options.index, options.original],
      )
    ).rows[0];
    if (previous && (previous.owner_epoch !== receipt.epoch || previous.incarnation !== incarnation))
      throw unavailable('Search writer incarnation or home requires native handoff custody');
    const point = (transactionId: string | null, position: string | null): IdentityNativeReceipt | null =>
      transactionId === null ? null : { partition, epoch: receipt.epoch, transactionId, position: BigInt(position!) };
    const decode = (row: typeof previous): SearchIdentityWriterFence => ({
      state: row.writer_token === null ? 'closed' : 'draining',
      gate: point(row.closed_transaction_id, row.closed_position)!,
      writer: row.writer_token === null ? null : point(row.writer_transaction_id, row.writer_position),
      settlement: point(row.settled_transaction_id, row.settled_position),
      sourcePosition: row.source_position === null ? null : BigInt(row.source_position),
    });
    if (previous?.closed_job) {
      if (previous.closed_job !== options.job.jobId || BigInt(previous.closed_epoch) !== options.job.epoch)
        throw unavailable('Search writer is closed for another native identity job');
      return noEffect(decode(previous));
    }
    const written = await tx.query(fence.sql, [
      partition,
      options.index,
      options.original,
      incarnation,
      receipt.epoch,
      options.job.jobId,
      options.job.epoch.toString(),
      receipt.transactionId,
      receipt.position.toString(),
    ]);
    if (written.rowCount !== 1) throw unavailable('Search writer structural close raced enrollment or handoff');
    recordIdentityEpochNativeCommit(tx, 'search-canonical-index');
    return {
      value: {
        state: previous?.writer_token ? ('draining' as const) : ('closed' as const),
        gate: receipt,
        writer: previous?.writer_token ? point(previous.writer_transaction_id, previous.writer_position) : null,
        settlement: previous ? point(previous.settled_transaction_id, previous.settled_position) : null,
        sourcePosition: previous?.source_position == null ? null : BigInt(previous.source_position),
      },
      events: changed(),
    };
  });
  return result.value;
}
