import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  CommandUnavailableError,
  currentCommand,
  currentCommandResources,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceCustody,
  type NativeSourceIdentity,
} from '../library/native-source-custody.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from './read.ts';
import { IDENTITY_EPOCH_ADMITTED } from './events.ts';
import { identityErasureRoles, bindSemanticProducerRoles } from './erasure-producer.ts';
import {
  IdentityEpochStoreError,
  identityJobPartition,
  recordIdentityEpochNativeCommit,
  serializeIdentityValue as json,
} from './identity-epoch-store.ts';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import type {
  IdentityReceivingBinding,
  IdentityReceivingEffect,
  IdentityReceivingRecord,
  IdentityReceivingSelection,
  IdentityReceivingCaptureInput,
  IdentityReceivingCaptureResult,
  IdentityReceivingSource,
  IdentityReceivingProgress,
} from './identity-receiving-effects-types.ts';
import receivingJob from './identity-epoch-store-receiving-job.sql';
import receivingPlan from './identity-epoch-store-receiving-plan.sql';
import receivingLookup from './identity-epoch-store-receiving-lookup.sql';
import receivingSelection from './identity-receiving-selection-read.sql';

export type * from './identity-receiving-effects-types.ts';
const step = 'library-private-follow-counts';
const stale = () =>
  new IdentityEpochStoreError(
    'identity_effect_stale',
    'Missing or stale exact native receiving source, plan, owner or gate',
  );
const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);
/** Identity keys are hints until the selected Source owner validates its native capture and hold. */
function sourceEffectKey(selection: IdentityReceivingSelection, scopeDigest: string, identity: NativeSourceIdentity) {
  const { effectKey: _effectKey, ...source } = identity;
  return createHash('sha256')
    .update(
      canonicalize(
        JSON.parse(
          json({
            job: selection.job,
            original: selection.original,
            effectKey: selection.effectKey,
            owner: selection.owner,
            scope: selection.scope,
            disposition: selection.disposition,
            step,
            version: 1,
            scopeDigest,
            source,
          }),
        ),
      )!,
    )
    .digest('hex');
}
function sourceIdentity(selection: IdentityReceivingSelection, scopeDigest: string, identity: NativeSourceIdentity) {
  if (
    identity.collectionId !== selection.sourceId ||
    selection.owner !== identity.collectionId ||
    partitionOf(identity.route) !== partitionOf(routeOf(selection.owner)!) ||
    identity.receivingEpoch !== selection.job.epoch.toString()
  )
    throw stale();
  return { ...identity, effectKey: sourceEffectKey(selection, scopeDigest, identity) };
}
/** One bounded owner call per continuation; never loop over an unbounded Source in preparation. */
export async function captureIdentityReceivingSource(
  pool: Pool,
  selection: IdentityReceivingSelection,
  input: IdentityReceivingCaptureInput,
): Promise<IdentityReceivingCaptureResult> {
  selected(selection);
  const identity = sourceIdentity(selection, await jobBasis(pool, selection), input.identity);
  const owner = createNativeLibrarySourceCustody({ pool });
  return input.frontier?.driver === 'done'
    ? owner.finishCapture({ ...input, identity, frontier: input.frontier })
    : owner.capturePage({ ...input, identity });
}
/** Per-call local Source plan ceiling. Native owner work remains bounded and charged on every attempt. */
function sourceAllowance(reservationId: string) {
  return {
    reservationId,
    remaining: {
      candidateKeys: 0,
      identityMetadataRows: 0,
      nativeRows: 512,
      nativePoints: 32,
      witnessKeys: 0,
      statements: 16,
      bytes: 262144,
      emptySeeks: 0,
    },
  };
}
function sourceWork(tx: CommandTransaction, holdId: string) {
  return { allowance: sourceAllowance(holdId), deadline: currentCommandResources(tx).deadline };
}
async function holdSource(
  tx: CommandTransaction,
  source: IdentityReceivingSource,
  operation: 'readAndHold' | 'revalidateHold',
): Promise<NativeSourceCustody> {
  const { identity, captureId, holdId } = source.native;
  const result = await createNativeLibrarySourceCustody(currentCommandResources(tx))[operation]({
    client: tx,
    at: currentCommand(tx).time,
    identity,
    captureId,
    holdId,
    ...sourceWork(tx, holdId),
  });
  if (result.status !== 'held') throw unavailable(`Native Source ${operation}: ${result.reason}`);
  // The owner resolved the actual committed capture and retained hold on THIS client; brands are not authority.
  if (
    result.custody.transactionId !== source.provenance.transactionId ||
    result.custody.captureId !== captureId ||
    result.custody.holdId !== holdId
  )
    throw stale();
  return result.custody;
}
const digest = (binding: IdentityReceivingBinding) =>
  createHash('sha256')
    .update(
      canonicalize(
        JSON.parse(
          json({
            job: binding.job,
            original: binding.original,
            effectKey: binding.effectKey,
            owner: binding.owner,
            step: binding.step,
            version: binding.version,
            scopeDigest: binding.scopeDigest,
            source: binding.source,
          }),
        ),
      )!,
    )
    .digest('hex');
