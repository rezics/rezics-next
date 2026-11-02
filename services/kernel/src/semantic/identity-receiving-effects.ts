import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  CommandUnavailableError,
  currentCommand,
  currentCommandResources,
  noEffect,
  registerCommandCallback,
  runCommand as executeReceivingCommand,
  type CommandTransaction,
  type CommandResult,
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
import type { IdentityNativeReceipt, NativeStepWork } from './identity-epoch-contract.ts';
import type {
  IdentityReceivingBinding,
  IdentityReceivingEffect,
  IdentityReceivingRecord,
  IdentityReceivingSelection,
  IdentityReceivingCaptureInput,
  IdentityReceivingCaptureResult,
  IdentityReceivingSource,
  IdentityReceivingProgress,
  SearchIdentityReceivingSelection,
  SearchIdentityReceivingSource,
  SearchIdentityReceivingHold,
  SearchIdentityReceivingBinding,
  SearchIdentityReceivingRecord,
  SearchIdentityReceivingNative,
  SearchIdentityReceivingResult,
  NativeIdentityReceivingBinding,
  NativeIdentityReceivingRecord,
  NativeIdentityReceivingSelection,
} from './identity-receiving-effects-types.ts';
import receivingJob from './identity-epoch-store-receiving-job.sql';
import receivingPlan from './identity-epoch-store-receiving-plan.sql';
import receivingLookup from './identity-epoch-store-receiving-lookup.sql';
import receivingSelection from './identity-receiving-selection-read.sql';
import searchProgressRead from './identity-search-receiving-progress-read.sql';
import searchProgressInsert from './identity-search-receiving-progress-insert.sql';
import searchProgressAdvance from './identity-search-receiving-progress-advance.sql';
import searchProgressRelease from './identity-search-receiving-progress-release.sql';
import searchUnreleased from './identity-search-receiving-unreleased.sql';
import {
  receivingWorkDeclaration,
  withSearchReceivingWork,
  type SearchReceivingWork,
  type SearchReceivingWorkContext,
  type SearchReceivingWorkDeclaration,
} from './identity-search-receiving-work.ts';
import {
  receivingStatements,
  commonSearchReceivingStatements,
  searchReceivingCapturedStatementCosts,
  searchReceivingOwnedPageStatements,
} from './identity-search-receiving-statements.ts';
import { snapshotSearchIdentityReceivingFrontier } from '../search/identity-receiving-native-contract.ts';

export type * from './identity-receiving-effects-types.ts';
export type { SearchReceivingWorkContext, SearchReceivingWorkDeclaration } from './identity-search-receiving-work.ts';
export { commonSearchReceivingStatements } from './identity-search-receiving-statements.ts';
const step = 'library-private-follow-counts';
const stale = () =>
  new IdentityEpochStoreError(
    'identity_effect_stale',
    'Missing or stale exact native receiving source, plan, owner or gate',
  );
