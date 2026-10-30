import type { Pool } from 'pg';
import { currentCommand, noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import type { IdentityJobRef, IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import {
  identityEpochStore,
  IdentityEpochStoreError,
  recordIdentityEpochNativeCommit,
} from '../semantic/identity-epoch-store.ts';
import { prepareBoundedSortKeys } from './bounded-sort-keys.ts';
import { documentActions, validateIndexObservation } from './document.ts';
import { SEARCH_IDENTITY_WRITER_CHANGED } from './identity-epoch-participant-events.ts';
import { readIdentityIndexIncarnation } from './identity-epoch-participant-physical.ts';
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

export type SearchWriterGuard = Readonly<{
  /** Reads fresh Source inside enrollment. No caller body/version or saved positive can be submitted. */
  write(partition: number, ids: readonly string[], obligation: bigint): Promise<void>;
}>;

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
  return {
    async write(partition, input, obligation) {
      if (typeof obligation !== 'bigint' || obligation < 0n)
        throw new TypeError('Search writer requires a native nonnegative obligation');
      const ids = keys(partition, input);
      const incarnation = await readIdentityIndexIncarnation(options.search, options.index);
      const token = crypto.randomUUID();
      const enrollment = await runCommand(options.pool, { partition }, async (tx, context) => {
        const receipt = await native(tx, context.transactionId);
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
        if ((await readIdentityIndexIncarnation(options.search, options.index)) !== incarnation)
          throw unavailable('Search physical index changed before dispatch');
        // Set BEFORE calling the transport: a thrown/lost response says nothing about native application.
        dispatched = true;
        await writeIndexActions(options.search, options.index, actions, { rejectConflicts: true });
        if ((await readIdentityIndexIncarnation(options.search, options.index)) !== incarnation)
          throw unavailable('Search physical index changed after dispatch');
        sourcePosition = snapshot.position;
      } catch (error) {
        // No engine mutation was invoked on this branch. A failed release still retains native custody.
        if (!dispatched) await release();
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
  const incarnation = await readIdentityIndexIncarnation(options.search, options.index);
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
    const decode = (row: typeof previous): SearchIdentityWriterFence => {
      const point = (transactionId: string | null, position: string | null): IdentityNativeReceipt | null =>
        transactionId === null ? null : { partition, epoch: receipt.epoch, transactionId, position: BigInt(position!) };
      return {
        state: row.writer_token === null ? 'closed' : 'draining',
        gate: point(row.closed_transaction_id, row.closed_position)!,
        writer: point(row.writer_transaction_id, row.writer_position),
        settlement: point(row.settled_transaction_id, row.settled_position),
        sourcePosition: row.source_position === null ? null : BigInt(row.source_position),
      };
    };
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
        writer: previous?.writer_transaction_id
          ? {
              partition,
              epoch: receipt.epoch,
              transactionId: previous.writer_transaction_id,
              position: BigInt(previous.writer_position),
            }
          : null,
        settlement: null,
        sourcePosition: null,
      },
      events: changed(),
    };
  });
  return result.value;
}