const wake = (binding: IdentityReceivingBinding) => ({
  type: IDENTITY_EPOCH_ADMITTED,
  data: { jobId: binding.job.jobId, epoch: binding.job.epoch.toString(), partition: identityJobPartition(binding.job) },
});
const receipt = (
  partition: number,
  transactionId: string,
  epoch: number,
  position: string | bigint,
): IdentityNativeReceipt => ({ partition, transactionId, epoch, position: BigInt(position) });
function decodeReceipt(value: unknown): IdentityNativeReceipt {
  const r = value as IdentityNativeReceipt;
  if (
    !r ||
    !Number.isInteger(r.partition) ||
    !Number.isInteger(r.epoch) ||
    typeof r.transactionId !== 'string' ||
    !/^[0-9]+$/.test(String(r.position))
  )
    throw stale();
  return receipt(r.partition, r.transactionId, r.epoch, r.position);
}
function decodeBinding(value: unknown): IdentityReceivingBinding {
  const b = value as IdentityReceivingBinding;
  if (!b || b.step !== step || b.version !== 1 || !b.source?.native || !b.job) throw stale();
  const identity = sourceIdentity(
    {
      ...b,
      sourceId: b.source.id,
      scope: b.source.scope,
      disposition: b.source.disposition,
      job: { ...b.job, epoch: BigInt(b.job.epoch) },
    },
    b.scopeDigest,
    b.source.native.identity,
  );
  if (
    identity.effectKey !== b.source.native.identity.effectKey ||
    b.source.home !== partitionOf(identity.route) ||
    b.source.receivingHome !== b.source.home ||
    b.source.receivingEpoch !== identity.ownerEpoch ||
    b.source.incarnation !== identity.incarnation ||
    b.source.generation !== identity.generation ||
    b.source.original !== b.original ||
    b.source.effectKey !== b.effectKey ||
    b.source.owner !== b.owner
  )
    throw stale();
  return {
    ...b,
    job: { ...b.job, epoch: BigInt(b.job.epoch) },
    source: { ...b.source, provenance: decodeReceipt(b.source.provenance) },
  };
}
function effectOf(record: IdentityReceivingRecord): IdentityReceivingEffect {
  return {
    kind: 'receiving',
    job: record.job,
    original: record.original,
    effectKey: record.effectKey,
    receipt: record.receipt,
  };
}
function selected(selection: IdentityReceivingSelection) {
  for (const id of [selection.job.jobId, selection.original, selection.owner, selection.sourceId])
    if (routeOf(id) === null) throw stale();
  if (
    selection.job.epoch <= 0n ||
    Buffer.byteLength(selection.effectKey) < 1 ||
    Buffer.byteLength(selection.effectKey) > 256 ||
    Buffer.byteLength(selection.scope) > 256 ||
    !['OLD', 'NEW', 'first-apply', 'handoff'].includes(selection.disposition)
  )
    throw stale();
}
async function jobBasis(pool: Pool, selection: IdentityReceivingSelection) {
  const home = identityJobPartition(selection.job);
  const data = await runCommand(pool, { partition: home }, async (tx) => {
    const job = (await tx.query(receivingJob.sql, [home, selection.job.jobId, selection.job.epoch.toString()])).rows[0];
    if (!job || job.state !== 'pending') throw stale();
    const inputs = (
      await tx.query(
        'SELECT control_partition,terminal,generation,owner_epoch FROM semantic.identity_epoch_input WHERE partition_no=$1 AND job_id=$2 ORDER BY terminal LIMIT 2',
        [home, selection.job.jobId],
      )
    ).rows;
    return noEffect({ scope: job.scope_digest, inputs });
  });
  // Immutable input generations are probed at their own homes, never joined into a foreign job query.
  let member = false;
  for (const input of data.value.inputs) {
    const found = await withReadTransaction(pool, async (tx) => {
      const owner = await readPartition(tx, input.control_partition);
      if (!owner || owner.writeState !== 'active' || owner.epoch !== input.owner_epoch) throw stale();
      return !!(
        await tx.query(
          'SELECT 1 FROM semantic.identity_epoch_original WHERE partition_no=$1 AND generation=$2 AND original=$3 AND terminal=$4 AND present',
          [input.control_partition, input.generation, selection.original, input.terminal],
        )
      ).rowCount;
    });
    member ||= found;
  }
  if (!member) throw stale();
  return data.value.scope;
}
async function planAtHome(pool: Pool, binding: IdentityReceivingBinding) {
  const home = identityJobPartition(binding.job);
  return withReadTransaction(pool, async (tx) => {
    const row = (
      await tx.query(receivingPlan.sql, [home, binding.job.jobId, binding.job.epoch.toString(), binding.effectKey])
    ).rows[0];
    if (!row || row.binding_digest !== digest(binding)) throw stale();
    return receipt(home, row.transaction_id, row.native_epoch, row.native_position);
  });
}
/** Real planned control entry, held Source provenance, then a native accepted record at the receiving home.
 * Only a pending admitted job can register an effect: preparing/cancelling jobs never acquire receiving gates.
 * Every stage is a separate released-home operation; uncertain retries retain the identical plan/key/hold.
 */
