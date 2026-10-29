import waiters from './identity-epoch-admission-waiters.sql';
import collect from './identity-epoch-admission-collect.sql';
import insertJob from './identity-epoch-admission-insert-job.sql';
import insertBases from './identity-epoch-admission-insert-bases.sql';
import acquire from './identity-epoch-admission-acquire.sql';
import close from './identity-epoch-admission-close.sql';
import record from './identity-epoch-admission-record.sql';
import receipt from './identity-epoch-admission-receipt.sql';
import job from './identity-epoch-admission-job.sql';
import lockJob from './identity-epoch-admission-lock-job.sql';
import plans from './identity-epoch-admission-plans.sql';
import sources from './identity-epoch-admission-sources.sql';
import custodyAcquire from './identity-epoch-admission-custody-acquire.sql';
import custodyClose from './identity-epoch-admission-custody-close.sql';
import promote from './identity-epoch-admission-promote.sql';
import cancel from './identity-epoch-admission-cancel.sql';
import finishClose from './identity-epoch-admission-finish-close.sql';
import validBases from './identity-epoch-admission-valid-bases.sql';
import selectControl from './identity-epoch-store-select-control-2.sql';
import selectGroups from './identity-epoch-store-select-group.sql';
import priorJob from './identity-epoch-store-select-job-3.sql';
import bootstrapHome from './identity-epoch-store-select-bootstrap-home.sql';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  currentCommand,
  registerCommandCallback,
  runCommand,
  noEffect,
  IdempotencyConflictError,
  type CommandBasis,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from './read.ts';
import { readIdentityEpochCutover } from './identity-epoch-bootstrap.ts';
import { IDENTITY_EPOCH_ADMITTED, IDENTITY_EPOCH_HOME_AVAILABLE } from './events.ts';
import {
  IdentityEpochStoreError,
  identityJobPartition,
  authorizeIdentityAdmission,
  identityReceiptKey,
  identityReceiptValue,
  serializeIdentityValue as json,
  recordIdentityEpochNativeCommit,
} from './identity-epoch-store.ts';
import type { IdentityIntent, IdentityReceipt, IdentityJobRef, NativeStepWork } from './identity-epoch-contract.ts';

export type IdentityAdmissionInput = Readonly<{ intent: IdentityIntent; receipt: IdentityReceipt }>;
export type IdentityAdmissionAuthority = Readonly<{
  basis?: CommandBasis;
  authorization?: CommandAuthorization;
  deadline?: number;
  clock?: () => Date;
}>;
export type IdentityAdmissionProgress = Readonly<{
  job: IdentityJobRef;
  state: 'preparing' | 'pending' | 'cancelling' | 'cancelled' | 'published';
  work: NativeStepWork;
}>;
type Work = { -readonly [K in keyof NativeStepWork]: NativeStepWork[K] };
const work = (): Work => ({ rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 });
async function measuredQuery(tx: CommandTransaction, sql: string, values: unknown[], measured?: Work) {
  const result = await tx.query(sql, values);
  if (measured) {
    measured.statements++;
    measured.points += result.rowCount ?? 0;
    measured.bytes += Buffer.byteLength(json(result.rows));
  }
  return result;
}
const unavailable = () =>
  new IdentityEpochStoreError(
    'identity_epoch_unavailable',
    'Native identity preparation is not current or local capacity is occupied',
  );
