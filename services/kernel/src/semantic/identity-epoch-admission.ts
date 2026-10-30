import { IDENTITY_EPOCH_PROGRESS } from './events.ts';
import {
  claimIdentityBinding,
  lookupIdentityBinding,
  identityBindingData,
  identityBindingDigest,
  identityBindingJob,
  acceptIdentityBinding,
  type IdentityReceiptBinding,
  type IdentityAdmissionSource,
} from './identity-epoch-binding.ts';
import sourcePoints from './identity-epoch-read-sources.sql';
import handoff from './identity-epoch-admission-handoff.sql';
import inputs from './identity-epoch-admission-inputs.sql';
import holdSource from './identity-epoch-admission-hold-source.sql';
import waiters from './identity-epoch-admission-waiters.sql';
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
  type CommandTransaction,
} from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
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
import type { IdentityIntent, IdentityJobRef, NativeStepWork } from './identity-epoch-contract.ts';

export type { IdentityAdmissionInput, IdentityAdmissionAuthority } from './identity-epoch-contract.ts';
import type { IdentityAdmissionInput, IdentityAdmissionAuthority } from './identity-epoch-contract.ts';
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
async function capture(pool: Pool, input: IdentityAdmissionInput): Promise<IdentityAdmissionSource[]> {
  const ids = idsOf(input.intent);
  const points = [];
  for (const home of [...new Set(ids.map((id) => partitionOf(routed(id))))]) {
    const local = ids.filter((id) => partitionOf(routed(id)) === home);
    const rows = await withReadTransaction(pool, async (tx) => {
      const owner = await readPartition(tx, home);
      if (!owner || owner.writeState !== 'active') throw unavailable();
      const rows = (await tx.query(sourcePoints.sql, [local, local.map(routed)])).rows;
      if (rows.length !== local.length) throw unavailable();
      return rows.map((row) => {
        if (
          !row.original ||
          row.owner_epoch !== owner.epoch ||
          BigInt(row.dirty_revision) !== BigInt(row.captured_revision) ||
          (row.current_target ?? row.original) !== row.control_group
        )
          throw unavailable();
        return { ...row, source_owner_epoch: owner.epoch };
      });
    });
    points.push(...rows);
  }
  const result: IdentityAdmissionSource[] = [];
  for (const home of [...new Set(points.map((p) => p.control_partition))]) {
    const local = points.filter((p) => p.control_partition === home);
    const rows = await withReadTransaction(pool, async (tx) => {
      const owner = await readPartition(tx, home);
      if (!owner || owner.writeState !== 'active') throw unavailable();
      return (
        await tx.query(
          `SELECT * FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=ANY($2::uuid[])`,
          [home, local.map((p) => p.control_group)],
        )
      ).rows.filter((g) => g.owner_epoch === owner.epoch);
    });
    for (const point of local) {
      const group = rows.find((g) => g.terminal === point.control_group);
      if (!group) throw unavailable();
      if (group.pending_job)
        throw new IdentityEpochStoreError('identity_epoch_busy', 'An input group is already claimed');
      if (!group.ready) {
        const ready = await withReadTransaction(
          pool,
          async (tx) =>
            (await readIdentityEpochCutover(tx)).state === 'ready' &&
            !!(await tx.query(bootstrapHome.sql, [point.route >> 4])).rows[0]?.sealed_generation,
        );
        if (!ready) throw unavailable();
      }
      result.push({
        ...group,
        input_original: point.original,
        source_route: point.route,
        source_revision: point.source_revision,
        source_transaction_id: point.recorded_transaction_id,
        source_owner_epoch: point.source_owner_epoch,
      });
    }
  }
  return result.sort((a, b) => a.input_original.localeCompare(b.input_original));
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

/** Bind is a released native actor/account-home command, preceding any group-home transaction. */
export async function bindIdentityEpochReceipt(
  pool: Pool,
  authority: IdentityAdmissionAuthority,
  input: IdentityAdmissionInput,
): Promise<IdentityReceiptBinding> {
  const existing = await lookupIdentityBinding(pool, authority, input);
  if (existing) {
    const data = identityBindingData(existing);
    if (data.state === 'accepted') return existing;
    if (data.state === 'pending' && (await identityBindingJob(pool, data))) {
      await acceptIdentityBinding(pool, authority, input, existing);
      return (await lookupIdentityBinding(pool, authority, input))!;
    }
  }
  const first = await capture(pool, input),
    second = await capture(pool, input);
  if (fingerprint(first) !== fingerprint(second)) throw unavailable();
  const groups = [...new Map(second.map((r) => [r.terminal, r])).values()];
  const intent = input.intent;
  const resulting =
    intent.kind === 'merge'
      ? groups.reduce((n, r) => n + BigInt(r.observed_count), 0n)
      : intent.kind === 'repoint'
        ? BigInt(second.find((r) => r.input_original === intent.terminal)!.observed_count) +
          (groups.length === 1 ? 0n : 1n)
        : 1n;
  if (resulting > 4096n)
    throw new IdentityEpochStoreError(
      'identity_group_overflow',
      'Resulting identity group exceeds 4096 complete originals',
    );
  const home = Math.min(...groups.map((r) => r.partition_no));
  const state = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query(
          `SELECT c.*,EXISTS(SELECT 1 FROM semantic.identity_epoch_job j WHERE j.partition_no=c.partition_no AND j.state='cancelling') retained_preparation FROM semantic.identity_epoch_control c WHERE c.partition_no=$1`,
          [home],
        )
      ).rows[0],
  );
  if (!state || state.pending_job || state.retained_preparation) throw unavailable();
  const scope = createHash('sha256')
    .update(json([input.intent, fingerprint(second)]))
    .digest('hex');
  if (existing && identityBindingData(existing).state === 'pending') {
    const prior = identityBindingData(existing);
    if (prior.scope === scope && prior.job.epoch === BigInt(state.allocated_epoch) + 1n) return existing;
    if (!(await closeUnreservedBinding(pool, authority, input, existing))) {
      await acceptIdentityBinding(pool, authority, input, existing);
      return (await lookupIdentityBinding(pool, authority, input))!;
    }
  }
  return claimIdentityBinding(pool, authority, input, {
    home,
    epoch: BigInt(state.allocated_epoch) + 1n,
    scope,
    sources: second,
  });
}

