import { AsyncLocalStorage } from 'node:async_hooks';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  currentCommand,
  currentCommandResources,
  noEffect,
  runCommand,
  withSingleCommandAttempt,
  type CommandTransaction,
} from '../command/command.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import type { HistoryRegistry } from '../history/registry.ts';
import type { WorkClient } from '../work/client.ts';
import { routeOf } from '../route/route.ts';
import { withConnection } from '../database/pool.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';

// This selected original has always had an absolute five-second lifetime.
export const IDENTITY_ORIGINAL_DEADLINE_MS = 5000;

export const ORIGINAL_AXES = Object.freeze([
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
  'emptySeeks',
] as const satisfies readonly (keyof WorkDimensions)[]);

/** A local SQL declaration. An absent child declaration is represented separately, never by zero. */
export function originalControlWork(
  rows: number,
  points: number,
  statements: number,
  bytes: number,
  emptySeeks = 0,
): WorkDimensions {
  const work = {
    candidateKeys: 0,
    nativeRows: rows,
    identityMetadataRows: 0,
    nativePoints: points,
    witnessKeys: 0,
    statements,
    bytes,
    emptySeeks,
  };
  originalWorkVector(work);
  return Object.freeze(work);
}

export function originalWorkVector(work: WorkDimensions): readonly number[] {
  if (
    !work ||
    typeof work !== 'object' ||
    Reflect.ownKeys(work).length !== ORIGINAL_AXES.length ||
    ORIGINAL_AXES.some((axis) => !Object.hasOwn(work, axis))
  )
    throw new RangeError('Invalid identity original work dimensions');
  // Validate the exact snapshot that will be encoded. Accessors must not substitute a
  // different value between validation and the durable bigint[] parameter.
  const values = ORIGINAL_AXES.map((axis) => work[axis]);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new RangeError('Invalid identity original work dimensions');
  return Object.freeze(values);
}

export function sumOriginalControl(...parts: readonly WorkDimensions[]): WorkDimensions {
  const values = ORIGINAL_AXES.map(() => 0);
  for (const part of parts)
    originalWorkVector(part).forEach((value, index) => {
      values[index]! += value;
      if (!Number.isSafeInteger(values[index])) throw new RangeError('Identity original work overflow');
    });
  return Object.freeze(
    Object.fromEntries(ORIGINAL_AXES.map((axis, index) => [axis, values[index]!])) as unknown as WorkDimensions,
  );
}

// runCommand(noEffect), no Actor, receipt, authorization, callbacks, events or internal retry.
// BEGIN, settings x2, time, final setting, no-effect native fence, COMMIT, failure ROLLBACK.
export const ORIGINAL_NATIVE_CONTROL = originalControlWork(3, 1, 8, 256);
export const HISTORY_ORIGINAL_CONTROL = Object.freeze({
  discovery: originalControlWork(1, 1, 1, 64, 1),
  native: ORIGINAL_NATIVE_CONTROL,
  registry: originalControlWork(1, 1, 1, 128, 1),
  select: originalControlWork(1, 1, 1, 2048, 1),
  barrier: originalControlWork(1, 1, 1, 128, 1),
  previous: originalControlWork(1, 1, 1, 4096, 1),
  insert: originalControlWork(1, 1, 1, 4096),
  lease: originalControlWork(1, 1, 1, 0),
});
// This is ONLY admission/selection. It deliberately does not purport to price advanceSharedHistory.
export const HISTORY_ORIGINAL_SELECTION = sumOriginalControl(...Object.values(HISTORY_ORIGINAL_CONTROL));
export const HISTORY_ORIGINAL_VALIDATION = sumOriginalControl(
  ORIGINAL_NATIVE_CONTROL,
  originalControlWork(1, 1, 1, 4096, 1),
  originalControlWork(1, 1, 1, 2048, 1),
  originalControlWork(1, 1, 1, 128, 1),
  originalControlWork(1, 1, 1, 128, 1),
);
export const HISTORY_ORIGINAL_SETTLEMENT = sumOriginalControl(
  ORIGINAL_NATIVE_CONTROL,
  originalControlWork(1, 1, 1, 2048, 1),
  originalControlWork(1, 1, 1, 0),
  originalControlWork(1, 1, 1, 0),
);

/** Closed local part of advanceSharedHistory, ending BEFORE any minimizer/readiness/receiving
 * child. Alternative local branches are reserved inclusively. The eight-row page still selects
 * only its first artifact. History seal's family trigger has its own fixed nine-family bound. */
export const HISTORY_SELECTED_LOCAL_CONTROL = Object.freeze({
  transaction: originalControlWork(0, 0, 5, 0), // BEGIN, settings x2, COMMIT, failed ROLLBACK
  job: originalControlWork(1, 1, 1, 4096, 1),
  dispatchPosition: originalControlWork(2, 2, 1, 4224, 2),
  barrier: originalControlWork(1, 1, 1, 128, 1),
  partition: originalControlWork(1, 1, 1, 128, 1),
  // erasure SELECT + seal upsert + two native FK points; scope_changed -> family_touch:
  // erasure point, fence upsert/FK, nine coverage rows. No artifact trigger on this table.
  seal: sumOriginalControl(originalControlWork(4, 4, 3, 0), originalControlWork(12, 12, 4, 0)),
  progressInsert: originalControlWork(3, 3, 3, 0), // insert plus partition/erasure FK checks
  progressLock: originalControlWork(1, 1, 1, 128, 1),
  epochReset: originalControlWork(2, 2, 2, 0),
  gapReset: originalControlWork(1, 1, 1, 0),
  page: originalControlWork(8, 1, 1, 4096, 1),
  applicable: originalControlWork(2, 2, 2, 0),
  classify: originalControlWork(1, 1, 1, 128, 1),
  unavailableHome: originalControlWork(2, 2, 2, 0),
  emptyProgress: originalControlWork(1, 1, 1, 0),
  emptySeal: sumOriginalControl(originalControlWork(2, 2, 1, 0), originalControlWork(12, 12, 4, 0)),
  nextHome: originalControlWork(1, 1, 1, 0),
  phaseChange: originalControlWork(1, 1, 1, 0),
  verifyHome: originalControlWork(2, 2, 1, 4096, 1),
  verifyTransition: originalControlWork(1, 1, 1, 0),
  authProof: originalControlWork(1, 1, 1, 128, 1),
  pending: originalControlWork(1, 1, 1, 0),
});
export const HISTORY_ORIGINAL_LOCAL_ALLOWANCE = sumOriginalControl(
  HISTORY_ORIGINAL_SELECTION,
  HISTORY_ORIGINAL_VALIDATION,
  HISTORY_ORIGINAL_SETTLEMENT,
  ...Object.values(HISTORY_SELECTED_LOCAL_CONTROL),
);