const stale = () => new IdentityEpochStoreError('identity_effect_stale', 'Native identity preparation basis changed');
const wake = (job: IdentityJobRef) => ({
  type: IDENTITY_EPOCH_ADMITTED,
  data: { jobId: job.jobId, epoch: job.epoch.toString(), partition: identityJobPartition(job) },
});
function routed(id: string) {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Identity input must be a native routed ID');
  return route;
}
function idsOf(intent: IdentityIntent) {
  return [
    ...new Set(
      intent.kind === 'merge'
        ? [intent.redirected, intent.survivor]
        : intent.kind === 'repoint'
          ? [intent.original, intent.terminal]
          : [intent.original],
    ),
  ];
}
function sameReceipt(saved: { intent: unknown; receipt: unknown }, input: IdentityAdmissionInput) {
  return (
    canonicalize(saved.intent) === canonicalize(JSON.parse(json(input.intent))) &&
    canonicalize(saved.receipt) === canonicalize(identityReceiptValue(input.receipt))
  );
}
async function replay(tx: CommandTransaction, input: IdentityAdmissionInput): Promise<IdentityJobRef | null> {
  const prior = (await tx.query(priorJob.sql, [identityReceiptKey(input.receipt)])).rows[0];
  if (!prior) return null;
  if (!sameReceipt(prior, input)) throw new IdempotencyConflictError(currentCommand(tx).partition);
  return { jobId: prior.job_id, epoch: BigInt(prior.epoch) };
}
async function capture(pool: Pool, input: IdentityAdmissionInput) {
  const ids = idsOf(input.intent);
  return withReadTransaction(pool, async (tx) => {
    const rows = (await tx.query(collect.sql, [ids, ids.map(routed)])).rows;
    if (rows.length !== ids.length) throw unavailable();
    for (const row of rows) {
      if (row.pending_job)
        throw new IdentityEpochStoreError('identity_epoch_busy', 'An input group is already claimed');
      if (
        !row.ready &&
        ((await readIdentityEpochCutover(tx)).state !== 'ready' ||
          !(await tx.query(bootstrapHome.sql, [row.source_route >> 4])).rows[0]?.sealed_generation)
      )
        throw unavailable();
    }
    return rows.sort((a, b) => a.input_original.localeCompare(b.input_original));
  });
}
function fingerprint(rows: Awaited<ReturnType<typeof capture>>) {
  return canonicalize(
    rows.map((r) => [
      r.input_original,
      r.source_route,
      r.source_revision,
      r.source_transaction_id,
      r.source_owner_epoch,
      r.partition_no,
      r.terminal,
      r.generation,
      r.version,
      r.observed_count,
      r.owner_epoch,
    ]),
  );
}

/** Effects-free coherent cap collection, then an atomic first native reservation. Never a public success DTO. */
export async function prepareIdentityEpochAdmission(
  pool: Pool,
  authority: IdentityAdmissionAuthority,
  input: IdentityAdmissionInput,
): Promise<IdentityJobRef> {
  const ids = idsOf(input.intent);
  const authorizationHome = Math.min(...ids.map((id) => partitionOf(routed(id))));
  const prior = await runCommand(pool, { ...authority, partition: authorizationHome }, async (tx) => {
    authorizeIdentityAdmission(tx, input.receipt);
    return noEffect(await replay(tx, input));
  });
  if (prior.value) return prior.value;
  const first = await capture(pool, input);
  const second = await capture(pool, input);
  if (fingerprint(first) !== fingerprint(second)) throw unavailable();
  const groups = [...new Map(second.map((r) => [r.generation, r])).values()];
  const intent = input.intent;
  const resulting =
    intent.kind === 'merge'
      ? groups.reduce((n, r) => n + BigInt(r.observed_count), 0n)
      : intent.kind === 'repoint'
        ? BigInt(second.find((r) => r.input_original === intent.terminal)!.observed_count) +
          (groups.length === 1 ? 0n : 1n)
        : 1n;
  const home = Math.min(...groups.map((r) => r.partition_no));
  const admitted = await runCommand(pool, { ...authority, partition: home }, async (tx) => {
    authorizeIdentityAdmission(tx, input.receipt);
    const prior = await replay(tx, input);
    if (prior) return noEffect(prior);
    if (resulting > 4096n)
      throw new IdentityEpochStoreError(
        'identity_group_overflow',
        'Resulting identity group exceeds 4096 complete originals',
      );
    const state = (await tx.query(selectControl.sql, [home])).rows[0];
    const locked = (
      await tx.query(selectGroups.sql, [home, groups.filter((r) => r.partition_no === home).map((r) => r.terminal)])
    ).rows;
    if (locked.some((r) => r.pending_job))
      throw new IdentityEpochStoreError('identity_epoch_busy', 'An input group is already claimed');
    if (!state || state.pending_job) throw unavailable();
    if (
      locked.some((r) => !groups.some((g) => g.generation === r.generation && BigInt(g.version) === BigInt(r.version)))
    )
      throw stale();
    const ref = { jobId: newId(home * 16), epoch: BigInt(state.allocated_epoch) + 1n };
    const scope = createHash('sha256')
      .update(json([input.intent, fingerprint(second)]))
      .digest('hex');
    recordIdentityEpochNativeCommit(tx, 'admission');
    registerCommandCallback(tx, async (transactionId) => {
      await tx.query(insertJob.sql, [
        home,
        ref.jobId,
        ref.epoch.toString(),
        json(input.intent),
        identityReceiptKey(input.receipt),
        json(identityReceiptValue(input.receipt)),
        scope,
        transactionId,
      ]);
      await tx.query(insertBases.sql, [home, ref.jobId, json(second)]);
      await tx.query(acquire.sql, [home, ref.jobId, ref.epoch.toString(), scope]);
      await tx.query(record.sql, [home, transactionId, ref.jobId, 'acquired']);
    });
    return { value: ref, events: [wake(ref)] };
  });
  return admitted.value;
}