export async function prepareIdentityReceivingEffect(
  pool: Pool,
  selection: IdentityReceivingSelection,
): Promise<IdentityReceivingEffect> {
  selected(selection);
  const scopeDigest = await jobBasis(pool, selection);
  const hint = selection.capture;
  if (!hint) throw unavailable('Receiving preparation requires the selected Source native capture frontier');
  const identity = sourceIdentity(selection, scopeDigest, hint.identity);
  if (identity.effectKey !== hint.identity.effectKey) throw stale();
  // A committed accepted record retains native custody even when the business Source later changes.
  // Replay that exact record before asking the owner to finish a still-current capture again.
  const replay = await runCommand(pool, { partition: partitionOf(identity.route) }, async (tx) => {
    const prior = (
      await tx.query(
        `SELECT c.transaction_id,c.epoch,c.position FROM semantic.identity_epoch_receiving_record r
       JOIN semantic.identity_epoch_native_commit c
         ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id)
       WHERE r.partition_no=$1 AND r.job_id=$2 AND r.job_epoch=$3 AND r.effect_key=$4 AND r.original=$5`,
        [
          partitionOf(identity.route),
          selection.job.jobId,
          selection.job.epoch.toString(),
          selection.effectKey,
          selection.original,
        ],
      )
    ).rows[0];
    if (!prior) return noEffect(null);
    const effect: IdentityReceivingEffect = {
      kind: 'receiving',
      job: selection.job,
      original: selection.original,
      effectKey: selection.effectKey,
      receipt: receipt(partitionOf(identity.route), prior.transaction_id, prior.epoch, prior.position),
    };
    const saved = await lookupIdentityReceivingEffect(tx, effect);
    if (
      !saved ||
      saved.scopeDigest !== scopeDigest ||
      saved.owner !== selection.owner ||
      saved.source.id !== selection.sourceId ||
      saved.source.scope !== selection.scope ||
      saved.source.disposition !== selection.disposition ||
      saved.source.native.captureId !== hint.frontier.captureId ||
      canonicalize(saved.source.native.identity) !== canonicalize(identity)
    )
      throw stale();
    return noEffect(effect);
  });
  if (replay.value) return replay.value;
  const completed = await createNativeLibrarySourceCustody({ pool }).finishCapture({
    identity,
    frontier: hint.frontier,
    allowance: sourceAllowance(hint.frontier.captureId),
    deadline: Date.now() + 5000,
  });
  if (completed.status !== 'complete') throw unavailable(`Native Source finishCapture: ${completed.reason}`);
  const capture = completed.capture;
  const homeOfSource = partitionOf(identity.route);
  const holdDigest = createHash('sha256')
    .update(json([identity.effectKey, capture.captureId]))
    .digest('hex');
  const holdId = `${holdDigest.slice(0, 8)}-${holdDigest.slice(8, 12)}-${holdDigest.slice(12, 16)}-${holdDigest.slice(16, 20)}-${holdDigest.slice(20, 32)}`;
  const source: IdentityReceivingSource = {
    id: identity.collectionId,
    incarnation: identity.incarnation,
    generation: identity.generation,
    scope: selection.scope,
    owner: selection.owner,
    home: homeOfSource,
    receivingHome: homeOfSource,
    receivingEpoch: identity.ownerEpoch,
    original: selection.original,
    effectKey: selection.effectKey,
    disposition: selection.disposition,
    provenance: decodeReceipt({
      partition: homeOfSource,
      epoch: identity.ownerEpoch,
      transactionId: capture.transactionId,
      position: capture.position,
    }),
    native: { identity, captureId: capture.captureId, holdId },
  };
  const binding: IdentityReceivingBinding = {
    job: selection.job,
    original: selection.original,
    effectKey: selection.effectKey,
    owner: selection.owner,
    step,
    version: 1,
    scopeDigest,
    source,
  };
  if (Buffer.byteLength(json(binding)) > 3072) throw stale();
  const bindingDigest = digest(binding);
  const roles = await identityErasureRoles(pool, binding.job.jobId);
  const home = identityJobPartition(binding.job);
  await runCommand(pool, { partition: home }, async (tx) => {
    const job = (await tx.query(receivingJob.sql, [home, binding.job.jobId, binding.job.epoch.toString()])).rows[0];
    if (!job || job.state !== 'pending' || job.scope_digest !== scopeDigest) throw stale();
    const prior = (
      await tx.query(
        'SELECT binding_digest FROM semantic.identity_epoch_receiving_plan WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3',
        [home, binding.job.jobId, binding.effectKey],
      )
    ).rows[0];
    if (prior) {
      if (prior.binding_digest !== bindingDigest) throw stale();
      return noEffect(null);
    }
    if (
      (
        await tx.query(
          `SELECT 1 FROM semantic.identity_epoch_ack WHERE partition_no=$1 AND job_id=$2 AND step=$3
      AND progress->>'state'='complete'`,
          [home, binding.job.jobId, step],
        )
      ).rowCount
    )
      throw stale();
    // Register the exact expected obligation BEFORE a remote hold or receiving write can commit.
    await tx.query(
      `INSERT INTO semantic.identity_epoch_effect_receipt(partition_no,job_id,step,effect_key,kind)
      VALUES($1,$2,$3,$4,$5)`,
      [
        home,
        binding.job.jobId,
        step,
        binding.effectKey,
        source.disposition === 'OLD' ? 'remove' : source.disposition === 'handoff' ? 'pending-fence' : 'add',
      ],
    );
    bindSemanticProducerRoles(tx, roles);
    recordIdentityEpochNativeCommit(tx, 'identity-receiving-plan');
    registerCommandCallback(tx, async (id) => {
      await tx.query(
        `INSERT INTO semantic.identity_epoch_receiving_plan(partition_no,job_id,job_epoch,effect_key,binding,binding_digest,transaction_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [home, binding.job.jobId, binding.job.epoch.toString(), binding.effectKey, json(binding), bindingDigest, id],
      );
    });
    return { value: null, events: [wake(binding)] };
  });
  const plan = await planAtHome(pool, binding);
  const accepted = await runCommand<IdentityNativeReceipt | null>(
    pool,
    { partition: source.receivingHome },
    async (tx) => {
      const owner = await readPartition(tx, source.receivingHome);
      if (!owner || owner.writeState !== 'active' || owner.epoch !== source.receivingEpoch) throw stale();
      const prior = (
        await tx.query(
          `SELECT r.transaction_id,r.binding_digest,c.epoch,c.position FROM semantic.identity_epoch_receiving_record r
      JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id)
      WHERE r.partition_no=$1 AND r.job_id=$2 AND r.effect_key=$3`,
          [source.receivingHome, binding.job.jobId, binding.effectKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.binding_digest !== bindingDigest || prior.epoch !== source.receivingEpoch) throw stale();
        const gate = (
          await tx.query(
            `SELECT pending_job,pending_epoch FROM semantic.identity_epoch_receiving_gate
        WHERE partition_no=$1 AND owner_id=$2 AND original=$3 AND owner_epoch=$4 FOR UPDATE`,
            [source.receivingHome, source.owner, binding.original, source.receivingEpoch],
          )
        ).rows[0];
        if (!gate || gate.pending_job !== binding.job.jobId || BigInt(gate.pending_epoch ?? -1) !== binding.job.epoch)
          throw stale();
        return noEffect(receipt(source.receivingHome, prior.transaction_id, prior.epoch, prior.position));
      }
      const gate = await tx.query(
        `INSERT INTO semantic.identity_epoch_receiving_gate(partition_no,owner_id,original,owner_epoch,pending_job,pending_epoch)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(partition_no,owner_id,original) DO UPDATE
      SET pending_job=EXCLUDED.pending_job,pending_epoch=EXCLUDED.pending_epoch
      WHERE semantic.identity_epoch_receiving_gate.owner_epoch=EXCLUDED.owner_epoch AND
       (semantic.identity_epoch_receiving_gate.pending_job IS NULL OR
        (semantic.identity_epoch_receiving_gate.pending_job,semantic.identity_epoch_receiving_gate.pending_epoch)=(EXCLUDED.pending_job,EXCLUDED.pending_epoch))
      RETURNING owner_id`,
        [
          source.receivingHome,
          source.owner,
          binding.original,
          owner.epoch,
          binding.job.jobId,
          binding.job.epoch.toString(),
        ],
      );
      if (gate.rowCount !== 1) throw stale();
      await holdSource(tx, source, 'readAndHold');
      bindSemanticProducerRoles(tx, roles);
      recordIdentityEpochNativeCommit(tx, 'identity-receiving-record');
      registerCommandCallback(tx, async (id) => {
        await tx.query(
          `INSERT INTO semantic.identity_epoch_receiving_record
        (partition_no,job_id,job_epoch,effect_key,owner_id,original,owner_epoch,binding,binding_digest,plan,source_hold,transaction_id)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          jsonb_build_object('partition',c.partition_no,'transactionId',c.transaction_id,
            'epoch',c.epoch,'position',c.position::text),$11
        FROM semantic.identity_epoch_native_commit c
        WHERE c.partition_no=$1 AND c.transaction_id=$11 AND c.purpose='identity-receiving-record'`,
          [
            source.receivingHome,
            binding.job.jobId,
            binding.job.epoch.toString(),
            binding.effectKey,
            binding.owner,
            binding.original,
            owner.epoch,
            json(binding),
            bindingDigest,
            json(plan),
            id,
          ],
        );
      });
      return { value: null, events: [wake(binding)] };
    },
  );
  const native =
    accepted.value ?? receipt(accepted.partition, accepted.transactionId, accepted.epoch, accepted.position);
  return effectOf({ ...binding, plan, sourceHold: native, receipt: native, applied: null });
}

async function localRecord(tx: CommandTransaction, effect: IdentityReceivingEffect) {
  if (currentCommand(tx).partition !== effect.receipt.partition) throw stale();
  const row = (
    await tx.query(receivingLookup.sql, [
      effect.receipt.partition,
      effect.job.jobId,
      effect.job.epoch.toString(),
      effect.effectKey,
      effect.original,
      effect.receipt.transactionId,
      effect.receipt.epoch,
      effect.receipt.position.toString(),
    ])
  ).rows[0];
  if (!row) throw stale();
  const binding = decodeBinding(row.binding);
  if (
    digest(binding) !== row.binding_digest ||
    binding.job.jobId !== effect.job.jobId ||
    binding.job.epoch !== effect.job.epoch ||
    binding.original !== effect.original ||
    binding.effectKey !== effect.effectKey ||
    binding.owner !== row.owner_id ||
    binding.source.receivingHome !== effect.receipt.partition ||
    binding.source.receivingEpoch !== row.owner_epoch
  )
    throw stale();
  const sourceHold = decodeReceipt(row.source_hold);
  if (json(sourceHold) !== json(effect.receipt)) throw stale();
  const record: IdentityReceivingRecord = {
    ...binding,
    plan: decodeReceipt(row.plan),
    sourceHold,
    receipt: effect.receipt,
    applied:
      row.effect_transaction_id && row.effect_epoch !== null && row.effect_position !== null
        ? {
            receipt: receipt(
              effect.receipt.partition,
              row.effect_transaction_id,
              row.effect_epoch,
              row.effect_position,
            ),
            frontier: row.frontier,
          }
        : null,
  };
  return { row, record };
}
/** Exact transaction + component lookup. No global job lookup, caller JSON grant or source checkout. */
export async function lookupIdentityReceivingEffect(
  tx: CommandTransaction,
  effect: IdentityReceivingEffect,
): Promise<IdentityReceivingRecord | null> {
  const { row, record } = await localRecord(tx, effect);
  const gate = (
    await tx.query(
      `SELECT pending_job,pending_epoch FROM semantic.identity_epoch_receiving_gate
    WHERE partition_no=$1 AND owner_id=$2 AND original=$3 AND owner_epoch=$4 FOR UPDATE`,
      [effect.receipt.partition, record.owner, record.original, record.source.receivingEpoch],
    )
  ).rows[0];
  if (!gate || gate.pending_job !== effect.job.jobId || BigInt(gate.pending_epoch ?? -1) !== effect.job.epoch)
    throw stale();
  if (row.effect_transaction_id && row.effect_epoch === null) throw stale();
  return record;
}
/** Resolve a locator at its declared native home, then release that home before returning.
 * Neither the selection nor its serialized capture is permission or committed custody proof.
 */
export async function readIdentityReceivingSelection(
  pool: Pool,
  selection: IdentityReceivingSelection,
  context: Readonly<{ deadline: number }>,
): Promise<IdentityReceivingRecord | null> {
  try {
    selected(selection);
    const hint = selection.capture;
    if (!hint) throw unavailable('Receiving selection requires a native capture locator');
    const identity = hint.identity;
    // Only the actual Library factory's current account-backed Source forms are supported.
    // A public output or terminal account cannot borrow a collection ID as account authority.
    if (
      !identity ||
      (identity.scope !== 'curated' && identity.scope !== 'private_builtin') ||
      routeOf(identity.accountId) === null
    )
      throw unavailable('Unsupported native receiving Source form');
    if (
      routeOf(identity.collectionId) !== identity.route ||
      selection.sourceId !== identity.collectionId ||
      selection.owner !== identity.collectionId ||
      identity.receivingEpoch !== selection.job.epoch.toString()
    )
      return null;
    const home = partitionOf(identity.route);
    const result = await runCommand(pool, { partition: home, deadline: context.deadline }, async (tx) => {
      const native = (
        await tx.query(receivingSelection.sql, [
          home,
          selection.job.jobId,
          selection.job.epoch.toString(),
          selection.effectKey,
          selection.original,
          selection.owner,
        ])
      ).rows[0];
      if (!native) return noEffect(null);
      // Use the original committed receipt, never today's partition epoch/position.
      const record = await lookupIdentityReceivingEffect(tx, {
        kind: 'receiving',
        job: selection.job,
        original: selection.original,
        effectKey: selection.effectKey,
        receipt: receipt(home, native.transaction_id, native.epoch, native.position),
      });
      if (
        !record ||
        record.owner !== selection.owner ||
        record.source.id !== selection.sourceId ||
        record.source.scope !== selection.scope ||
        record.source.disposition !== selection.disposition ||
        record.source.native.captureId !== hint.frontier.captureId ||
        canonicalize(record.source.native.identity) !== canonicalize(identity)
      )
        return noEffect(null);
      // This checks the actual retained capture/receipt/hold on the SAME client and T.
      // It does not acquire a hold, admit an effect, reconcile custody or clear a gate.
      await holdSource(tx, record.source, 'revalidateHold');
      return noEffect(record);
    });
    return result.value;
  } catch (error) {
    if (error instanceof IdentityEpochStoreError && error.code === 'identity_effect_stale') return null;
    if (error instanceof CommandUnavailableError) throw unavailable('Native receiving home unavailable');
    throw error;
  }
}
const admittedSources = new WeakMap<CommandTransaction, Map<string, NativeSourceCustody>>();
/** Used by the existing Store. The actual Source owner retains custody on the receiving client and T. */
export async function admitIdentityReceivingEffect(
  tx: CommandTransaction,
  effect: IdentityReceivingEffect,
): Promise<void> {
  if (currentCommand(tx).basis !== null) throw stale();
  const record = await lookupIdentityReceivingEffect(tx, effect);
  if (!record || record.applied) throw stale();
  let held = admittedSources.get(tx);
  if (!held) {
    held = new Map();
    admittedSources.set(tx, held);
  }
  const key = json([effect.job.jobId, effect.job.epoch, effect.effectKey, effect.receipt.transactionId]);
  if (held.has(key)) return;
  // An accepted record already retained this exact native hold. Revalidation does not acquire a fresh
  // read or require the live business generation to remain equal to the captured generation.
  held.set(key, await holdSource(tx, record.source, 'revalidateHold'));
  // Validate after the owner's ordinary callbacks have persisted the effect/frontier/native record.
  // A caller that admits and mutates but forgets its scope receipt cannot commit that mutation.
  registerCommandCallback(tx, () => {
    registerCommandCallback(tx, async (id) => {
      const saved = await tx.query(
        `SELECT 1 FROM semantic.identity_epoch_receiving_effect e
        JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(e.partition_no,e.transaction_id)
        JOIN semantic.identity_epoch_step s ON (s.partition_no,s.transaction_id)=(e.partition_no,e.transaction_id)
        WHERE e.partition_no=$1 AND e.job_id=$2 AND e.effect_key=$3 AND e.transaction_id=$4
        AND c.purpose=$5 AND c.xmin=e.xmin AND s.xmin=c.xmin
        AND s.job_id=e.job_id AND s.job_epoch=$6 AND s.step=$5 AND s.version=1
        AND s.scope_digest=$7 AND s.frontier=e.frontier AND s.native_epoch=c.epoch AND s.native_position=c.position`,
        [
          effect.receipt.partition,
          effect.job.jobId,
          effect.effectKey,
          id,
          step,
          effect.job.epoch.toString(),
          record.scopeDigest,
        ],
      );
      if (saved.rowCount !== 1) throw stale();
    });
  });
}

/** Call AFTER the actual owner mutation/frontier write in that same admitted transaction.
 * This scope receipt never creates a participant-complete record or a job-wide ACK.
 */
export async function recordIdentityReceivingEffect(
  tx: CommandTransaction,
  effect: IdentityReceivingEffect,
  progress: IdentityReceivingProgress,
): Promise<void> {
  await admitIdentityReceivingEffect(tx, effect);
  if (
    progress.frontier.after.length > 8 ||
    progress.frontier.after.some((key) => key !== null && typeof key !== 'string' && typeof key !== 'number') ||
    !Number.isSafeInteger(progress.frontier.segment) ||
    progress.frontier.segment < 0 ||
    Buffer.byteLength(json(progress.frontier)) > 2048
  )
    throw stale();
  const { row } = await localRecord(tx, effect);
  if (row.effect_transaction_id) throw stale(); // Consumers replay the committed receipt before mutating again.
  recordIdentityEpochNativeCommit(tx, step);
  registerCommandCallback(tx, async (id) => {
    await tx.query(
      `INSERT INTO semantic.identity_epoch_receiving_effect(partition_no,job_id,effect_key,transaction_id,frontier)
      VALUES($1,$2,$3,$4,$5)`,
      [effect.receipt.partition, effect.job.jobId, effect.effectKey, id, json(progress.frontier)],
    );
  });
}

/** Receiving commit -> released control custody -> exact Source hold ACK. Lost replies replay these same rows. */
export async function reconcileIdentityReceivingEffect(
  pool: Pool,
  effect: IdentityReceivingEffect,
): Promise<IdentityNativeReceipt> {
  const saved = await runCommand(pool, { partition: effect.receipt.partition }, async (tx) =>
    noEffect(await localRecord(tx, effect)),
  );
  const { row, record } = saved.value;
  if (!row.effect_transaction_id || row.effect_epoch === null || row.effect_position === null) throw stale();
  const native = receipt(effect.receipt.partition, row.effect_transaction_id, row.effect_epoch, row.effect_position);
  // Source home was released before control. There is no reusable global job capability.
  const home = identityJobPartition(effect.job);
  const roles = await identityErasureRoles(pool, effect.job.jobId);
  const acknowledged = await runCommand<IdentityNativeReceipt | null>(pool, { partition: home }, async (tx) => {
    const job = (await tx.query(receivingJob.sql, [home, effect.job.jobId, effect.job.epoch.toString()])).rows[0];
    if (!job || job.scope_digest !== record.scopeDigest) throw stale();
    const planned = (
      await tx.query(receivingPlan.sql, [home, effect.job.jobId, effect.job.epoch.toString(), effect.effectKey])
    ).rows[0];
    if (!planned || planned.binding_digest !== digest(record) || planned.transaction_id !== record.plan.transactionId)
      throw stale();
    const expected = (
      await tx.query(
        `SELECT native_partition,native_epoch,native_position,native_transaction_id
      FROM semantic.identity_epoch_effect_receipt WHERE partition_no=$1 AND job_id=$2 AND step=$3 AND effect_key=$4 FOR UPDATE`,
        [home, effect.job.jobId, step, effect.effectKey],
      )
    ).rows[0];
    if (!expected) throw stale();
    if (expected.native_transaction_id) {
      if (
        expected.native_partition !== native.partition ||
        expected.native_epoch !== native.epoch ||
        BigInt(expected.native_position) !== native.position ||
        expected.native_transaction_id !== native.transactionId
      )
        throw stale();
      const custody = (
        await tx.query(
          `SELECT c.transaction_id,c.epoch,c.position FROM semantic.identity_epoch_native_commit c
        JOIN semantic.identity_epoch_receiving_custody a ON (a.partition_no,a.transaction_id)=(c.partition_no,c.transaction_id)
        WHERE a.partition_no=$1 AND a.job_id=$2 AND a.effect_key=$3 AND c.purpose='identity-receiving-custody' AND c.xmin=a.xmin`,
          [home, effect.job.jobId, effect.effectKey],
        )
      ).rows[0];
      if (!custody) throw stale();
      return noEffect(receipt(home, custody.transaction_id, custody.epoch, custody.position));
    }
    if (job.state !== 'pending') throw stale();
    await tx.query(
      `UPDATE semantic.identity_epoch_effect_receipt SET native_partition=$5,native_epoch=$6,native_position=$7,native_transaction_id=$8
      WHERE partition_no=$1 AND job_id=$2 AND step=$3 AND effect_key=$4 AND native_transaction_id IS NULL`,
      [
        home,
        effect.job.jobId,
        step,
        effect.effectKey,
        native.partition,
        native.epoch,
        native.position.toString(),
        native.transactionId,
      ],
    );
    bindSemanticProducerRoles(tx, roles);
    recordIdentityEpochNativeCommit(tx, 'identity-receiving-custody');
    registerCommandCallback(tx, async (id) => {
      await tx.query(
        `INSERT INTO semantic.identity_epoch_receiving_custody(partition_no,job_id,effect_key,transaction_id) VALUES($1,$2,$3,$4)`,
        [home, effect.job.jobId, effect.effectKey, id],
      );
    });
    return { value: null, events: [wake(record)] };
  });
  const custody =
    acknowledged.value ??
    receipt(acknowledged.partition, acknowledged.transactionId, acknowledged.epoch, acknowledged.position);
  // The released control transaction above verified the exact native effect, plan and immutable binding.
  // Re-read that SAME effect at its own home before the owner's native release; no job-wide ACK substitutes.
  await runCommand(pool, { partition: record.source.home }, async (tx) => {
    const { record: local } = await localRecord(tx, effect);
    if (
      !local?.applied ||
      json(local.applied.receipt) !== json(native) ||
      digest(local) !== digest(record) ||
      custody.partition !== home
    )
      throw stale();
    const { identity, captureId, holdId } = local.source.native;
    const released = await createNativeLibrarySourceCustody({ pool }).releaseHold({
      client: tx,
      at: currentCommand(tx).time,
      identity,
      captureId,
      holdId,
      ...sourceWork(tx, holdId),
    });
    if (released.status !== 'released') throw unavailable(`Native Source releaseHold: ${released.reason}`);
    bindSemanticProducerRoles(tx, roles);
    return { value: null, events: [wake(local)] };
  });
  // Keep the gate until all SAME-job scopes at this owner/original have durable custody. Individual
  // scope reconciliation cannot clear it while a sibling OLD/NEW/first-apply obligation is outstanding.
  return native;
}

/** Published control custody is monotonic. Release only this job's local gate, after releasing control.
 * This is an exact-key handoff used by the owner, not a new scan, scheduler or ordinary disposition authority.
 */
export async function releaseIdentityReceivingEffect(pool: Pool, effect: IdentityReceivingEffect): Promise<void> {
  const home = identityJobPartition(effect.job);
  await runCommand(pool, { partition: home }, async (tx) => {
    const job = (await tx.query(receivingJob.sql, [home, effect.job.jobId, effect.job.epoch.toString()])).rows[0];
    if (!job || job.state !== 'published') throw stale();
    const expected = (
      await tx.query(
        `SELECT 1 FROM semantic.identity_epoch_effect_receipt
      WHERE partition_no=$1 AND job_id=$2 AND step=$3 AND effect_key=$4 AND native_transaction_id IS NOT NULL`,
        [home, effect.job.jobId, step, effect.effectKey],
      )
    ).rowCount;
    if (!expected) throw stale();
    return noEffect(null);
  });
  await runCommand(pool, { partition: effect.receipt.partition }, async (tx) => {
    const { record } = await localRecord(tx, effect);
    const released = await tx.query(
      `UPDATE semantic.identity_epoch_receiving_gate SET pending_job=NULL,pending_epoch=NULL
      WHERE partition_no=$1 AND owner_id=$2 AND original=$3 AND owner_epoch=$4 AND pending_job=$5 AND pending_epoch=$6`,
      [
        effect.receipt.partition,
        record.owner,
        effect.original,
        record.source.receivingEpoch,
        effect.job.jobId,
        effect.job.epoch.toString(),
      ],
    );
    return released.rowCount ? { value: null, events: [wake(record)] } : noEffect(null);
  });
}
