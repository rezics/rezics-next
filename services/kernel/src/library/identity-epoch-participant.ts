import type { Pool } from 'pg';
import { shareAccount } from '../access/account-share.ts';
import { noEffect, runCommand } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import type { IdentityEpochStep, IdentityJobRef } from '../semantic/identity-epoch-contract.ts';
import {
  identityEpochStore,
  identityJobPartition,
  IdentityEpochStoreError,
} from '../semantic/identity-adapters/index.ts';
import {
  lookupIdentityReceivingEffect,
  prepareIdentityReceivingEffect,
  recordIdentityReceivingEffect,
  reconcileIdentityReceivingEffect,
  type IdentityReceivingEffect,
  type IdentityReceivingSelection,
} from '../semantic/identity-receiving-effects.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { IDENTITY_EPOCH_ADMITTED } from '../semantic/events.ts';
import { WORK_STEP_DEADLINE_MS, workStepDeadline } from './command-support.ts';
import {
  libraryIdentityInvalidationRole,
  registerLibraryOwnerIdentityScope,
  type LibraryIdentityRole,
} from './owner-identity.ts';
import invalidate from './identity-epoch-participant-invalidate.sql';

const step = 'library-private-follow-counts';
const stale = (detail: string) => new IdentityEpochStoreError('identity_effect_stale', detail);
const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);
function bounded<T>(run: (deadline: number) => Promise<T>): Promise<T> {
  const deadline = Math.min(workStepDeadline(), Date.now() + WORK_STEP_DEADLINE_MS);
  return withRequestDeadline(deadline, () => run(deadline));
}
type QueuedEffect = {
  original: string;
  effect_key: string;
  role: LibraryIdentityRole;
  receiving_partition: number;
  receiving_epoch: number;
  receiving_position: string;
  receiving_transaction_id: string;
};
function effectOf(job: IdentityJobRef, row: QueuedEffect): IdentityReceivingEffect {
  return {
    kind: 'receiving',
    job,
    original: row.original,
    effectKey: row.effect_key,
    receipt: {
      partition: row.receiving_partition,
      epoch: row.receiving_epoch,
      position: BigInt(row.receiving_position),
      transactionId: row.receiving_transaction_id,
    },
  };
}
function wake(job: IdentityJobRef) {
  return {
    type: IDENTITY_EPOCH_ADMITTED,
    data: { jobId: job.jobId, epoch: job.epoch.toString(), partition: identityJobPartition(job) },
  };
}

/** Normal Source writer handoff. Selection keys alone never register native work.
 * Source read/hold, expected control obligation and receiving record precede this queue.
 * A crash before queue insertion leaves the expected obligation pending; retry the same selection.
 */
export async function prepareLibraryIdentitySourceInvalidation(
  pool: Pool,
  selection: IdentityReceivingSelection,
): Promise<IdentityReceivingEffect> {
  return bounded(async () => {
    libraryIdentityInvalidationRole(selection.scope);
    const effect = await prepareIdentityReceivingEffect(pool, selection);
    await registerLibraryIdentitySourceInvalidation(pool, effect);
    return effect;
  });
}

/** A retained actual receiving locator also recovers a lost preparation result.
 * No Source factory, arbitrary effect callback, supplied native success or participant ACK.
 */