async function load(pool: Pool, ref: IdentityJobRef, measured?: Work) {
  return withReadTransaction(pool, async (tx) => {
    const home = identityJobPartition(ref);
    const saved = (await measuredQuery(tx, job.sql, [home, ref.jobId, ref.epoch.toString()], measured)).rows[0];
    const owner = await readPartition(tx, home);
    if (measured) {
      measured.statements++;
      measured.points += owner ? 1 : 0;
    }
    if (!saved || !owner || owner.writeState !== 'active') throw unavailable();
    const planned = (await measuredQuery(tx, plans.sql, [home, ref.jobId], measured)).rows;
    const bases = (await measuredQuery(tx, sources.sql, [home, ref.jobId], measured)).rows;
    return { saved, planned, bases };
  });
}
function translate(error: unknown): never {
  if (
    error instanceof Error &&
    ['identity_epoch_busy', 'identity_epoch_unavailable', 'identity_effect_stale'].includes(error.message)
  )
    throw new IdentityEpochStoreError(error.message, error.message);
  throw error;
}
async function receivingReceipt(
  pool: Pool,
  ref: IdentityJobRef,
  home: number,
  stage: 'acquired' | 'closed',
  measured?: Work,
) {
  return withReadTransaction(pool, async (tx) => {
    const saved = (await measuredQuery(tx, receipt.sql, [home, ref.jobId, ref.epoch.toString(), stage], measured))
      .rows[0];
    if (!saved) return null;
    if (
      saved.write_state !== 'active' ||
      saved.native_epoch !== saved.owner_epoch ||
      BigInt(saved.native_position) > BigInt(saved.owner_position)
    )
      throw unavailable();
    return saved;
  });
}

async function deliverHome(pool: Pool, ref: IdentityJobRef, scope: string, home: number, stage: 'acquired' | 'closed') {
  try {
    await runCommand(pool, { partition: home }, async (tx) => {
      await measuredQuery(tx, selectControl.sql, [home], measured);
      // Acquire always checks the irreversible local fence, even after an earlier successful receipt.
      if (stage === 'acquired')
        await measuredQuery(tx, acquire.sql, [home, ref.jobId, ref.epoch.toString(), scope], measured);
      const duplicate = (await measuredQuery(tx, receipt.sql, [home, ref.jobId, ref.epoch.toString(), stage], measured))
        .rows[0];
      if (duplicate) return noEffect(null);
      if (stage === 'closed')
        await measuredQuery(tx, close.sql, [home, ref.jobId, ref.epoch.toString(), scope], measured);
      recordIdentityEpochNativeCommit(tx, 'admission');
      registerCommandCallback(tx, async (transactionId) => {
        const recorded = await measuredQuery(tx, record.sql, [home, transactionId, ref.jobId, stage], measured);
        if (recorded.rowCount !== 1) throw stale();
      });
      return { value: null, events: [wake(ref), ...(stage === 'closed' ? [identityHomeAvailable(home)] : [])] };
    });
  } catch (error) {
    translate(error);
  }
}

/** Receiving-home RPC used by recovery. A lost response never allocates a replacement attempt. */
export async function acquireIdentityEpochAdmissionHome(pool: Pool, ref: IdentityJobRef, home: number): Promise<void> {
  const { saved, planned } = await load(pool, ref);
  if (!planned.some((p) => p.resource_home === home)) throw stale();
  // Disposition is finally enforced by the receiving fence, including first-absence cancellation.
  if (saved.state !== 'preparing') throw stale();
  await deliverHome(pool, ref, saved.scope_digest, home, 'acquired');
}