export const IDENTITY_ORIGINAL_SOURCE_TRANSFER_MISSING = 'identity-history-original-source-transfer-unavailable';

export class IdentityOriginalUnavailable extends Error {
  constructor(readonly gap: string) {
    super(gap);
  }
}

export type SelectedHistoryPosition = Readonly<{
  job_id: string;
  partition_no: number;
  account_route: number;
  account_id: string;
  barrier_id: string;
  barrier_version: number;
  barrier_at: string;
  phase: 'scan' | 'verify' | 'pending' | 'complete';
  scan_partition: number;
  verify_partition: number;
  scan_type: string | null;
  scan_locator: Buffer | null;
  registry_digest: string;
  registry_generation: string;
}>;
type Binding = Omit<SelectedHistoryPosition, 'scan_locator'> & Readonly<{ scan_locator: string | null }>;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Exact native position, not a random reservation UUID or a lease timestamp. */
export function historyOriginalPosition(job: SelectedHistoryPosition): Binding {
  if (
    !UUID.test(job.job_id) ||
    !UUID.test(job.account_id) ||
    job.barrier_id !== job.account_id ||
    routeOf(job.account_id) !== job.account_route ||
    job.partition_no !== job.account_route >>> 4 ||
    !Number.isSafeInteger(job.barrier_version) ||
    job.barrier_version < 1 ||
    typeof job.barrier_at !== 'string' ||
    Buffer.byteLength(job.barrier_at) > 128 ||
    !['scan', 'verify'].includes(job.phase) ||
    ![job.scan_partition, job.verify_partition].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 4096) ||
    (job.scan_type === null) !== (job.scan_locator === null) ||
    (job.scan_type !== null && !['command-receipt/v1', 'outbox-event/v1', 'durable-work/v1'].includes(job.scan_type)) ||
    (job.scan_locator !== null &&
      (!Buffer.isBuffer(job.scan_locator) || job.scan_locator.length < 1 || job.scan_locator.length > 256)) ||
    !/^[0-9a-f]{64}$/.test(job.registry_digest) ||
    !/^[1-9][0-9]{0,15}$/.test(job.registry_generation) ||
    !Number.isSafeInteger(Number(job.registry_generation))
  )
    throw new IdentityOriginalUnavailable('identity-history-original-position-invalid');
  const binding: Binding = Object.freeze({
    job_id: job.job_id,
    partition_no: job.partition_no,
    account_route: job.account_route,
    account_id: job.account_id,
    barrier_id: job.barrier_id,
    barrier_version: job.barrier_version,
    barrier_at: job.barrier_at,
    phase: job.phase,
    scan_partition: job.scan_partition,
    verify_partition: job.verify_partition,
    scan_type: job.scan_type,
    scan_locator: job.scan_locator?.toString('hex') ?? null,
    registry_digest: job.registry_digest,
    registry_generation: job.registry_generation,
  });
  if (Buffer.byteLength(JSON.stringify(binding)) > 2048)
    throw new IdentityOriginalUnavailable('identity-history-original-position-invalid');
  return binding;
}

declare const originalTransfer: unique symbol;
export type IdentityOriginalTransfer = Readonly<{ [originalTransfer]: true }>;
type Frame = {
  token: IdentityOriginalTransfer;
  pool: Pool;
  client: WorkClient;
  registry: HistoryRegistry;
  originalId: string;
  binding: Binding;
  deadline: number;
  active: boolean;
  entered: boolean;
  allocation: HistoryOriginalAllocation;
  library: NativeCollectionWork | null;
  source: NativeCollectionWork | null;
  childEntered: boolean;
};
const frames = new WeakMap<IdentityOriginalTransfer, Frame>();
const current = new AsyncLocalStorage<Frame>();
export type HistoryOriginalDependencies = Readonly<{ pool: Pool; client: WorkClient; registry: HistoryRegistry }>;

function live(deps: HistoryOriginalDependencies, token: IdentityOriginalTransfer, jobId: string): Frame {
  const frame = frames.get(token);
  if (
    !frame ||
    current.getStore() !== frame ||
    !frame.active ||
    frame.pool !== deps.pool ||
    frame.client !== deps.client ||
    frame.registry !== deps.registry ||
    frame.binding.job_id !== jobId ||
    frame.registry.digest() !== frame.binding.registry_digest ||
    Date.now() >= frame.deadline
  )
    throw new IdentityOriginalUnavailable('identity-history-original-handle-unavailable');
  return frame;
}

/** Private receiving provenance. Copying this opaque object does not copy admission. */
export function currentIdentityOriginalTransfer(
  deps: HistoryOriginalDependencies,
  jobId: string,
): IdentityOriginalTransfer | null {
  const frame = current.getStore();
  if (!frame) return null;
  return live(deps, frame.token, jobId).token;
}

/** The missing Source and Library producer prices remain null. Local prefix capacity cannot fund them. */
export function identityOriginalRemainder(
  deps: HistoryOriginalDependencies,
  token: IdentityOriginalTransfer,
  jobId: string,
) {
  const frame = live(deps, token, jobId);
  return Object.freeze({
    originalId: frame.originalId,
    deadline: frame.deadline,
    position: frame.binding,
    source: frame.allocation.source,
    library: frame.allocation.library,
  });
}