export async function registerLibraryIdentitySourceInvalidation(
  pool: Pool,
  effect: IdentityReceivingEffect,
): Promise<void> {
  return bounded(async (deadline) => {
    const observed = await runCommand(pool, { partition: effect.receipt.partition, deadline }, async (tx) =>
      noEffect(await lookupIdentityReceivingEffect(tx, effect)),
    );
    const record = observed.value;
    if (!record) throw stale('Missing native Library source receiving record');
    const role = libraryIdentityInvalidationRole(record.source.scope);
    if (record.source.home !== record.source.receivingHome)
      throw unavailable('Cross-home Library identity Source holds remain unbound');
    const home = identityJobPartition(effect.job);
    const ownerRoute = routeOf(record.owner);
    if (ownerRoute === null || partitionOf(ownerRoute) !== home || record.source.receivingHome !== home)
      throw unavailable('Library control-copy custody requires the actual same-home account fence');
    await runCommand(pool, { partition: home, deadline }, async (tx) => {
      await shareAccount(tx, record.owner);
      // All supported homes coincide, so revalidate the real receiving owner/gate locally after the released read.
      const current = await lookupIdentityReceivingEffect(tx, effect);
      if (!current || current.owner !== record.owner || current.plan.transactionId !== record.plan.transactionId)
        throw stale('Library source receiving custody changed before registration');
      // Registration serializes with publication/cancellation on this saved job, never a global lock.
      const job = await tx.query(
        `SELECT 1 FROM semantic.identity_epoch_job
       WHERE partition_no=$1 AND job_id=$2 AND epoch=$3 AND state='pending' FOR UPDATE`,
        [home, effect.job.jobId, effect.job.epoch.toString()],
      );
      if (job.rowCount !== 1) throw stale('Library source registration needs the pending admitted job');
      const plan = await tx.query(
        `SELECT 1 FROM semantic.identity_epoch_receiving_plan
       WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND effect_key=$4 AND transaction_id=$5
         AND binding->>'original'=$6 AND binding->>'owner'=$7
         AND binding->'source'->>'id'=$8 AND binding->'source'->>'scope'=$9`,
        [
          home,
          effect.job.jobId,
          effect.job.epoch.toString(),
          effect.effectKey,
          record.plan.transactionId,
          effect.original,
          record.owner,
          record.source.id,
          record.source.scope,
        ],
      );
      if (plan.rowCount !== 1) throw stale('Missing exact native Library source control plan');
      const prior = await tx.query<QueuedEffect>(
        `SELECT original,effect_key,role,receiving_partition,receiving_epoch,
              receiving_position::text,receiving_transaction_id::text
       FROM library.identity_epoch_participant_work
       WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND effect_key=$4`,
        [home, effect.job.jobId, effect.job.epoch.toString(), effect.effectKey],
      );
      const row = prior.rows[0];
      if (row) {
        if (
          row.original !== effect.original ||
          row.role !== role ||
          row.receiving_partition !== effect.receipt.partition ||
          row.receiving_epoch !== effect.receipt.epoch ||
          BigInt(row.receiving_position) !== effect.receipt.position ||
          row.receiving_transaction_id !== effect.receipt.transactionId
        )
          throw stale('Conflicting native Library source receiving locator');
        return noEffect(null);
      }
      await tx.query(
        `INSERT INTO library.identity_epoch_participant_work
        (partition_no,job_id,job_epoch,effect_key,original,owner_id,role,receiving_partition,
         receiving_epoch,receiving_position,receiving_transaction_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          home,
          effect.job.jobId,
          effect.job.epoch.toString(),
          effect.effectKey,
          effect.original,
          record.owner,
          role,
          effect.receipt.partition,
          effect.receipt.epoch,
          effect.receipt.position.toString(),
          effect.receipt.transactionId,
        ],
      );
      return { value: null, events: [wake(effect.job)] };
    });
  });
}

/** One source-local effect. Invalidation retains partial/ready bases, never private fact values.
 * This scope is separate from OLD/NEW canonical rekeys, follow effects and publication fences.
 */
async function applySourceInvalidation(pool: Pool, job: IdentityJobRef, row: QueuedEffect, deadline: number) {
  const effect = effectOf(job, row);
  await runCommand(pool, { partition: effect.receipt.partition, deadline }, async (tx) => {
    const record = await lookupIdentityReceivingEffect(tx, effect);
    if (!record || libraryIdentityInvalidationRole(record.source.scope) !== row.role)
      throw stale('Library source invalidation scope changed');
    // Resolve committed local effects BEFORE admission/mutation: replay cannot invalidate a newer build.
    if (record.applied) return noEffect(null);
    const sourceRoute = routeOf(record.source.id);
    const ownerRoute = routeOf(record.owner);
    if (
      sourceRoute === null ||
      ownerRoute === null ||
      partitionOf(sourceRoute) !== effect.receipt.partition ||
      partitionOf(ownerRoute) !== effect.receipt.partition ||
      record.source.home !== effect.receipt.partition
    )
      throw unavailable('Library source invalidation requires actual same-home source/account custody');
    // Same native account barrier: terminal T cannot create a late private directory/basis.
    const role = await registerLibraryOwnerIdentityScope(tx, effect);
    const source = await tx.query(
      `SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2 AND curator_account_id=$3 FOR SHARE`,
      [sourceRoute, record.source.id, record.owner],
    );
    if (source.rowCount !== 1) throw unavailable('Missing actual owner Collection source for identity invalidation');
    const retained = await tx.query<{ ready_generation: string | null; working_generation: string | null }>(
      invalidate.sql,
      [
        sourceRoute,
        record.source.id,
        effect.receipt.partition,
        job.jobId,
        job.epoch.toString(),
        effect.effectKey,
        record.owner,
      ],
    );
    const basis = retained.rows[0];
    if (!basis) throw unavailable('Canonical Source state is uninstalled; absence cannot prove coverage');
    await recordIdentityReceivingEffect(tx, effect, {
      frontier: {
        after: [
          role,
          record.source.id,
          record.source.incarnation,
          record.source.disposition,
          basis.ready_generation,
          basis.working_generation,
        ],
        segment: 0,
      },
    });
    return { value: null, events: [wake(job)] };
  });
  // Release effect home BEFORE control custody, and Source ACK BEFORE dequeue.
  // Lost results reuse the exact committed receiving locator and frontier.
  await reconcileIdentityReceivingEffect(pool, effect);
  await runCommand(pool, { partition: identityJobPartition(job), deadline }, async (tx) => {
    const custody = await tx.query(
      `SELECT 1 FROM semantic.identity_epoch_receiving_custody
       WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3`,
      [identityJobPartition(job), job.jobId, effect.effectKey],
    );
    if (custody.rowCount !== 1) throw stale('Library receiving effect has no actual control custody');
    const updated = await tx.query(
      `UPDATE library.identity_epoch_participant_work SET custodied=true
       WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND effect_key=$4 AND NOT custodied
         AND receiving_partition=$5 AND receiving_epoch=$6 AND receiving_position=$7
         AND receiving_transaction_id=$8 RETURNING effect_key`,
      [
        identityJobPartition(job),
        job.jobId,
        job.epoch.toString(),
        effect.effectKey,
        effect.receipt.partition,
        effect.receipt.epoch,
        effect.receipt.position.toString(),
        effect.receipt.transactionId,
      ],
    );
    return updated.rowCount ? { value: null, events: [wake(job)] } : noEffect(null);
  });
}

/** Fixed ALL-Library entry point. Owned effects execute independently of final composition.
 * Missing full Source/owner/follow coverage never becomes an empty observation or completion receipt.
 */
export const stepLibraryIdentityEpoch: IdentityEpochStep = (pool, job) =>
  bounded(async (deadline) => {
    if (routeOf(job.jobId) === null || typeof job.epoch !== 'bigint' || job.epoch <= 0n)
      throw new TypeError('Library identity work requires a native job ID and positive bigint epoch');
    const saved = await withReadTransaction(pool, (tx) => identityEpochStore.readJob(tx, job));
    if (!saved || (saved.state !== 'pending' && saved.state !== 'published'))
      throw stale('Library identity work requires an admitted native job');
    const previous = saved.participants[step];
    if (previous) {
      const receipt = previous.receipt;
      if (
        previous.state !== 'complete' ||
        previous.job.jobId !== job.jobId ||
        previous.job.epoch !== job.epoch ||
        receipt.job.jobId !== job.jobId ||
        receipt.job.epoch !== job.epoch ||
        receipt.step !== step ||
        receipt.version !== 1
      )
        throw new IdentityEpochStoreError('identity_step_receipt_invalid', 'Library identity receipt scope is invalid');
      return identityEpochStore.reconcileStepReceipt(pool, receipt);
    }
    if (saved.state !== 'pending') throw stale('Published identity job is missing its ALL-Library receipt');
    const pending = await runCommand(pool, { partition: identityJobPartition(job), deadline }, async (tx) => {
      const result = await tx.query<QueuedEffect>(
        `SELECT original,effect_key,role,receiving_partition,receiving_epoch,
              receiving_position::text,receiving_transaction_id::text
       FROM library.identity_epoch_participant_work
       WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND NOT custodied
       ORDER BY effect_key LIMIT 1`,
        [identityJobPartition(job), job.jobId, job.epoch.toString()],
      );
      return noEffect(result.rows[0] ?? null);
    });
    if (pending.value) await applySourceInvalidation(pool, job, pending.value, deadline);
    // No complete step/native ACK. Invalidation is only part of the ALL-role contract.
    // Empty registration cannot prove current birth/first-apply/late-writer closure.
    throw unavailable(
      'ALL-Library identity remains pending: complete six-driver Source rebuild/OLD/NEW manifests, ' +
        'owner candidate/winner and first-apply coverage, follow pair/support/total/outgoing/negative/fences, ' +
        'cross-home owner custody and public/frozen output authority are not bound',
    );
  });