/** Job-home CAS chooses cancellation. It does not release any slot or claim by itself. */
export async function cancelIdentityEpochAdmission(pool: Pool, ref: IdentityJobRef): Promise<void> {
  await runCommand(pool, { partition: identityJobPartition(ref) }, async (tx) => {
    const saved = (await tx.query(lockJob.sql, [identityJobPartition(ref), ref.jobId, ref.epoch.toString()])).rows[0];
    if (!saved) throw unavailable();
    if (saved.state === 'cancelling' || saved.state === 'cancelled') return noEffect(null);
    if (saved.state !== 'preparing') throw stale();
    await tx.query(cancel.sql, [ref.jobId, ref.epoch.toString()]);
    return { value: null, events: [wake(ref)] };
  });
}

/** One planned home per call. Uncertain delivery is reconciled from its immutable real native receipt. */
export async function stepIdentityEpochAdmission(pool: Pool, ref: IdentityJobRef): Promise<IdentityAdmissionProgress> {
  const measured = work();
  const query = (tx: CommandTransaction, sql: string, values: unknown[]) => measuredQuery(tx, sql, values, measured);
  const { saved, planned, bases } = await load(pool, ref, measured);
  if (!['preparing', 'cancelling'].includes(saved.state)) return { job: ref, state: saved.state, work: measured };
  const closing = saved.state === 'cancelling';
  const stage = closing ? 'closed' : 'acquired';
  const next = planned.find((p) => (closing ? !p.closed_transaction_id : !p.acquired_transaction_id));
  if (next) {
    let received = await receivingReceipt(pool, ref, next.resource_home, stage, measured);
    if (!received) {
      await deliverHome(pool, ref, saved.scope_digest, next.resource_home, stage, measured);
      received = await receivingReceipt(pool, ref, next.resource_home, stage, measured);
    }
    if (!received || received.scope_digest !== saved.scope_digest) throw stale();
    await runCommand(pool, { partition: identityJobPartition(ref) }, async (tx) => {
      const current = (await query(tx, lockJob.sql, [identityJobPartition(ref), ref.jobId, ref.epoch.toString()]))
        .rows[0];
      if (!current || current.scope_digest !== received.scope_digest) throw stale();
      const recorded = await query(tx, (closing ? custodyClose : custodyAcquire).sql, [
        ref.jobId,
        next.resource_home,
        received.transaction_id,
        received.native_epoch,
        received.native_position,
      ]);
      if (recorded.rowCount !== 1) throw stale();
      return { value: null, events: [wake(ref)] };
    });
    return { job: ref, state: saved.state, work: { ...measured, rows: 1 } };
  }
  const finalized = await runCommand<IdentityAdmissionProgress['state']>(
    pool,
    { partition: identityJobPartition(ref) },
    async (tx) => {
      const current = (await query(tx, lockJob.sql, [identityJobPartition(ref), ref.jobId, ref.epoch.toString()]))
        .rows[0];
      if (!current) throw unavailable();
      if (current.state !== saved.state) return noEffect(current.state);
      if (!closing && (await query(tx, validBases.sql, [ref.jobId])).rows.length !== bases.length) {
        await query(tx, cancel.sql, [ref.jobId, ref.epoch.toString()]);
        return { value: 'cancelling', events: [wake(ref)] };
      }
      const changed = await query(tx, (closing ? finishClose : promote).sql, [ref.jobId, ref.epoch.toString()]);
      if (changed.rowCount !== 1) throw stale();
      return { value: closing ? 'cancelled' : 'pending', events: [wake(ref)] };
    },
  );
  return { job: ref, state: finalized.value, work: { ...measured, rows: 1 } };
}

export function identityHomeAvailable(partition: number, after = '00000000-0000-0000-0000-000000000000') {
  return { type: IDENTITY_EPOCH_HOME_AVAILABLE, data: { partition, after } };
}

/** Native release wakes retained waiters through the existing bounded outbox/effect runner. No new queue or timer. */
export async function wakeIdentityEpochAdmissionWaiters(pool: Pool, partition: number, after: string): Promise<void> {
  await runCommand(pool, { partition }, async (tx) => {
    const pending = (await tx.query(waiters.sql, [partition, after])).rows;
    if (!pending.length) return noEffect(null);
    return {
      value: null,
      events: [
        ...pending.map((p) => wake({ jobId: p.job_id, epoch: BigInt(p.epoch) })),
        ...(pending.length === 100 ? [identityHomeAvailable(partition, pending[99]!.job_id)] : []),
      ],
    };
  });
}