const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);
function runCommand<T>(
  pool: Pool,
  options: Readonly<{ partition: number; deadline?: number }>,
  body: (tx: CommandTransaction) => Promise<CommandResult<T>>,
) {
  const scope = searchContexts.getStore();
  return executeReceivingCommand(
    pool,
    scope?.active && scope.pool === pool
      ? {
          ...options,
          deadline: Math.min(options.deadline ?? scope.work.deadline, scope.work.deadline),
          clock: scope.clock,
        }
      : options,
    body,
  );
}
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
const digest = (binding: NativeIdentityReceivingBinding) =>
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
const wake = (binding: NativeIdentityReceivingBinding) => ({
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
function decodeBinding(value: unknown): NativeIdentityReceivingBinding {
  if ((value as { step?: unknown })?.step === 'search-canonical-index') return decodeSearchBinding(value);
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
function effectOf(record: NativeIdentityReceivingRecord): IdentityReceivingEffect {
  return {
    kind: 'receiving',
    job: record.job,
    original: record.original,
    effectKey: record.effectKey,
    receipt: record.receipt,
  };
}
function selected(selection: NativeIdentityReceivingSelection) {
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
async function jobBasis(pool: Pool, selection: NativeIdentityReceivingSelection) {
  const home = identityJobPartition(selection.job);
  const data = await runCommand(pool, { partition: home }, async (tx) => {
    const job = (await tx.query(receivingJob.sql, [home, selection.job.jobId, selection.job.epoch.toString()])).rows[0];
    if (!job || job.state !== 'pending') throw stale();
    const inputs = (await tx.query(receivingStatements.inputBasis, [home, selection.job.jobId])).rows;
    return noEffect({ scope: job.scope_digest, inputs });
  });
  // Immutable input generations are probed at their own homes, never joined into a foreign job query.
  let member = false;
  for (const input of data.value.inputs) {
    const found = await withReadTransaction(pool, async (tx) => {
      const owner = await readPartition(tx, input.control_partition);
      if (!owner || owner.writeState !== 'active' || owner.epoch !== input.owner_epoch) throw stale();
      return !!(
        await tx.query(receivingStatements.originalMembership, [
          input.control_partition,
          input.generation,
          selection.original,
          input.terminal,
        ])
      ).rowCount;
    });
    member ||= found;
  }
  if (!member) throw stale();
  return data.value.scope;
}
async function planAtHome(pool: Pool, binding: NativeIdentityReceivingBinding) {
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
      await tx.query(receivingStatements.libraryReplay, [
        partitionOf(identity.route),
        selection.job.jobId,
        selection.job.epoch.toString(),
        selection.effectKey,
        selection.original,
      ])
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
      saved.step !== step ||
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
  return acceptReceivingBinding(pool, binding);
}

async function acceptReceivingBinding(
  pool: Pool,
  binding: NativeIdentityReceivingBinding,
): Promise<IdentityReceivingEffect> {
  const { source, scopeDigest } = binding;
  if (Buffer.byteLength(json(binding)) > 3072) throw stale();
  const bindingDigest = digest(binding);
  const roles = await identityErasureRoles(pool, binding.job.jobId);
  const home = identityJobPartition(binding.job);
  await runCommand(pool, { partition: home }, async (tx) => {
    const job = (await tx.query(receivingJob.sql, [home, binding.job.jobId, binding.job.epoch.toString()])).rows[0];
    if (!job || job.state !== 'pending' || job.scope_digest !== scopeDigest) throw stale();
    const prior = (await tx.query(receivingStatements.existingPlan, [home, binding.job.jobId, binding.effectKey]))
      .rows[0];
    if (prior) {
      if (prior.binding_digest !== bindingDigest) throw stale();
      return noEffect(null);
    }
    if ((await tx.query(receivingStatements.completedStep, [home, binding.job.jobId, binding.step])).rowCount)
      throw stale();
    // Register the exact expected obligation BEFORE a remote hold or receiving write can commit.
    await tx.query(receivingStatements.expectEffect, [
      home,
      binding.job.jobId,
      binding.step,
      binding.effectKey,
      source.disposition === 'OLD' ? 'remove' : source.disposition === 'handoff' ? 'pending-fence' : 'add',
    ]);
    bindSemanticProducerRoles(tx, roles);
    recordIdentityEpochNativeCommit(tx, 'identity-receiving-plan');
    registerCommandCallback(tx, async (id) => {
      await tx.query(receivingStatements.insertPlan, [
        home,
        binding.job.jobId,
        binding.job.epoch.toString(),
        binding.effectKey,
        json(binding),
        bindingDigest,
        id,
      ]);
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
        await tx.query(receivingStatements.acceptedReplay, [source.receivingHome, binding.job.jobId, binding.effectKey])
      ).rows[0];
      if (prior) {
        if (prior.binding_digest !== bindingDigest || prior.epoch !== source.receivingEpoch) throw stale();
        const gate = (
          await tx.query(receivingStatements.acceptedGate, [
            source.receivingHome,
            source.owner,
            binding.original,
            source.receivingEpoch,
          ])
        ).rows[0];
        if (!gate || gate.pending_job !== binding.job.jobId || BigInt(gate.pending_epoch ?? -1) !== binding.job.epoch)
          throw stale();
        return noEffect(receipt(source.receivingHome, prior.transaction_id, prior.epoch, prior.position));
      }
      const gate = await tx.query(receivingStatements.retainGate, [
        source.receivingHome,
        source.owner,
        binding.original,
        owner.epoch,
        binding.job.jobId,
        binding.job.epoch.toString(),
      ]);
      if (gate.rowCount !== 1) throw stale();
      const nativeHold =
        binding.step === 'search-canonical-index'
          ? await searchNativeCall(tx, 'readAndHold', binding)
          : (await holdSource(tx, binding.source, 'readAndHold'), null);
      if (nativeHold && binding.step === 'search-canonical-index') validateSearchHold(binding, nativeHold);
      bindSemanticProducerRoles(tx, roles);
      recordIdentityEpochNativeCommit(tx, 'identity-receiving-record');
      registerCommandCallback(tx, async (id) => {
        const inserted = await tx.query(receivingStatements.insertAccepted, [
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
          nativeHold ? json(nativeHold) : null,
        ]);
        if (inserted.rowCount !== 1) throw stale();
        if (binding.step === 'search-canonical-index')
          await tx.query(searchProgressInsert.sql, [
            source.receivingHome,
            binding.job.jobId,
            binding.effectKey,
            binding.owner,
            binding.original,
            id,
            bindingDigest,
          ]);
      });
      return { value: null, events: [wake(binding)] };
    },
  );
  const native =
    accepted.value ?? receipt(accepted.partition, accepted.transactionId, accepted.epoch, accepted.position);
  // Only the committed receipt is returned. The full original hold is read back by localRecord.
  return {
    kind: 'receiving',
    job: binding.job,
    original: binding.original,
    effectKey: binding.effectKey,
    receipt: native,
  };
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
  const common = {
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
  const record: NativeIdentityReceivingRecord =
    binding.step === 'search-canonical-index'
      ? { ...common, ...binding, nativeHold: decodeSearchHold(binding, row.native_hold) }
      : { ...common, ...binding };
  return { row, record };
}
/** Exact transaction + component lookup. No global job lookup, caller JSON grant or source checkout. */
async function lookupReceivingRecord(
  tx: CommandTransaction,
  effect: IdentityReceivingEffect,
): Promise<NativeIdentityReceivingRecord | null> {
  const { row, record } = await localRecord(tx, effect);
  const gate = (
    await tx.query(receivingStatements.lookupGate, [
      effect.receipt.partition,
      record.owner,
      record.original,
      record.source.receivingEpoch,
    ])
  ).rows[0];
  if (!gate) throw stale();
  const pending = gate.pending_job === effect.job.jobId && BigInt(gate.pending_epoch ?? -1) === effect.job.epoch;
  if (
    !pending &&
    !(
      record.step === 'search-canonical-index' &&
      record.applied &&
      gate.pending_job === null &&
      gate.pending_epoch === null &&
      (await searchContinuation(tx, record)).state === 'released'
    )
  )
    throw stale();
  if (row.effect_transaction_id && row.effect_epoch === null) throw stale();
  return record;
}
/** Preserve the Library lookup signature. Search explicitly selects its separate native variant;
 * the persisted step is decoded first and must agree, so the discriminator grants no authority.
 */
export function lookupIdentityReceivingEffect(
  tx: CommandTransaction,
  effect: IdentityReceivingEffect,
): Promise<IdentityReceivingRecord | null>;
export function lookupIdentityReceivingEffect(
  tx: CommandTransaction,
  effect: IdentityReceivingEffect,
  nativeStep: 'search-canonical-index',
): Promise<SearchIdentityReceivingRecord | null>;
export async function lookupIdentityReceivingEffect(
  tx: CommandTransaction,
  effect: IdentityReceivingEffect,
  nativeStep: 'search-canonical-index' | 'library-private-follow-counts' = 'library-private-follow-counts',
): Promise<NativeIdentityReceivingRecord | null> {
  if (nativeStep === 'search-canonical-index') searchContext(currentCommandResources(tx).pool);
  const record = await lookupReceivingRecord(tx, effect);
  if (record && record.step !== nativeStep) throw stale();
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
        record.step !== step ||
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
const admittedSources = new WeakMap<CommandTransaction, Set<string>>();
/** Used by the existing Store. The actual Source owner retains custody on the receiving client and T. */
export async function admitIdentityReceivingEffect(
  tx: CommandTransaction,
  effect: IdentityReceivingEffect,
): Promise<void> {
  if (currentCommand(tx).basis !== null) throw stale();
  const record = await lookupReceivingRecord(tx, effect);
  if (!record || record.applied) throw stale();
  let held = admittedSources.get(tx);
  if (!held) {
    held = new Set();
    admittedSources.set(tx, held);
  }
  const key = json([effect.job.jobId, effect.job.epoch, effect.effectKey, effect.receipt.transactionId]);
  if (held.has(key)) return;
  // An accepted record already retained this exact native hold. Revalidation does not acquire a fresh
  // read or require the live business generation to remain equal to the captured generation.
  if (record.step === 'search-canonical-index') {
    const hold = await searchNativeCall(tx, 'revalidateHold', record);
    validateSearchHold(record, hold);
    if (searchJSON(hold) !== searchJSON(record.nativeHold)) throw stale();
  } else await holdSource(tx, record.source, 'revalidateHold');
  held.add(key);
  // Validate after the owner's ordinary callbacks have persisted the effect/frontier/native record.
  // A caller that admits and mutates but forgets its scope receipt cannot commit that mutation.
  registerCommandCallback(tx, () => {
    registerCommandCallback(tx, async (id) => {
      const saved = await tx.query(receivingStatements.sameCommandApplied, [
        effect.receipt.partition,
        effect.job.jobId,
        effect.effectKey,
        id,
        record.step,
        effect.job.epoch.toString(),
        record.scopeDigest,
      ]);
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
  const searchFrontier = snapshotSearchIdentityReceivingFrontier(progress.frontier);
  const { row, record } = await localRecord(tx, effect);
  if (record.step === 'search-canonical-index') {
    if (!searchFrontier) throw stale();
    progress = { frontier: searchFrontier };
  }
  await admitIdentityReceivingEffect(tx, effect);
  if (
    progress.frontier.after.length > 8 ||
    progress.frontier.after.some((key) => key !== null && typeof key !== 'string' && typeof key !== 'number') ||
    !Number.isSafeInteger(progress.frontier.segment) ||
    progress.frontier.segment < 0 ||
    Buffer.byteLength(json(progress.frontier)) > 2048
  )
    throw stale();
  if (row.effect_transaction_id) throw stale(); // Consumers replay the committed receipt before mutating again.
  if (record.step === 'search-canonical-index') {
    const applied = await searchNativeCall(tx, 'recordApplied', record, progress.frontier);
    if (applied.holdId !== record.nativeHold.holdId) throw stale();
  }
  recordIdentityEpochNativeCommit(tx, record.step);
  registerCommandCallback(tx, async (id) => {
    await tx.query(receivingStatements.insertApplied, [
      effect.receipt.partition,
      effect.job.jobId,
      effect.effectKey,
      id,
      json(progress.frontier),
    ]);
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
  if (record.step === 'search-canonical-index') await reconcileSearchOriginal(pool, record);
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
    if (
      !planned ||
      planned.binding_digest !== digest(record) ||
      json(receipt(home, planned.transaction_id, planned.native_epoch, planned.native_position)) !== json(record.plan)
    )
      throw stale();
    const expected = (
      await tx.query(receivingStatements.expectedApplied, [home, effect.job.jobId, record.step, effect.effectKey])
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
      const custody = (await tx.query(receivingStatements.controlCustody, [home, effect.job.jobId, effect.effectKey]))
        .rows[0];
      if (!custody) throw stale();
      return noEffect(receipt(home, custody.transaction_id, custody.epoch, custody.position));
    }
    if (job.state !== 'pending') throw stale();
    await tx.query(receivingStatements.acknowledgeApplied, [
      home,
      effect.job.jobId,
      record.step,
      effect.effectKey,
      native.partition,
      native.epoch,
      native.position.toString(),
      native.transactionId,
    ]);
    bindSemanticProducerRoles(tx, roles);
    recordIdentityEpochNativeCommit(tx, 'identity-receiving-custody');
    registerCommandCallback(tx, async (id) => {
      await tx.query(receivingStatements.insertCustody, [home, effect.job.jobId, effect.effectKey, id]);
    });
    return { value: null, events: [wake(record)] };
  });
  const custody =
    acknowledged.value ??
    receipt(acknowledged.partition, acknowledged.transactionId, acknowledged.epoch, acknowledged.position);
  // Revalidate after the control COMMIT, before acquiring the receiving home. Settled/released
  // continuations are scheduling state; neither one conveys reusable release authority.
  if (record.step === 'search-canonical-index') await revalidateSearchTerminal(pool, record);
  // The released control transaction above verified the exact native effect, plan and immutable binding.
  // Re-read that SAME effect at its own home before the owner's native release; no job-wide ACK substitutes.
  await runCommand(pool, { partition: record.source.receivingHome }, async (tx) => {
    const { record: local } = await localRecord(tx, effect);
    if (
      !local?.applied ||
      json(local.applied.receipt) !== json(native) ||
      digest(local) !== digest(record) ||
      custody.partition !== home
    )
      throw stale();
    if (local.step === 'search-canonical-index') {
      const progress = await searchContinuation(tx, local);
      if (progress.state !== 'settled' && progress.state !== 'released') throw stale();
      const released = await searchNativeCall(tx, 'releaseHold', local);
      if (released.holdId !== local.nativeHold.holdId) throw stale();
      recordIdentityEpochNativeCommit(tx, 'identity-receiving-custody');
      if (progress.state === 'settled') {
        registerCommandCallback(tx, async (id) => {
          const marked = await tx.query(searchProgressRelease.sql, [
            local.receipt.partition,
            local.job.jobId,
            local.effectKey,
            local.receipt.transactionId,
            digest(local),
            progress.revision,
            native.transactionId,
            id,
          ]);
          if (marked.rowCount !== 1) throw stale();
        });
      }
      // On replay the owner verifies its original release; it must not consume another hold.
    } else {
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
    }
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
  const observed = await runCommand(pool, { partition: effect.receipt.partition }, async (tx) =>
    noEffect((await localRecord(tx, effect)).record),
  );
  const record = observed.value;
  const home = identityJobPartition(effect.job);
  await runCommand(pool, { partition: home }, async (tx) => {
    const job = (await tx.query(receivingJob.sql, [home, effect.job.jobId, effect.job.epoch.toString()])).rows[0];
    if (!job || job.state !== 'published') throw stale();
    if (!record.applied || job.scope_digest !== record.scopeDigest) throw stale();
    const planned = (
      await tx.query(receivingPlan.sql, [home, effect.job.jobId, effect.job.epoch.toString(), effect.effectKey])
    ).rows[0];
    if (
      !planned ||
      planned.binding_digest !== digest(record) ||
      json(receipt(home, planned.transaction_id, planned.native_epoch, planned.native_position)) !== json(record.plan)
    )
      throw stale();
    const applied = record.applied.receipt;
    const expected = await tx.query(receivingStatements.publishedCustody, [
      home,
      effect.job.jobId,
      record.step,
      effect.effectKey,
      applied.partition,
      applied.epoch,
      applied.position.toString(),
      applied.transactionId,
    ]);
    if (expected.rowCount !== 1) throw stale();
    return noEffect(null);
  });
  if (record.step === 'search-canonical-index') await revalidateSearchTerminal(pool, record);
  await runCommand(pool, { partition: effect.receipt.partition }, async (tx) => {
    const { record: local } = await localRecord(tx, effect);
    if (digest(local) !== digest(record) || searchJSON(local.applied) !== searchJSON(record.applied)) throw stale();
    if (local.step === 'search-canonical-index') {
      searchContext(pool);
      if ((await searchContinuation(tx, local)).state !== 'released') throw stale();
      // The partial index seeks an outstanding sibling, rather than scanning settled scope history.
      if (
        (
          await tx.query(searchUnreleased.sql, [
            effect.receipt.partition,
            effect.job.jobId,
            local.owner,
            local.original,
          ])
        ).rowCount
      )
        throw stale();
      // Repeated native release verifies the original consumed hold and the now-published gate.
      const native = await searchNativeCall(tx, 'releaseHold', local);
      if (native.holdId !== local.nativeHold.holdId) throw stale();
      recordIdentityEpochNativeCommit(tx, 'identity-receiving-custody');
    }
    const released = await tx.query(receivingStatements.releaseGate, [
      effect.receipt.partition,
      record.owner,
      effect.original,
      record.source.receivingEpoch,
      effect.job.jobId,
      effect.job.epoch.toString(),
    ]);
    return released.rowCount || local.step === 'search-canonical-index'
      ? { value: null, events: [wake(record)] }
      : noEffect(null);
  });
}

/** Trusted application construction, with no process-wide mutable adapter authority. The genuine
 * owner's configuration tuple is inferred, never mirrored. One invocation scope covers all released
 * homes and the actual consumer's runCommand, including callbacks and executor commit/rollback.
 */
export async function installSearchIdentityReceivingNative(
  pool: Pool,
  declaration: SearchReceivingWorkDeclaration,
  ...configuration: Parameters<
    typeof import('../search/identity-receiving-native.ts').createSearchIdentityReceivingNative
  >
) {
  const own = new Map(
    searchReceivingCapturedStatementCosts().map((entry) => [
      entry.sql.trim().replace(/;$/, '').replace(/\s+/g, ' '),
      entry,
    ]),
  );
  for (const entry of declaration.statements) {
    const key = entry.sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
    const existing = own.get(key);
    if (!existing) own.set(key, entry);
    else {
      // Configured transitive work can increase an owned bound, but cannot erase it.
      const work = Object.fromEntries(
        Object.entries(existing.work).map(([axis, bound]) => [
          axis,
          Math.max(bound, entry.work[axis as keyof typeof entry.work]),
        ]),
      ) as unknown as typeof existing.work;
      own.set(key, { sql: existing.sql, work });
    }
  }
  const costs = receivingWorkDeclaration(
    { ...declaration, statements: [...own.values()] },
    searchReceivingOwnedPageStatements,
  );
  // The owner tuple remains inferred. Require its actual constructor Pool, either direct or in
  // root dependencies, to be this scope's Pool before the factory can perform any work.
  const configuredPools = configuration.flatMap((value: unknown) =>
    value === pool ? [pool] : value !== null && typeof value === 'object' && 'pool' in value ? [value.pool] : [],
  );
  if (configuredPools.length !== 1 || configuredPools[0] !== pool)
    throw unavailable('Canonical Search receiving factory configuration must bind the invocation Pool');
  const { createSearchIdentityReceivingNative, withSearchIdentityReceivingNativeInvocation } =
    await import('../search/identity-receiving-native.ts');
  const native = await createSearchIdentityReceivingNative(...configuration);
  return Object.freeze({
    run: async <T>(context: SearchReceivingWorkContext, body: () => Promise<T>) => {
      if (searchContexts.getStore()) throw unavailable('Nested Search receiving composition is unavailable');
      return withSearchReceivingWork(pool, context, costs, commonSearchReceivingStatements, async (work) => {
        const scope = { pool, native, work, active: true, clock: configuration[0].clock };
        return searchContexts.run(scope, async () => {
          try {
            return await withSearchIdentityReceivingNativeInvocation(native, body);
          } finally {
            scope.active = false;
          }
        });
      });
    },
  });
}
function installedSearch(pool: Pool, native?: SearchIdentityReceivingNative): SearchIdentityReceivingNative {
  const scope = searchContexts.getStore();
  if (
    !scope?.active ||
    scope.pool !== pool ||
    Date.now() >= scope.work.deadline ||
    (native !== undefined && scope.native !== native)
  )
    throw unavailable('Genuine Search receiving application scope is not active for this Pool');
  return scope.native;
}
const searchJSON = (value: unknown) => canonicalize(JSON.parse(json(value)));
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function searchSelection(selection: SearchIdentityReceivingSelection) {
  selected(selection);
  if (
    !selection.native ||
    selection.native.kind !== 'search-canonical-index' ||
    selection.native.version !== 1 ||
    !uuid(selection.native.planId) ||
    !Number.isInteger(selection.native.partition) ||
    selection.native.partition !== partitionOf(routeOf(selection.owner)!)
  )
    throw stale();
}
function decodeSearchBinding(value: unknown): SearchIdentityReceivingBinding {
  const b = value as SearchIdentityReceivingBinding;
  if (
    !b ||
    b.step !== 'search-canonical-index' ||
    b.version !== 1 ||
    !b.job ||
    !b.source ||
    typeof b.scopeDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(b.scopeDigest)
  )
    throw stale();
  const s = b.source;
  const job = { ...b.job, epoch: BigInt(b.job.epoch) };
  searchSelection({ ...b, job, sourceId: s.sourceId, scope: s.scope, disposition: s.disposition, native: s.locator });
  if (
    s.original !== b.original ||
    s.owner !== b.owner ||
    s.sourceId !== b.owner ||
    s.documentId !== b.owner ||
    routeOf(s.terminal) === null ||
    s.receivingHome !== s.locator.partition ||
    (s.disposition === 'OLD' && s.documentId !== b.original) ||
    ((s.disposition === 'NEW' || s.disposition === 'first-apply') && s.documentId !== s.terminal) ||
    !Number.isSafeInteger(s.receivingEpoch) ||
    s.receivingEpoch < 1 ||
    !Number.isSafeInteger(s.physicalGeneration) ||
    s.physicalGeneration < 1 ||
    typeof s.incarnation !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(s.incarnation) ||
    !s.consumer ||
    !s.physicalTarget ||
    !s.writeAlias ||
    !s.barrier ||
    !uuid(s.barrier.token) ||
    !Number.isInteger(s.barrier.partition) ||
    s.barrier.partition < 0 ||
    s.barrier.partition > 4095 ||
    !/^(0|[1-9][0-9]*)$/.test(String(s.enrollmentGeneration)) ||
    !/^(0|[1-9][0-9]*)$/.test(String(s.fenceGeneration)) ||
    'native' in s ||
    'captureId' in s ||
    'holdId' in s
  )
    throw stale();
  const decodeNative = (value: unknown) => {
    const native = decodeReceipt(value);
    if (
      !uuid(native.transactionId) ||
      native.partition < 0 ||
      native.partition > 4095 ||
      native.epoch < 1 ||
      native.position < 1n
    )
      throw stale();
    return native;
  };
  const plan = decodeNative(s.plan);
  if (plan.partition !== s.receivingHome || plan.epoch !== s.receivingEpoch) throw stale();
  return {
    ...b,
    job,
    source: {
      ...s,
      enrollmentGeneration: BigInt(s.enrollmentGeneration),
      fenceGeneration: BigInt(s.fenceGeneration),
      plan,
      originalFence: decodeNative(s.originalFence),
    },
  };
}
function validateSearchHold(binding: SearchIdentityReceivingBinding, hold: SearchIdentityReceivingHold) {
  if (
    !hold ||
    !uuid(hold.holdId) ||
    searchJSON(hold.locator) !== searchJSON(binding.source.locator) ||
    searchJSON(hold.source) !== searchJSON(binding.source)
  )
    throw stale();
}
function decodeSearchHold(binding: SearchIdentityReceivingBinding, value: unknown): SearchIdentityReceivingHold {
  const h = value as SearchIdentityReceivingHold;
  if (!h) throw stale();
  const source = decodeSearchBinding({ ...binding, source: h.source }).source;
  const hold = { ...h, source };
  validateSearchHold(binding, hold);
  return hold;
}

/** Private invocation lifetime, never an adapter supplied by a request or a persisted proof brand. */
const searchContexts = new AsyncLocalStorage<{
  pool: Pool;
  native: SearchIdentityReceivingNative;
  work: SearchReceivingWork;
  active: boolean;
  clock: Parameters<
    typeof import('../search/identity-receiving-native.ts').createSearchIdentityReceivingNative
  >[0]['clock'];
}>();
function searchContext(pool: Pool): SearchReceivingWork {
  installedSearch(pool);
  return searchContexts.getStore()!.work;
}
async function searchNativeCall(
  tx: CommandTransaction,
  operation: 'readAndHold',
  binding: SearchIdentityReceivingBinding,
): Promise<SearchIdentityReceivingHold>;
async function searchNativeCall(
  tx: CommandTransaction,
  operation: 'revalidateHold',
  binding: SearchIdentityReceivingRecord,
): Promise<SearchIdentityReceivingHold>;
async function searchNativeCall(
  tx: CommandTransaction,
  operation: 'releaseHold',
  binding: SearchIdentityReceivingRecord,
): Promise<Readonly<{ holdId: string }>>;
async function searchNativeCall(
  tx: CommandTransaction,
  operation: 'recordApplied',
  binding: SearchIdentityReceivingRecord,
  frontier: IdentityReceivingProgress['frontier'],
): Promise<Readonly<{ holdId: string }>>;
async function searchNativeCall(
  tx: CommandTransaction,
  operation: 'readAndHold' | 'revalidateHold' | 'releaseHold' | 'recordApplied',
  binding: SearchIdentityReceivingBinding | SearchIdentityReceivingRecord,
  frontier?: IdentityReceivingProgress['frontier'],
): Promise<SearchIdentityReceivingHold | Readonly<{ holdId: string }>> {
  const pool = currentCommandResources(tx).pool;
  const native = installedSearch(pool);
  const resources = currentCommandResources(tx);
  const work = searchContext(pool);
  if (work.deadline > resources.deadline) throw unavailable('Search receiving command exceeds work lifetime');
  if (currentCommand(tx).partition !== binding.source.receivingHome || currentCommand(tx).basis !== null) throw stale();
  const result = await work.invoke(
    operation,
    async (
      context,
    ): Promise<SearchIdentityReceivingResult<SearchIdentityReceivingHold | Readonly<{ holdId: string }>>> => {
      if (operation === 'readAndHold') return native.readAndHold(tx, binding, context);
      if (!('nativeHold' in binding)) throw stale();
      if (operation === 'recordApplied') {
        if (!frontier) throw stale();
        return native.recordApplied(tx, binding, frontier, context);
      }
      return native[operation](tx, binding, context);
    },
  );
  if (result.status !== 'ready') throw unavailable(`Native Search ${operation}: ${result.status}`);
  return result.value;
}
function sameSearchSelection(record: SearchIdentityReceivingBinding, selection: SearchIdentityReceivingSelection) {
  return (
    record.owner === selection.owner &&
    record.source.sourceId === selection.sourceId &&
    record.source.scope === selection.scope &&
    record.source.disposition === selection.disposition &&
    searchJSON(record.source.locator) === searchJSON(selection.native)
  );
}
/** Exact accepted replay precedes business-source resolution; it never takes a new hold. */
export async function readSearchIdentityReceivingSelection(
  pool: Pool,
  selection: SearchIdentityReceivingSelection,
  context: Readonly<{ deadline: number; allowance?: NativeStepWork }>,
): Promise<SearchIdentityReceivingRecord | null> {
  searchSelection(selection);
  installedSearch(pool);
  const work = searchContext(pool);
  if (context.deadline !== work.deadline)
    throw unavailable('Search selection must retain the outer receiving deadline');
  try {
    const result = await runCommand(
      pool,
      { partition: selection.native.partition, deadline: context.deadline },
      async (tx) => {
        const saved = (
          await tx.query(receivingSelection.sql, [
            selection.native.partition,
            selection.job.jobId,
            selection.job.epoch.toString(),
            selection.effectKey,
            selection.original,
            selection.owner,
          ])
        ).rows[0];
        if (!saved) return noEffect(null);
        const record = await lookupIdentityReceivingEffect(
          tx,
          {
            kind: 'receiving',
            job: selection.job,
            original: selection.original,
            effectKey: selection.effectKey,
            receipt: receipt(selection.native.partition, saved.transaction_id, saved.epoch, saved.position),
          },
          'search-canonical-index',
        );
        if (!record || record.step !== 'search-canonical-index' || !sameSearchSelection(record, selection))
          return noEffect(null);
        const hold = await searchNativeCall(tx, 'revalidateHold', record);
        validateSearchHold(record, hold);
        if (searchJSON(hold) !== searchJSON(record.nativeHold)) throw stale();
        return noEffect(record);
      },
    );
    return result.value;
  } catch (error) {
    if (error instanceof IdentityEpochStoreError && error.code === 'identity_effect_stale') return null;
    throw error;
  }
}
export async function prepareSearchIdentityReceivingEffect(
  pool: Pool,
  selection: SearchIdentityReceivingSelection,
  native?: SearchIdentityReceivingNative,
): Promise<IdentityReceivingEffect> {
  searchSelection(selection);
  const owner = installedSearch(pool, native);
  const work = searchContext(pool);
  const replay = await readSearchIdentityReceivingSelection(pool, selection, { deadline: work.deadline });
  if (replay) return effectOf(replay);
  const scopeDigest = await jobBasis(pool, selection);
  const resolved = await work.invoke<SearchIdentityReceivingResult<SearchIdentityReceivingSource>>(
    'resolvePlanned',
    (context) => owner.resolvePlanned(selection, context),
  );
  if (resolved.status !== 'ready') throw unavailable(`Native Search resolvePlanned: ${resolved.status}`);
  const binding = decodeSearchBinding({
    job: selection.job,
    original: selection.original,
    effectKey: selection.effectKey,
    owner: selection.owner,
    step: 'search-canonical-index',
    version: 1,
    scopeDigest,
    source: resolved.value,
  });
  if (!sameSearchSelection(binding, selection)) throw stale();
  return acceptReceivingBinding(pool, binding);
}
type SearchReceivingContinuation = Readonly<{
  revision: string;
  after_key: string | null;
  state: 'progress' | 'settled' | 'released';
  applied_transaction_id: string | null;
}>;
async function searchContinuation(tx: CommandTransaction, record: SearchIdentityReceivingRecord) {
  const row = (
    await tx.query<SearchReceivingContinuation>(searchProgressRead.sql, [
      record.receipt.partition,
      record.job.jobId,
      record.effectKey,
      record.receipt.transactionId,
      digest(record),
    ])
  ).rows[0];
  if (
    !row ||
    (row.applied_transaction_id !== null && row.applied_transaction_id !== record.applied?.receipt.transactionId)
  )
    throw stale();
  return row;
}
/** One released native page per call. Persist its cursor before reporting draining, so a retry starts
 * at the accepted page boundary. A cursor is scheduling state and never replaces owner revalidation.
 */
async function reconcileSearchOriginal(pool: Pool, record: SearchIdentityReceivingRecord) {
  const work = searchContext(pool);
  const prior = (
    await runCommand(pool, { partition: record.receipt.partition }, async (tx) => {
      const local = (await localRecord(tx, effectOf(record))).record;
      if (local.step !== 'search-canonical-index' || searchJSON(local.applied) !== searchJSON(record.applied))
        throw stale();
      return noEffect(await searchContinuation(tx, local));
    })
  ).value;
  if (prior.state !== 'progress') return;
  const result = await work.invoke<Awaited<ReturnType<SearchIdentityReceivingNative['reconcileOriginal']>>>(
    'reconcileOriginal',
    (context) => installedSearch(pool).reconcileOriginal(record.source.locator, prior.after_key, context),
  );
  if (result.status !== 'ready') throw unavailable(`Native Search reconcileOriginal: ${result.status}`);
  const next = result.value;
  if (
    (next.state !== 'progress' && next.state !== 'settled') ||
    (next.after !== null &&
      (typeof next.after !== 'string' || !next.after.length || Buffer.byteLength(next.after) > 2048)) ||
    (next.state === 'progress' && (next.after === null || next.after === prior.after_key))
  )
    throw stale();
  await runCommand(pool, { partition: record.receipt.partition }, async (tx) => {
    const local = (await localRecord(tx, effectOf(record))).record;
    if (
      local.step !== 'search-canonical-index' ||
      !local.applied ||
      searchJSON(local.applied) !== searchJSON(record.applied)
    )
      throw stale();
    const advanced = await tx.query(searchProgressAdvance.sql, [
      record.receipt.partition,
      record.job.jobId,
      record.effectKey,
      record.receipt.transactionId,
      digest(record),
      prior.revision,
      next.after,
      next.state,
      local.applied.receipt.transactionId,
    ]);
    if (advanced.rowCount !== 1) throw stale();
    return { value: null, events: [wake(local)] };
  });
  // This error occurs AFTER the released progress command commits. It cannot undo the page boundary.
  if (next.state === 'progress') throw unavailable('Native Search reconcileOriginal: draining; continuation committed');
}

/** Every release, including a lost-response or published-gate replay, obtains a new private native
 * observation after the matching control custody was committed and its connection was released.
 */
async function revalidateSearchTerminal(pool: Pool, record: SearchIdentityReceivingRecord) {
  const work = searchContext(pool);
  const prior = (
    await runCommand(pool, { partition: record.receipt.partition, deadline: work.deadline }, async (tx) => {
      const local = (await localRecord(tx, effectOf(record))).record;
      if (local.step !== 'search-canonical-index' || searchJSON(local.applied) !== searchJSON(record.applied))
        throw stale();
      return noEffect(await searchContinuation(tx, local));
    })
  ).value;
  if (prior.state !== 'settled' && prior.state !== 'released') throw stale();
  const result = await work.invoke<Awaited<ReturnType<SearchIdentityReceivingNative['reconcileOriginal']>>>(
    'reconcileOriginal',
    (context) => installedSearch(pool).reconcileOriginal(record.source.locator, prior.after_key, context),
  );
  if (result.status !== 'ready') throw unavailable(`Native Search terminal revalidation: ${result.status}`);
  if (result.value.state !== 'settled' || result.value.after !== prior.after_key) throw stale();
}