/** Revalidate inside the real locked operational position, closing the gap after the
 * released native consume command. This query borrows no native command authority. */
export async function lockSelectedHistoryOriginalPosition(
  deps: HistoryOriginalDependencies,
  token: IdentityOriginalTransfer,
  job: SelectedHistoryPosition,
  tx: Pick<PoolClient, 'query'>,
): Promise<void> {
  const frame = live(deps, token, job.job_id);
  if (!frame.entered || canonicalize(historyOriginalPosition(job)) !== canonicalize(frame.binding))
    throw new IdentityOriginalUnavailable('identity-history-original-selected-position-changed');
  const row = (
    await originalQuery<{ binding: Binding; deadline: string; digest: string; generation: string }>(
      frame,
      tx,
      `SELECT o.binding,o.deadline::text,r.digest,r.generation::text
     FROM core.identity_history_original o CROSS JOIN core.history_registry r
     WHERE o.original_id=$1 AND o.job_id=$2 AND o.dispatched AND o.spent=o.allowance AND r.singleton
     FOR SHARE OF o,r`,
      [frame.originalId, job.job_id],
    )
  ).rows[0];
  if (
    !row ||
    canonicalize(row.binding) !== canonicalize(frame.binding) ||
    Number(row.deadline) !== frame.deadline ||
    row.digest !== frame.binding.registry_digest ||
    row.generation !== frame.binding.registry_generation
  )
    throw new IdentityOriginalUnavailable('identity-history-original-selected-position-changed');
  live(deps, token, job.job_id);
}

function native<T>(pool: Pool, partition: number, deadline: number, body: (tx: CommandTransaction) => Promise<T>) {
  return withSingleCommandAttempt(
    async () => (await runCommand(pool, { partition, deadline }, async (tx) => noEffect(await body(tx)))).value,
  );
}

/** The trusted worker is the only producer. Selection is bounded before checkout; native
 * command identity and position commit before the capability can escape to its callback. */