/** Exact first-absence proof precedes retirement; every uncertain/planned home is irreversibly closed. */
async function closeUnreservedBinding(
  pool: Pool,
  authority: IdentityAdmissionAuthority,
  input: IdentityAdmissionInput,
  binding: IdentityReceiptBinding,
) {
  const data = identityBindingData(binding);
  const first = await runCommand(pool, { partition: data.home }, async (tx) => {
    await tx.query(selectControl.sql, [data.home]);
    const job = (await tx.query(job.sql, [data.home, data.job.jobId, data.job.epoch.toString()])).rows[0];
    if (job) return noEffect(false);
    const duplicate = (await tx.query(receipt.sql, [data.home, data.job.jobId, data.job.epoch.toString(), 'closed']))
      .rows[0];
    if (duplicate) return noEffect(true);
    await tx.query(close.sql, [data.home, data.job.jobId, data.job.epoch.toString(), data.scope]);
    recordIdentityEpochNativeCommit(tx, 'admission');
    registerCommandCallback(tx, async (id) => {
      await tx.query(record.sql, [data.home, id, data.job.jobId, 'closed']);
    });
    return {
      value: true,
      events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: currentCommand(tx).partition } }],
    };
  });
  if (!first.value) return false;
  const receipts = [];
  for (const home of [...new Set(data.sources.map((s) => s.partition_no))].sort((a, b) => a - b)) {
    await deliverHome(pool, data.job, data.scope, home, 'closed');
    const received = await receivingReceipt(pool, data.job, home, 'closed');
    if (!received) throw unavailable();
    receipts.push(received);
  }
  await runCommand(pool, { ...authority, partition: data.partition }, async (tx) => {
    const current = await lookupLocalBinding(tx, input, binding);
    if (current.state !== 'pending') return noEffect(null);
    for (const r of receipts)
      await tx.query(
        `INSERT INTO semantic.identity_epoch_receipt_closure VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          data.partition,
          data.key,
          data.generation,
          r.partition_no,
          r.transaction_id,
          r.native_epoch,
          r.native_position,
        ],
      );
    await tx.query(
      `UPDATE semantic.identity_epoch_receipt_binding SET state='not-applied' WHERE partition_no=$1 AND receipt_key=$2 AND generation=$3 AND state='pending'`,
      [data.partition, data.key, data.generation],
    );
    return {
      value: null,
      events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: currentCommand(tx).partition } }],
    };
  });
  return true;
}
async function lookupLocalBinding(
  tx: CommandTransaction,
  input: IdentityAdmissionInput,
  binding: IdentityReceiptBinding,
) {
  authorizeIdentityAdmission(tx, input.receipt);
  const data = identityBindingData(binding);
  if (currentCommand(tx).partition !== data.partition || data.digest !== identityBindingDigest(input))
    throw new IdempotencyConflictError(currentCommand(tx).partition);
  return data;
}

/** The supplied proof was committed and verified before this command acquired its connection. */
export async function admitBoundIdentityEpoch(
  tx: CommandTransaction,
  input: IdentityAdmissionInput & { binding: IdentityReceiptBinding },
  immediate = false,
) {
  authorizeIdentityAdmission(tx, input.receipt);
  const data = identityBindingData(input.binding),
    home = currentCommand(tx).partition;
  if (data.digest !== identityBindingDigest(input)) throw new IdempotencyConflictError(home);
  if (data.home !== home || data.state === 'not-applied') throw stale();
  if (data.state === 'accepted') return noEffect(data.job);
  const state = (await tx.query(selectControl.sql, [home])).rows[0];
  const prior = (await tx.query(job.sql, [home, data.job.jobId, data.job.epoch.toString()])).rows[0];
  if (prior) return noEffect(data.job);
  const closed = (
    await tx.query(`SELECT state FROM semantic.identity_epoch_admission_attempt WHERE partition_no=$1 AND job_id=$2`, [
      home,
      data.job.jobId,
    ])
  ).rows[0];
  if (closed?.state === 'closed') throw stale();
  const groups = [...new Map(data.sources.map((s) => [s.terminal, s])).values()];
  const localSources = data.sources
    .filter((s) => s.source_route >> 4 === home)
    .map((s) => ({
      original: s.input_original,
      route: s.source_route,
      control_partition: s.partition_no,
      terminal: s.terminal,
      source_revision: s.source_revision,
      source_transaction_id: s.source_transaction_id,
      source_owner_epoch: s.source_owner_epoch,
    }));
  for (const source of localSources)
    await tx.query(`SELECT original FROM semantic.identity_epoch_dirty WHERE route=$1 AND original=$2 FOR UPDATE`, [
      source.route,
      source.original,
    ]);
  if (
    localSources.length &&
    (await tx.query(holdSource.sql, [json(localSources), home])).rows.length !== localSources.length
  )
    throw stale();
  const locked = (
    await tx.query(selectGroups.sql, [home, groups.filter((g) => g.partition_no === home).map((g) => g.terminal)])
  ).rows;
  if (locked.some((g) => g.pending_job))
    throw new IdentityEpochStoreError('identity_epoch_busy', 'An input group is already claimed');
  if (!state || state.pending_job || state.retained_preparation) throw unavailable();
  if (
    BigInt(state.allocated_epoch) + 1n !== data.job.epoch ||
    locked.length !== groups.filter((g) => g.partition_no === home).length ||
    locked.some(
      (g) =>
        !groups.some(
          (b) =>
            b.terminal === g.terminal &&
            b.generation === g.generation &&
            BigInt(b.version) === BigInt(g.version) &&
            b.owner_epoch === g.owner_epoch,
        ),
    )
  )
    throw stale();
  recordIdentityEpochNativeCommit(tx, 'admission');
  registerCommandCallback(tx, async (transactionId) => {
    await tx.query(insertJob.sql, [
      home,
      data.job.jobId,
      data.job.epoch.toString(),
      json(input.intent),
      identityReceiptKey(input.receipt),
      json(identityReceiptValue(input.receipt)),
      data.scope,
      transactionId,
    ]);
    await tx.query(insertBases.sql, [home, data.job.jobId, json(data.sources)]);
    await tx.query(handoff.sql, [
      home,
      data.job.jobId,
      data.job.epoch.toString(),
      data.scope,
      home,
      transactionId,
      json(
        groups
          .filter((g) => g.partition_no === home)
          .map((g) => ({
            terminal: g.terminal,
            generation: g.generation,
            basis_version: g.version,
            owner_epoch: g.owner_epoch,
          })),
      ),
    ]);
    await tx.query(acquire.sql, [home, data.job.jobId, data.job.epoch.toString(), data.scope]);
    await tx.query(record.sql, [home, transactionId, data.job.jobId, 'acquired']);
    if (
      immediate &&
      groups.every((g) => g.partition_no === home) &&
      data.sources.every((s) => s.source_route >> 4 === home)
    ) {
      const r = (await tx.query(receipt.sql, [home, data.job.jobId, data.job.epoch.toString(), 'acquired'])).rows[0];
      await tx.query(custodyAcquire.sql, [
        data.job.jobId,
        home,
        r.transaction_id,
        r.native_epoch,
        r.native_position,
        home,
      ]);
      await tx.query(promote.sql, [data.job.jobId, data.job.epoch.toString(), home]);
    }
  });
  return { value: data.job, events: [wake(data.job)] };
}

/** Coherent cap proof, binding-home claim, first ordered reservation, separate accepted publication. */
export async function prepareIdentityEpochAdmission(
  pool: Pool,
  authority: IdentityAdmissionAuthority,
  input: IdentityAdmissionInput,
): Promise<IdentityJobRef> {
  const binding = await bindIdentityEpochReceipt(pool, authority, input),
    data = identityBindingData(binding);
  if (data.state === 'accepted') return data.job;
  const admitted = await runCommand(pool, { ...authority, partition: data.home }, (tx) =>
    admitBoundIdentityEpoch(tx, { ...input, binding }),
  );
  await acceptIdentityBinding(pool, authority, input, binding);
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
    const retainedInputs = (await measuredQuery(tx, inputs.sql, [home, ref.jobId], measured)).rows;
    return { saved, planned, bases, inputs: retainedInputs };
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

async function deliverHome(
  pool: Pool,
  ref: IdentityJobRef,
  scope: string,
  home: number,
  stage: 'acquired' | 'closed',
  measured?: Work,
) {
  try {
    if (stage === 'acquired') {
      const retained = await load(pool, ref, measured);
      if (retained.saved.scope_digest !== scope || !retained.planned.some((p) => p.resource_home === home))
        throw stale();
      const source = await withReadTransaction(
        pool,
        async (tx) =>
          (
            await tx.query(
              `SELECT c.transaction_id FROM semantic.identity_epoch_job j JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(j.partition_no,j.recorded_transaction_id) AND c.purpose='admission' JOIN core.partition p ON p.partition_no=j.partition_no AND p.epoch=c.epoch AND p.position>=c.position AND p.write_state='active' WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3`,
              [identityJobPartition(ref), ref.jobId, ref.epoch.toString()],
            )
          ).rows[0],
      );
      if (!source) throw unavailable();
      await runCommand(pool, { partition: home }, async (tx) => {
        const duplicate = (
          await tx.query(
            `SELECT job_id FROM semantic.identity_epoch_admission_handoff WHERE partition_no=$1 AND job_id=$2`,
            [home, ref.jobId],
          )
        ).rows[0];
        if (duplicate) return noEffect(null);
        await tx.query(handoff.sql, [
          home,
          ref.jobId,
          ref.epoch.toString(),
          scope,
          identityJobPartition(ref),
          source.transaction_id,
          json(retained.inputs.filter((i) => i.control_partition === home)),
        ]);
        return {
          value: null,
          events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: currentCommand(tx).partition } }],
        };
      });
    }
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
    await tx.query(cancel.sql, [ref.jobId, ref.epoch.toString(), identityJobPartition(ref)]);
    return { value: null, events: [wake(ref)] };
  });
}

/** Released source validation installs native local writer obligations before job-home custody. */
async function validateSources(
  pool: Pool,
  ref: IdentityJobRef,
  saved: { scope_digest: string },
  bases: readonly Record<string, unknown>[],
  measured: Work,
) {
  const home = identityJobPartition(ref);
  for (const base of bases) {
    const sourceHome = Number(base.route) >> 4;
    const active = await withReadTransaction(pool, async (tx) => await readPartition(tx, sourceHome));
    if (!active || active.writeState !== 'active' || active.epoch !== base.source_owner_epoch) return false;
    const held = await runCommand(pool, { partition: sourceHome }, async (tx) => {
      await measuredQuery(
        tx,
        `SELECT original FROM semantic.identity_epoch_dirty WHERE route=$1 AND original=$2 FOR UPDATE`,
        [base.route, base.original],
        measured,
      );
      const valid = (await measuredQuery(tx, holdSource.sql, [json([base]), sourceHome], measured)).rows;
      if (valid.length !== 1) return noEffect(false);
      const prior = (
        await measuredQuery(
          tx,
          `SELECT scope_digest,closed FROM semantic.identity_epoch_admission_source_hold WHERE partition_no=$1 AND job_id=$2 AND original=$3`,
          [sourceHome, ref.jobId, base.original],
          measured,
        )
      ).rows[0];
      if (prior) return noEffect(!prior.closed && prior.scope_digest === saved.scope_digest);
      recordIdentityEpochNativeCommit(tx, 'admission');
      registerCommandCallback(tx, async (id) => {
        await measuredQuery(
          tx,
          `INSERT INTO semantic.identity_epoch_admission_source_hold(partition_no,job_id,job_epoch,original,route,scope_digest,basis,transaction_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [sourceHome, ref.jobId, ref.epoch.toString(), base.original, base.route, saved.scope_digest, json(base), id],
          measured,
        );
      });
      return {
        value: true,
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: currentCommand(tx).partition } }],
      };
    });
    if (!held.value) return false;
    const received = await withReadTransaction(
      pool,
      async (tx) =>
        (
          await measuredQuery(
            tx,
            `SELECT h.transaction_id,c.epoch,c.position FROM semantic.identity_epoch_admission_source_hold h JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(h.partition_no,h.transaction_id) AND c.purpose='admission' AND c.xmin=h.xmin JOIN core.partition p ON p.partition_no=h.partition_no AND p.epoch=c.epoch AND p.position>=c.position AND p.write_state='active' WHERE h.partition_no=$1 AND h.job_id=$2 AND h.original=$3 AND NOT h.closed AND h.scope_digest=$4`,
            [sourceHome, ref.jobId, base.original, saved.scope_digest],
            measured,
          )
        ).rows[0],
    );
    if (!received) return false;
    await runCommand(pool, { partition: home }, async (tx) => {
      const prior = (
        await measuredQuery(
          tx,
          `SELECT original FROM semantic.identity_epoch_admission_validation WHERE partition_no=$1 AND job_id=$2 AND original=$3`,
          [home, ref.jobId, base.original],
          measured,
        )
      ).rows[0];
      if (prior) return noEffect(null);
      await measuredQuery(
        tx,
        `INSERT INTO semantic.identity_epoch_admission_validation VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [home, ref.jobId, base.original, sourceHome, received.transaction_id, received.epoch, received.position],
        measured,
      );
      return {
        value: null,
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: currentCommand(tx).partition } }],
      };
    });
  }
  // Receiving owner/generation evidence is independently anchored at each actual group home.
  for (const controlHome of [...new Set(bases.map((b) => Number(b.control_partition)))]) {
    const valid = await withReadTransaction(pool, async (tx) => {
      const owner = await readPartition(tx, controlHome);
      if (!owner || owner.writeState !== 'active') return false;
      const groups = (
        await measuredQuery(
          tx,
          `SELECT * FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=ANY($2::uuid[])`,
          [controlHome, bases.filter((b) => b.control_partition === controlHome).map((b) => b.terminal)],
          measured,
        )
      ).rows;
      return bases
        .filter((b) => b.control_partition === controlHome)
        .every((b) =>
          groups.some(
            (g) =>
              g.terminal === b.terminal &&
              g.generation === b.generation &&
              BigInt(g.version) === BigInt(String(b.basis_version)) &&
              g.owner_epoch === owner.epoch &&
              g.owner_epoch === b.owner_epoch &&
              g.pending_job === ref.jobId &&
              BigInt(g.pending_epoch) === ref.epoch,
          ),
        );
    });
    if (!valid) return false;
  }
  return true;
}
async function releaseSourceHolds(pool: Pool, ref: IdentityJobRef, bases: readonly Record<string, unknown>[]) {
  for (const home of [...new Set(bases.map((b) => Number(b.route) >> 4))]) {
    await runCommand(pool, { partition: home }, async (tx) => {
      const changed = await tx.query(
        `UPDATE semantic.identity_epoch_admission_source_hold SET closed=true WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND NOT closed RETURNING original`,
        [home, ref.jobId, ref.epoch.toString()],
      );
      return changed.rowCount
        ? {
            value: null,
            events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: currentCommand(tx).partition } }],
          }
        : noEffect(null);
    });
  }
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
        identityJobPartition(ref),
      ]);
      if (recorded.rowCount !== 1) throw stale();
      return { value: null, events: [wake(ref)] };
    });
    return { job: ref, state: saved.state, work: { ...measured, rows: 1 } };
  }
  const valid = closing || (await validateSources(pool, ref, saved, bases, measured));
  if (closing) await releaseSourceHolds(pool, ref, bases);
  const finalized = await runCommand<IdentityAdmissionProgress['state']>(
    pool,
    { partition: identityJobPartition(ref) },
    async (tx) => {
      const current = (await query(tx, lockJob.sql, [identityJobPartition(ref), ref.jobId, ref.epoch.toString()]))
        .rows[0];
      if (!current) throw unavailable();
      if (current.state !== saved.state) return noEffect(current.state);
      const retainedValid = closing
        ? bases.length
        : (await query(tx, validBases.sql, [ref.jobId, identityJobPartition(ref)])).rows.length;
      if (!closing && (!valid || retainedValid !== bases.length)) {
        await query(tx, cancel.sql, [ref.jobId, ref.epoch.toString(), identityJobPartition(ref)]);
        return { value: 'cancelling', events: [wake(ref)] };
      }
      const changed = await query(tx, (closing ? finishClose : promote).sql, [
        ref.jobId,
        ref.epoch.toString(),
        identityJobPartition(ref),
      ]);
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