export async function withSelectedHistoryOriginal<T>(
  deps: HistoryOriginalDependencies,
  body: (jobId: string, transfer: IdentityOriginalTransfer) => Promise<T>,
): Promise<T | null> {
  // Only installed owner declarations can add partitions. No caller/configuration operand
  // can fund this original. Module loading performs no discovery or control SQL.
  const allocation = await installedHistoryOriginalAllocation();
  const allowed = originalWorkVector(allocation.total);
  const deadline = Date.now() + IDENTITY_ORIGINAL_DEADLINE_MS;
  const digest = deps.registry.digest();
  if (!/^[0-9a-f]{64}$/.test(digest) || !Number.isSafeInteger(deadline) || !deps.client)
    throw new IdentityOriginalUnavailable('identity-history-original-composition-invalid');
  // Reserve the entire available finite envelope BEFORE the first discovery/control IO.
  // This local ledger is never exposed as child capacity; the immutable native admission
  // below must commit before any capability can leave this producer.
  const envelope = new NativeCollectionWork(
    { reservationId: 'selected-history-admission', remaining: allocation.total },
    deadline,
  );
  const prepaid = envelope.reserve(allocation.total);
  prepaid.dispatch();
  prepaid.settle();
  // Released point discovery does not lease or authorize the selected native job.
  const candidate = await withConnection(deps.pool, async (tx) => {
    if (Date.now() >= deadline) throw new IdentityOriginalUnavailable('identity-history-original-expired');
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await tx.query("SET LOCAL lock_timeout='200ms'");
      await tx.query(`SET LOCAL statement_timeout='${Math.max(1, deadline - Date.now())}ms'`);
      const selected = (
        await tx.query<{ job_id: string; partition_no: number }>(
          `SELECT job_id,partition_no FROM core.preference_history_job
         WHERE phase IN ('scan','verify') AND next_run<=now() ORDER BY next_run,job_id LIMIT 1`,
        )
      ).rows[0];
      await tx.query('COMMIT');
      if (Date.now() >= deadline) throw new IdentityOriginalUnavailable('identity-history-original-expired');
      return selected;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
  if (!candidate) return null;
  const admitted = await native(deps.pool, candidate.partition_no, deadline, async (tx) => {
    const command = currentCommand(tx);
    if (currentCommandResources(tx).pool !== deps.pool) throw new TypeError('Foreign original command Pool');
    const registry = (
      await tx.query<{ digest: string; generation: string }>(
        'SELECT digest,generation::text FROM core.history_registry WHERE singleton FOR SHARE',
      )
    ).rows[0];
    if (!registry || registry.digest !== digest)
      throw new IdentityOriginalUnavailable('identity-history-original-registry-changed');
    const job = (
      await tx.query<SelectedHistoryPosition>(
        `SELECT job_id,partition_no,account_route,account_id,barrier_id,barrier_version,barrier_at,
        phase,scan_partition,verify_partition,scan_type,scan_locator,registry_digest,registry_generation::text
       FROM core.preference_history_job WHERE job_id=$1 AND partition_no=$2
         AND phase IN ('scan','verify') AND next_run<=now() FOR UPDATE SKIP LOCKED`,
        [candidate.job_id, candidate.partition_no],
      )
    ).rows[0];
    if (!job) return null;
    if (job.registry_digest !== digest || job.registry_generation !== registry.generation)
      throw new IdentityOriginalUnavailable('identity-history-original-registry-changed');
    const binding = historyOriginalPosition(job);
    const barrier = (
      await tx.query<{ version: number; at: string }>(
        'SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2 FOR SHARE',
        [job.account_route, job.account_id],
      )
    ).rows[0];
    if (!barrier || barrier.version !== job.barrier_version || barrier.at !== job.barrier_at)
      throw new IdentityOriginalUnavailable('identity-history-original-barrier-changed');
    const previous = (
      await tx.query<{
        original_id: string;
        binding: Binding;
        deadline: string;
        dispatched: boolean;
        advanced: boolean;
      }>(
        `SELECT original_id,binding,deadline::text,dispatched,advanced FROM core.identity_history_original
       WHERE job_id=$1 ORDER BY ordinal DESC LIMIT 1 FOR UPDATE`,
        [job.job_id],
      )
    ).rows[0];
    if (previous && canonicalize(previous.binding) === canonicalize(binding)) {
      // Never write the proposed new deadline, allowance or a new native identity on replay.
      throw new IdentityOriginalUnavailable(
        previous.dispatched
          ? 'identity-history-original-already-dispatched'
          : 'identity-history-original-admission-replay',
      );
    }
    if (previous && !previous.advanced)
      throw new IdentityOriginalUnavailable('identity-history-original-unfinished-position-changed');
    await tx.query(
      `INSERT INTO core.identity_history_original(original_id,job_id,binding,deadline,allowance,spent,dispatched)
       VALUES($1,$2,$3,$4,$5,$6,true)`,
      // Prepay the complete closed local path, including failure/rollback/settlement, in
      // the admission commit. A later failed validation cannot return these reservations.
      [command.transactionId, job.job_id, JSON.stringify(binding), deadline, allowed, allowed],
    );
    await tx.query(
      `INSERT INTO core.identity_history_allocation(original_id,local_work,source_work,library_work,transfer_work,parent_work)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        command.transactionId,
        originalWorkVector(allocation.local),
        allocation.source === null ? null : originalWorkVector(allocation.source),
        allocation.library === null ? null : originalWorkVector(allocation.library),
        originalWorkVector(allocation.transfer),
        allowed,
      ],
    );
    await tx.query("UPDATE core.preference_history_job SET next_run=now()+interval '10 seconds' WHERE job_id=$1", [
      job.job_id,
    ]);
    return { originalId: command.transactionId, binding, deadline };
  });
  if (!admitted) return null;
  const token = Object.freeze({}) as IdentityOriginalTransfer;
  const frame: Frame = {
    token,
    ...deps,
    ...admitted,
    allocation,
    active: true,
    entered: false,
    childEntered: false,
    library:
      allocation.library === null
        ? null
        : new NativeCollectionWork({ reservationId: admitted.originalId, remaining: allocation.library }, deadline),
    source:
      allocation.source === null
        ? null
        : new NativeCollectionWork({ reservationId: admitted.originalId, remaining: allocation.source }, deadline),
  };
  if (frame.library) frame.library = guardedOriginalLibrary(frame, frame.library);
  frames.set(token, frame);
  return current.run(frame, async () => {
    try {
      live(deps, token, frame.binding.job_id);
      const answer = await body(frame.binding.job_id, token);
      live(deps, token, frame.binding.job_id);
      await settleSelectedHistoryOriginal(deps, token, frame.binding.job_id);
      return answer;
    } finally {
      frame.active = false;
      frames.delete(token);
    }
  });
}

/** A separate committed debit precedes affected dispatch. The following body may roll back,
 * throw, or fail to dispatch; none of those paths restore this original's capacity. */
export async function consumeSelectedHistoryOriginal(
  deps: HistoryOriginalDependencies,
  token: IdentityOriginalTransfer,
  jobId: string,
): Promise<void> {
  const frame = live(deps, token, jobId);
  if (frame.entered) throw new IdentityOriginalUnavailable('identity-history-original-consumed-or-changed');
  // A failed checkout, rollback or validation cannot reuse this live dispatch capability.
  // Durable admission also refuses to issue another capability for the same native position.
  frame.entered = true;
  await native(deps.pool, frame.binding.partition_no, frame.deadline, async (tx) => {
    live(deps, token, jobId);
    const row = (
      await originalQuery<{ binding: Binding; deadline: string; dispatched: boolean }>(
        frame,
        tx,
        `SELECT binding,deadline::text,dispatched FROM core.identity_history_original
       WHERE original_id=$1 AND job_id=$2 FOR UPDATE`,
        [frame.originalId, jobId],
      )
    ).rows[0];
    if (
      !row ||
      !row.dispatched ||
      Number(row.deadline) !== frame.deadline ||
      canonicalize(row.binding) !== canonicalize(frame.binding)
    )
      throw new IdentityOriginalUnavailable('identity-history-original-consumed-or-changed');
    const job = (
      await originalQuery<SelectedHistoryPosition>(
        frame,
        tx,
        `SELECT job_id,partition_no,account_route,account_id,barrier_id,barrier_version,barrier_at,
        phase,scan_partition,verify_partition,scan_type,scan_locator,registry_digest,registry_generation::text
       FROM core.preference_history_job WHERE job_id=$1 FOR SHARE`,
        [jobId],
      )
    ).rows[0];
    if (!job || canonicalize(historyOriginalPosition(job)) !== canonicalize(frame.binding))
      throw new IdentityOriginalUnavailable('identity-history-original-selected-position-changed');
    const registry = (
      await originalQuery<{ digest: string; generation: string }>(
        frame,
        tx,
        'SELECT digest,generation::text FROM core.history_registry WHERE singleton FOR SHARE',
      )
    ).rows[0];
    if (registry?.digest !== frame.binding.registry_digest || registry.generation !== frame.binding.registry_generation)
      throw new IdentityOriginalUnavailable('identity-history-original-registry-changed');
    const barrier = (
      await originalQuery<{ version: number; at: string }>(
        frame,
        tx,
        'SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2 FOR SHARE',
        [frame.binding.account_route, frame.binding.account_id],
      )
    ).rows[0];
    live(deps, token, jobId);
    if (barrier?.version !== frame.binding.barrier_version || barrier.at !== frame.binding.barrier_at)
      throw new IdentityOriginalUnavailable('identity-history-original-barrier-changed');
    // All eight axes were reserved durably by admission, including this failure path.
    const changed = await originalQuery(
      frame,
      tx,
      `UPDATE core.identity_history_allocation a SET local_entered=true
       FROM core.identity_history_original o
       WHERE a.original_id=$1 AND o.original_id=a.original_id AND NOT a.local_entered
         AND o.dispatched AND o.deadline>$2 AND o.spent=o.allowance RETURNING a.original_id`,
      [frame.originalId, Date.now()],
    );
    if (changed.rows.length !== 1) throw new IdentityOriginalUnavailable('identity-history-original-exhausted');
  });
  live(deps, token, jobId);
}

async function settleSelectedHistoryOriginal(
  deps: HistoryOriginalDependencies,
  token: IdentityOriginalTransfer,
  jobId: string,
): Promise<void> {
  const frame = live(deps, token, jobId);
  await native(deps.pool, frame.binding.partition_no, frame.deadline, async (tx) => {
    const job = (
      await originalQuery<SelectedHistoryPosition>(
        frame,
        tx,
        `SELECT job_id,partition_no,account_route,account_id,barrier_id,barrier_version,barrier_at,
        phase,scan_partition,verify_partition,scan_type,scan_locator,registry_digest,registry_generation::text
       FROM core.preference_history_job WHERE job_id=$1 FOR UPDATE`,
        [jobId],
      )
    ).rows[0];
    live(deps, token, jobId);
    const recorded = (
      await originalQuery<{ next_binding: Binding | null }>(
        frame,
        tx,
        'SELECT next_binding FROM core.identity_history_allocation WHERE original_id=$1 AND local_entered FOR UPDATE',
        [frame.originalId],
      )
    ).rows[0];
    live(deps, token, jobId);
    // Only the position recorded by the actual locked execution transaction may settle.
    // A registry wake/reset or another worker changing a cursor is not this unit's progress.
    const advanced =
      !!job &&
      recorded?.next_binding != null &&
      canonicalize(positionAfterExecution(job)) === canonicalize(recorded.next_binding);
    if (advanced)
      await originalQuery(
        frame,
        tx,
        `UPDATE core.identity_history_original SET advanced=true
       WHERE original_id=$1 AND dispatched AND NOT advanced AND spent=allowance`,
        [frame.originalId],
      );
    live(deps, token, jobId);
    if (advanced)
      await originalQuery(
        frame,
        tx,
        `UPDATE core.preference_history_job SET next_run=now() WHERE job_id=$1
       AND phase IN ('scan','verify') AND next_run>now()`,
        [jobId],
      );
  });
}

/** The additive controls are separate from every retained local component. All branches
 * are inclusive: even a refused/failed callback retains its entire prepaid reservation.
 * Reads use full original/job keys; the only fanout is the four fixed vector partitions.
 * Zero candidate/identity-metadata/witness axes mean these SQL bodies have none of those
 * operations; they are not conversions from the legacy five-axis child declarations. */
export const HISTORY_ORIGINAL_TRANSFER_CONTROL = Object.freeze({
  discoveryControls: originalControlWork(0, 0, 5, 0), // BEGIN, settings x2, COMMIT, failed ROLLBACK
  allocationInsert: originalControlWork(3, 3, 3, 4096), // INSERT + original FK point
  entryBarrier: originalControlWork(1, 1, 1, 128, 1),
  progress: sumOriginalControl(originalControlWork(1, 1, 1, 2048, 1), originalControlWork(1, 1, 1, 64)),
  settlementAllocation: originalControlWork(1, 1, 1, 2048, 1),
  // pre-grant and post-callback: native controls, original/allocation, selected job,
  // registry, immutable account barrier, and the irreversible state transition.
  grant: sumOriginalControl(
    ORIGINAL_NATIVE_CONTROL,
    originalControlWork(2, 2, 1, 8192, 2),
    originalControlWork(1, 1, 1, 2048, 1),
    originalControlWork(1, 1, 1, 128, 1),
    originalControlWork(1, 1, 1, 128, 1),
    originalControlWork(1, 1, 1, 0),
  ),
  finish: sumOriginalControl(
    ORIGINAL_NATIVE_CONTROL,
    originalControlWork(2, 2, 1, 8192, 2),
    originalControlWork(1, 1, 1, 2048, 1),
    originalControlWork(1, 1, 1, 128, 1),
    originalControlWork(1, 1, 1, 128, 1),
    originalControlWork(1, 1, 1, 0),
  ),
});
export const ADDITIONAL_ORIGINAL_TRANSFER_CONTROL = sumOriginalControl(
  ...Object.values(HISTORY_ORIGINAL_TRANSFER_CONTROL),
);

type HistoryOriginalAllocation = Readonly<{
  local: WorkDimensions;
  source: WorkDimensions | null;
  library: WorkDimensions | null;
  transfer: WorkDimensions;
  total: WorkDimensions;
}>;

/** Owner-installed body declarations, not grants. Accounts reads these ONLY from the
 * actual Source and Library modules before admission. Public call sites supply no price.
 * The source declaration includes all reached History, inventory, receiving, H/G/A,
 * outbox/released/current/final validators, settings, failure and rollback invocations.
 * Library's declaration includes all actual page/verifier/planner/seal/fence bodies. */
export type IdentityHistoryOriginalBodyDeclaration = Readonly<{
  work: WorkDimensions;
  engineRequests: 0;
}>;

function installedDeclaration(module: object, name: string): WorkDimensions | null {
  const descriptor = Object.getOwnPropertyDescriptor(module, name);
  if (!descriptor) return null;
  if (!('value' in descriptor) || !descriptor.value || typeof descriptor.value !== 'object')
    throw new IdentityOriginalUnavailable('identity-history-original-child-declaration-invalid');
  const declaration = descriptor.value as IdentityHistoryOriginalBodyDeclaration;
  if (
    declaration.engineRequests !== 0 ||
    Reflect.ownKeys(declaration).length !== 2 ||
    !Object.hasOwn(declaration, 'work') ||
    !Object.hasOwn(declaration, 'engineRequests')
  )
    throw new IdentityOriginalUnavailable('identity-history-original-child-declaration-invalid');
  const vector = originalWorkVector(declaration.work);
  return Object.freeze(
    Object.fromEntries(ORIGINAL_AXES.map((axis, i) => [axis, vector[i]!])) as unknown as WorkDimensions,
  );
}

async function installedHistoryOriginalAllocation(): Promise<HistoryOriginalAllocation> {
  const sourceModule = await import('../semantic/identity-source-consumer-maintenance.ts');
  const libraryModule = await import('../library/collection-source-work.ts');
  const source = installedDeclaration(sourceModule, 'IDENTITY_HISTORY_ORIGINAL_SOURCE_DECLARATION');
  const library = installedDeclaration(libraryModule, 'IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION');
  return Object.freeze({
    local: HISTORY_ORIGINAL_LOCAL_ALLOWANCE,
    source,
    library,
    transfer: ADDITIONAL_ORIGINAL_TRANSFER_CONTROL,
    total: sumOriginalControl(
      HISTORY_ORIGINAL_LOCAL_ALLOWANCE,
      ADDITIONAL_ORIGINAL_TRANSFER_CONTROL,
      ...(source === null ? [] : [source]),
      ...(library === null ? [] : [library]),
    ),
  });
}

function positionAfterExecution(job: SelectedHistoryPosition): Binding {
  // Terminal phases can be recorded as native progress; they confer no physical closure.
  const checked = historyOriginalPosition({
    ...job,
    phase: job.phase === 'pending' || job.phase === 'complete' ? 'verify' : job.phase,
  });
  return Object.freeze({ ...checked, phase: job.phase });
}

function sameOriginalIdentity(left: Binding, right: Binding): boolean {
  return (
    left.job_id === right.job_id &&
    left.partition_no === right.partition_no &&
    left.account_route === right.account_route &&
    left.account_id === right.account_id &&
    left.barrier_id === right.barrier_id &&
    left.barrier_version === right.barrier_version &&
    left.barrier_at === right.barrier_at &&
    left.registry_digest === right.registry_digest &&
    left.registry_generation === right.registry_generation
  );
}

/** Called inside the real job transaction, after native progress and before COMMIT.
 * The query surface is deliberately operational: it issues no CommandTransaction authority.
 * Settlement cannot infer progress merely from a later changed job observation. */
export async function recordSelectedHistoryOriginalProgress(
  deps: HistoryOriginalDependencies,
  token: IdentityOriginalTransfer,
  jobId: string,
  tx: Pick<PoolClient, 'query'>,
): Promise<void> {
  const frame = live(deps, token, jobId);
  if (!frame.entered) throw new IdentityOriginalUnavailable('identity-history-original-not-entered');
  const job = (
    await originalQuery<SelectedHistoryPosition>(
      frame,
      tx,
      `SELECT job_id,partition_no,account_route,account_id,barrier_id,barrier_version,barrier_at,
      phase,scan_partition,verify_partition,scan_type,scan_locator,registry_digest,registry_generation::text
     FROM core.preference_history_job WHERE job_id=$1 FOR UPDATE`,
      [jobId],
    )
  ).rows[0];
  live(deps, token, jobId);
  if (!job) throw new IdentityOriginalUnavailable('identity-history-original-selected-position-changed');
  const next = positionAfterExecution(job);
  if (!sameOriginalIdentity(next, frame.binding))
    throw new IdentityOriginalUnavailable('identity-history-original-selected-position-changed');
  if (canonicalize(next) === canonicalize(frame.binding)) return;
  const changed = await originalQuery(
    frame,
    tx,
    `UPDATE core.identity_history_allocation SET next_binding=$2
     WHERE original_id=$1 AND local_entered AND next_binding IS NULL RETURNING original_id`,
    [frame.originalId, JSON.stringify(next)],
  );
  live(deps, token, jobId);
  if (changed.rows.length !== 1)
    throw new IdentityOriginalUnavailable('identity-history-original-progress-already-recorded');
}

declare const privateGrant: unique symbol;
export type IdentityOriginalSourceGrant = Readonly<{ [privateGrant]: true }>;
export type IdentityOriginalSourceContext = Readonly<{
  original: IdentityOriginalSourceGrant;
  originalId: string;
  jobId: string;
  position: Binding;
  deadline: number;
  native: WorkDimensions;
  library: NativeCollectionWork;
}>;
type GrantFrame = { parent: Frame; token: IdentityOriginalSourceGrant; active: boolean };
const grants = new WeakMap<IdentityOriginalSourceGrant, GrantFrame>();
const currentGrant = new AsyncLocalStorage<GrantFrame>();

function liveGrant(deps: HistoryOriginalDependencies, token: IdentityOriginalSourceGrant, jobId: string): GrantFrame {
  const grant = grants.get(token);
  if (
    !grant ||
    !grant.active ||
    currentGrant.getStore() !== grant ||
    live(deps, grant.parent.token, jobId) !== grant.parent ||
    !grant.parent.childEntered
  )
    throw new IdentityOriginalUnavailable('identity-history-original-private-grant-unavailable');
  return grant;
}

/** Source uses this before each actual native dispatch; the prepaid original partition
 * is cumulative and cannot refill on retry, failure, rollback or an unavailable result. */
export function reserveIdentityOriginalSourceWork(
  deps: HistoryOriginalDependencies,
  token: IdentityOriginalSourceGrant,
  jobId: string,
  amount: WorkDimensions,
): void {
  const frame = liveGrant(deps, token, jobId).parent;
  originalWorkVector(amount);
  if (!frame.source) throw new IdentityOriginalUnavailable(IDENTITY_ORIGINAL_SOURCE_TRANSFER_MISSING);
  const held = frame.source.reserve(amount);
  held.dispatch();
  held.settle();
}

/** Every Library descendant receives this exact object, including the final same-command
 * fence. This accessor neither creates a reservation UUID nor constructs another ledger. */
export function identityOriginalLibraryWork(
  deps: HistoryOriginalDependencies,
  token: IdentityOriginalSourceGrant,
  jobId: string,
): NativeCollectionWork {
  const frame = liveGrant(deps, token, jobId).parent;
  if (!frame.library) throw new IdentityOriginalUnavailable(IDENTITY_ORIGINAL_SOURCE_TRANSFER_MISSING);
  return frame.library;
}

async function validateTransferPosition(
  deps: HistoryOriginalDependencies,
  frame: Frame,
  tx: CommandTransaction,
  finishing: boolean,
): Promise<void> {
  live(deps, frame.token, frame.binding.job_id);
  const original = (
    await originalQuery<{
      binding: Binding;
      deadline: string;
      source_work: string[] | null;
      library_work: string[] | null;
      child_entered: boolean;
      child_ended: boolean;
      next_binding: Binding | null;
    }>(
      frame,
      tx,
      `SELECT o.binding,o.deadline::text,a.source_work,a.library_work,a.child_entered,a.child_ended,a.next_binding
     FROM core.identity_history_original o JOIN core.identity_history_allocation a USING(original_id)
     WHERE o.original_id=$1 AND o.dispatched AND o.spent=o.allowance AND a.local_entered FOR UPDATE OF o,a`,
      [frame.originalId],
    )
  ).rows[0];
  live(deps, frame.token, frame.binding.job_id);
  if (
    !original ||
    canonicalize(original.binding) !== canonicalize(frame.binding) ||
    Number(original.deadline) !== frame.deadline ||
    original.child_ended ||
    original.child_entered !== finishing ||
    original.source_work === null ||
    original.library_work === null ||
    !frame.allocation.source ||
    !frame.allocation.library ||
    canonicalize(original.source_work.map(Number)) !== canonicalize(originalWorkVector(frame.allocation.source)) ||
    canonicalize(original.library_work.map(Number)) !== canonicalize(originalWorkVector(frame.allocation.library))
  )
    throw new IdentityOriginalUnavailable('identity-history-original-private-transfer-consumed-or-changed');
  const job = (
    await originalQuery<SelectedHistoryPosition>(
      frame,
      tx,
      `SELECT job_id,partition_no,account_route,account_id,barrier_id,barrier_version,barrier_at,
      phase,scan_partition,verify_partition,scan_type,scan_locator,registry_digest,registry_generation::text
     FROM core.preference_history_job WHERE job_id=$1 FOR SHARE`,
      [frame.binding.job_id],
    )
  ).rows[0];
  const registry = (
    await originalQuery<{ digest: string; generation: string }>(
      frame,
      tx,
      'SELECT digest,generation::text FROM core.history_registry WHERE singleton FOR SHARE',
    )
  ).rows[0];
  const barrier = (
    await originalQuery<{ version: number; at: string }>(
      frame,
      tx,
      'SELECT version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2 FOR SHARE',
      [frame.binding.account_route, frame.binding.account_id],
    )
  ).rows[0];
  live(deps, frame.token, frame.binding.job_id);
  if (
    !job ||
    canonicalize(positionAfterExecution(job)) !==
      canonicalize(finishing && original.next_binding ? original.next_binding : frame.binding) ||
    registry?.digest !== frame.binding.registry_digest ||
    registry.generation !== frame.binding.registry_generation ||
    barrier?.version !== frame.binding.barrier_version ||
    barrier.at !== frame.binding.barrier_at
  )
    throw new IdentityOriginalUnavailable('identity-history-original-private-transfer-position-changed');
}

/** Sole Accounts private prepaid Source callback. No structural funding argument, caller
 * ceiling, fresh UUID or operational-to-command cast exists on this route. */
export async function withIdentityOriginalSourceTransfer<T>(
  deps: HistoryOriginalDependencies,
  token: IdentityOriginalTransfer,
  jobId: string,
  body: (context: IdentityOriginalSourceContext) => Promise<T>,
): Promise<T> {
  const frame = live(deps, token, jobId);
  if (!frame.entered || frame.childEntered || !frame.allocation.source || !frame.allocation.library || !frame.library)
    throw new IdentityOriginalUnavailable(IDENTITY_ORIGINAL_SOURCE_TRANSFER_MISSING);
  frame.childEntered = true; // Poison even if the following independent commit fails.
  await native(deps.pool, frame.binding.partition_no, frame.deadline, async (tx) => {
    await validateTransferPosition(deps, frame, tx, false);
    await originalQuery(
      frame,
      tx,
      'UPDATE core.identity_history_allocation SET child_entered=true WHERE original_id=$1',
      [frame.originalId],
    );
  });
  live(deps, token, jobId);
  const grantToken = Object.freeze({}) as IdentityOriginalSourceGrant;
  const grant: GrantFrame = { parent: frame, token: grantToken, active: true };
  grants.set(grantToken, grant);
  return currentGrant.run(grant, async () => {
    try {
      liveGrant(deps, grantToken, jobId);
      const answer = await body(
        Object.freeze({
          original: grantToken,
          originalId: frame.originalId,
          jobId,
          position: frame.binding,
          deadline: frame.deadline,
          native: frame.allocation.source!,
          library: frame.library!,
        }),
      );
      liveGrant(deps, grantToken, jobId);
      await native(deps.pool, frame.binding.partition_no, frame.deadline, async (tx) => {
        liveGrant(deps, grantToken, jobId);
        await validateTransferPosition(deps, frame, tx, true);
        liveGrant(deps, grantToken, jobId);
        await originalQuery(
          frame,
          tx,
          'UPDATE core.identity_history_allocation SET child_ended=true WHERE original_id=$1',
          [frame.originalId],
        );
      });
      liveGrant(deps, grantToken, jobId);
      return answer;
    } finally {
      grant.active = false;
      grants.delete(grantToken);
    }
  });
}

/** Exact required private caller operand. The installed History caller must enter its
 * existing unit with Source's authentic prepaid frame and this SAME Library ledger;
 * withAgentIdentityHistoryUnit's current independent configured allocation is ineligible. */
export type PrepaidAgentIdentityHistoryUnit = <T>(
  deps: HistoryOriginalDependencies &
    Readonly<{
      env: Readonly<Record<string, string | undefined>>;
      clock: () => Date;
    }>,
  parent: IdentityOriginalSourceContext,
  body: (
    funded: import('../history/agent-identity-retirement.ts').IdentitySourceConsumerMaintenanceContext,
  ) => Promise<T>,
) => Promise<T>;

/** Fixed native caller integration only; neither a callback parameter nor a module path
 * from the request can install the missing Source/History producer. Until its actual
 * prepaid caller is installed, only this child dispatch refuses. */
export async function withSelectedHistoryOriginalChild<T>(
  deps: HistoryOriginalDependencies &
    Readonly<{ env: Readonly<Record<string, string | undefined>>; clock: () => Date }>,
  token: IdentityOriginalTransfer,
  jobId: string,
  body: (
    funded: import('../history/agent-identity-retirement.ts').IdentitySourceConsumerMaintenanceContext,
  ) => Promise<T>,
): Promise<T> {
  live(deps, token, jobId);
  const installed = await import('../history/agent-identity-retirement.ts');
  live(deps, token, jobId);
  const caller = Object.getOwnPropertyDescriptor(installed, 'withPrepaidAgentIdentityHistoryUnit');
  if (!caller || !('value' in caller) || typeof caller.value !== 'function')
    throw new IdentityOriginalUnavailable(IDENTITY_ORIGINAL_SOURCE_TRANSFER_MISSING);
  const enter = caller.value as PrepaidAgentIdentityHistoryUnit;
  return withIdentityOriginalSourceTransfer(deps, token, jobId, (parent) => enter(deps, parent, body));
}

/** The single Library ledger may escape an awaited page call, but its authority may
 * not outlive the original callback. Keep all counters in the native object, and wrap
 * dispatch/settlement handles as well as saved method references. No second ledger. */
function guardedOriginalLibrary(frame: Frame, ledger: NativeCollectionWork): NativeCollectionWork {
  const assertLive = () => {
    const grant = currentGrant.getStore();
    if (!grant || grant.parent !== frame)
      throw new IdentityOriginalUnavailable('identity-history-original-private-grant-unavailable');
    liveGrant(frame, grant.token, frame.binding.job_id);
  };
  const methods = new Set([
    'reserve',
    'compose',
    'receipt',
    'available',
    'assertReady',
    'admitResultBytes',
    'resultByteBound',
  ]);
  const wrapResult = (result: unknown): unknown => {
    if (result instanceof Promise)
      return result.then((answer) => {
        assertLive();
        return answer;
      });
    return result;
  };
  return new Proxy(ledger, {
    get(target, key) {
      assertLive();
      if (key === 'failure') return target.failure;
      if (typeof key !== 'string' || !methods.has(key)) throw new TypeError('Private original Library ledger');
      if (key === 'reserve')
        return (...args: Parameters<NativeCollectionWork['reserve']>) => {
          assertLive();
          const held = target.reserve(...args);
          return Object.freeze({
            dispatch() {
              assertLive();
              held.dispatch();
            },
            query<T>(operation: () => Promise<T>) {
              assertLive();
              return held.query(async () => {
                assertLive();
                const answer = await operation();
                assertLive();
                return answer;
              });
            },
            settle(...values: Parameters<typeof held.settle>) {
              assertLive();
              held.settle(...values);
            },
            cancel() {
              assertLive();
              held.cancel();
            },
          });
        };
      if (key === 'compose')
        return <T extends { readonly work: import('../library/collection-source.ts').WorkReceipt }>(
          operation: (allowance: import('../library/collection-source.ts').WorkAllowance) => Promise<T>,
          ceiling?: WorkDimensions,
        ) => {
          assertLive();
          return target
            .compose(async (allowance) => {
              assertLive();
              const answer = await operation(allowance);
              assertLive();
              return answer;
            }, ceiling)
            .then((answer) => {
              assertLive();
              return answer;
            });
        };
      return (...args: unknown[]) => {
        assertLive();
        const method = Reflect.get(target, key) as (...operands: unknown[]) => unknown;
        return wrapResult(method.apply(target, args));
      };
    },
    set(target, key, value) {
      assertLive();
      // Instrumentation can poison a failed ledger; it cannot clear or replace its counters.
      if (key !== 'failure' || !(value instanceof Error)) throw new TypeError('Private original Library ledger');
      target.failure ??= value;
      return true;
    },
    defineProperty() {
      throw new TypeError('Private original Library ledger');
    },
    deleteProperty() {
      throw new TypeError('Private original Library ledger');
    },
    setPrototypeOf() {
      throw new TypeError('Private original Library ledger');
    },
    ownKeys() {
      return [];
    },
    getOwnPropertyDescriptor() {
      return undefined;
    },
  });
}

/** Query-only adapter: validate the actual live original around EVERY awaited control
 * operation. It does not manufacture command resources for an operational checkout. */
async function originalQuery<Row extends QueryResultRow = QueryResultRow>(
  frame: Frame,
  tx: Pick<PoolClient, 'query'>,
  sql: string,
  values: readonly unknown[] = [],
) {
  live(frame, frame.token, frame.binding.job_id);
  const result = await tx.query<Row>(sql, [...values]);
  live(frame, frame.token, frame.binding.job_id);
  return result;
}

/** Preserve the actual operational client and its transaction, with per-await liveness.
 * This wrapper deliberately creates no currentCommand/currentCommandResources entry.
 * Failure ROLLBACK remains possible after expiry and is prepaid by the local envelope. */
export function guardSelectedHistoryOriginalTransaction(
  deps: HistoryOriginalDependencies,
  token: IdentityOriginalTransfer,
  jobId: string,
  client: PoolClient,
): PoolClient {
  live(deps, token, jobId);
  return new Proxy(client, {
    get(target, key) {
      if (key !== 'query') return Reflect.get(target, key, target);
      return async (...args: unknown[]) => {
        const rollback = args.length === 1 && args[0] === 'ROLLBACK';
        if (!rollback) live(deps, token, jobId);
        const answer = await Reflect.apply(target.query, target, args);
        if (!rollback) live(deps, token, jobId);
        return answer;
      };
    },
  });
}
