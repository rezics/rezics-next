import { assertIdentityTerminalGroupsOpen } from './identity-terminal-closure.ts';
import { IdentityEpochStoreError } from './identity-terminal-closure-errors.ts';
export { IdentityEpochStoreError } from './identity-terminal-closure-errors.ts';
import { recordPreparedIdentityPrearm, sealColocatedEmptyIdentityPrearm } from './identity-epoch-prearm.ts';
import admissionInsertJob from './identity-epoch-admission-insert-job.sql';
import admissionInsertBases from './identity-epoch-admission-insert-bases.sql';
import admissionHandoff from './identity-epoch-admission-handoff.sql';
import admissionPrepare from './identity-epoch-admission-prepare.sql';
import admissionAcquire from './identity-epoch-admission-acquire.sql';
import admissionRecord from './identity-epoch-admission-record.sql';
import admissionReceipt from './identity-epoch-admission-receipt.sql';
import admissionCustodyPrepare from './identity-epoch-admission-custody-prepare.sql';
import admissionCustodyAcquire from './identity-epoch-admission-custody-acquire.sql';
import admissionPromote from './identity-epoch-admission-promote.sql';
import { bindSemanticProducerRoles } from './erasure-producer.ts';
import { readAccountIdentitySource } from '../access/agent-verification-identity.ts';
import { admitIdentityReceivingEffect } from './identity-receiving-effects.ts';
import {
  identityBindingData,
  assertIdentityBindingSource,
  identityBindingDigest,
  identityReceiptPartition,
  readIdentityBinding,
} from './identity-epoch-binding.ts';
import bindingInsert from './identity-epoch-binding-insert.sql';
import bindingAccept from './identity-epoch-binding-accept.sql';
import selectRemainder from './identity-epoch-mapping-remainder.sql';
import storeInsertNativeCommit from './identity-epoch-store-insert-native-commit.sql';
import storeSelectJob from './identity-epoch-store-select-job.sql';
import storeSelectAck from './identity-epoch-store-select-ack.sql';
import storeSelectControl from './identity-epoch-store-select-control.sql';
import storeSelectJob2 from './identity-epoch-store-select-job-2.sql';
import storeSelectJob3 from './identity-epoch-store-select-job-3.sql';
import storeSelectMapping from './identity-epoch-store-select-mapping.sql';
import storeSelectBootstrapHome from './identity-epoch-store-select-bootstrap-home.sql';
import storeSelectGroup from './identity-epoch-store-select-group.sql';
import storeSelectControl2 from './identity-epoch-store-select-control-2.sql';
import storeSelectSubject2 from './identity-epoch-store-select-subject-2.sql';
import storeSelectMapping3 from './identity-epoch-store-select-mapping-3.sql';
import storeInsertMapping from './identity-epoch-store-insert-mapping.sql';
import storeInsertHomeGate from './identity-epoch-store-insert-home-gate.sql';
import storeInsertGroup from './identity-epoch-store-insert-group.sql';
import storeInsertOriginal from './identity-epoch-store-insert-original.sql';
import storeUpdateDirty from './identity-epoch-store-update-dirty.sql';
import storeSelectJob4 from './identity-epoch-store-select-job-4.sql';
import libraryTransform from './identity-epoch-store-library-transform.sql';
import storeSelectInput from './identity-epoch-store-select-input.sql';
import storeSelectOriginal from './identity-epoch-store-select-original.sql';
import storeSelectHomeGate from './identity-epoch-store-select-home-gate.sql';
import storeSelectRedirect2 from './identity-epoch-store-select-redirect-2.sql';
import storeSelectStep from './identity-epoch-store-select-step.sql';
import storeSelectJob5 from './identity-epoch-store-select-job-5.sql';
import storeSelectEffectReceipt from './identity-epoch-store-select-effect-receipt.sql';
import storeSelectAck2 from './identity-epoch-store-select-ack-2.sql';
import storeInsertAck from './identity-epoch-store-insert-ack.sql';
import storeSelectControl3 from './identity-epoch-store-select-control-3.sql';
import storeSelectEffectReceipt2 from './identity-epoch-store-select-effect-receipt-2.sql';
import storeUpdateJob from './identity-epoch-store-update-job.sql';
import storeUpdateControl2 from './identity-epoch-store-update-control-2.sql';
import storeUpdateGroup2 from './identity-epoch-store-update-group-2.sql';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  currentCommand,
  registerCommandCallback,
  noEffect,
  IdempotencyConflictError,
  type CommandTransaction,
} from '../command/command.ts';
import {
  identityHomeAvailable,
  prepareIdentityEpochAdmission,
  bindIdentityEpochReceipt,
  admitBoundIdentityEpoch,
} from './identity-epoch-admission.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { readIdentityMappings } from './identity-epoch-read.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { IDENTITY_EPOCH_ADMITTED } from './events.ts';
import { readIdentityEpochCutover } from './identity-epoch-bootstrap.ts';
import type {
  IdentityEpochStore,
  IdentityJob,
  IdentityJobRef,
  IdentityReceipt,
  IdentityStepProgress,
  IdentityStepReceipt,
  IdentityIntent,
  IdentityChange,
} from './identity-epoch-contract.ts';

export const IDENTITY_EPOCH_CONTROL_PARTITION = 0;
/** Fixed initial production capacity, charged once per native (home,job). */
export const IDENTITY_EPOCH_HOME_CAPACITY = 1;
export const identityJobPartition = (job: IdentityJobRef) => partitionOf(route(job.jobId));

const unavailable = () =>
  new IdentityEpochStoreError(
    'identity_epoch_unavailable',
    'Identity source, native group generation or bootstrap closure is not current',
  );
const invalidReceipt = () =>
  new IdentityEpochStoreError(
    'identity_step_receipt_invalid',
    'Missing, uncommitted, foreign-scope or conflicting native identity step receipt',
  );
const stale = () =>
  new IdentityEpochStoreError('identity_effect_stale', 'Identity effect does not match the current home gate');

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Identity original must be a native routed ID');
  return value;
}
function control(tx: CommandTransaction, platform = false) {
  const command = currentCommand(tx);
  if (platform && command.basis !== null)
    throw new TypeError('Identity maintenance requires native admitted platform work');
  return command;
}

/** Use the real executor-minted transaction ID and the component its event fence will commit.
 * The row and the outbox share the same database transaction. This is not a noEffect receipt producer.
 */
const nativeCommitPurposes = new WeakMap<CommandTransaction, string>();
export function recordIdentityEpochNativeCommit(tx: CommandTransaction, purpose: string): void {
  const command = currentCommand(tx);
  // A participant frontier and its scope effects share ONE executor-native commit.
  // This only coalesces callback registration on the live transaction; it grants no admission.
  const prior = nativeCommitPurposes.get(tx);
  if (prior) {
    if (prior !== purpose) throw new TypeError('Conflicting identity native commit purposes');
    return;
  }
  nativeCommitPurposes.set(tx, purpose);
  registerCommandCallback(tx, async (transactionId) => {
    const result = await tx.query(storeInsertNativeCommit.sql, [command.partition, transactionId, purpose]);
    if (result.rowCount !== 1) throw unavailable();
  });
}

export function serializeIdentityValue(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry));
}
export function identityReceiptValue(receipt: IdentityReceipt) {
  return receipt.kind === 'subject.merge'
    ? {
        kind: receipt.kind,
        command: { ...receipt.command, digest: Buffer.from(receipt.command.digest).toString('base64') },
      }
    : receipt;
}
export function identityReceiptKey(receipt: IdentityReceipt): string {
  return receipt.kind === 'subject.merge'
    ? json([receipt.kind, receipt.command.actorAccountId, receipt.command.kind, receipt.command.key])
    : json([receipt.kind, receipt.account, receipt.receipt]);
}
const json = serializeIdentityValue;
const receiptValue = identityReceiptValue;
const receiptKey = identityReceiptKey;
function decodeReceipt(value: ReturnType<typeof identityReceiptValue> | { kind: 'erased' }): IdentityJob['receipt'] {
  return value.kind === 'subject.merge'
    ? { ...value, command: { ...value.command, digest: Buffer.from(value.command.digest, 'base64') } }
    : value;
}

export async function authorizeIdentityAdmission(
  tx: CommandTransaction,
  receipt: IdentityReceipt,
  binding?: import('./identity-epoch-binding.ts').IdentityReceiptBinding,
  intent?: IdentityIntent,
) {
  const command = currentCommand(tx);
  if (receipt.kind !== 'subject.merge') {
    if (command.basis !== null) throw new TypeError('Accounts identity admission requires native platform intent');
    if (binding) {
      assertIdentityBindingSource(binding, receipt);
      // The native bridge proof was read under current source-home T before releasing that home.
      // Raw platform work alone never reaches this branch.
      return;
    }
    return readAccountIdentitySource(tx, receipt, intent);
  }
  const authorization = command.authorization;
  if (
    !command.basis ||
    command.basis.actorAccountId !== receipt.command.actorAccountId ||
    !authorization ||
    authorization.mode !== 'execute' ||
    authorization.action !== 'subject:merge' ||
    authorization.resource.route !== 0 ||
    authorization.resource.id !== GLOBAL_CONTEXT
  )
    throw new TypeError('Identity admission requires current native Global subject:merge authorization');
}
function decodeProgress(value: IdentityStepProgress): IdentityStepProgress {
  return {
    ...value,
    job: { ...value.job, epoch: BigInt(value.job.epoch) },
    receipt: {
      ...value.receipt,
      job: { ...value.receipt.job, epoch: BigInt(value.receipt.job.epoch) },
      native: { ...value.receipt.native, position: BigInt(value.receipt.native.position) },
    },
  };
}

async function readJob(tx: CommandTransaction, job: IdentityJobRef): Promise<IdentityJob | null> {
  const partition = identityJobPartition(job);
  const owner = await readPartition(tx, partition);
  if (!owner || owner.writeState !== 'active') return null;
  const row = (await tx.query(storeSelectJob.sql, [job.jobId, job.epoch.toString(), partition])).rows[0];
  if (!row) return null;
  const acks = (await tx.query(storeSelectAck.sql, [job.jobId, partition])).rows;
  const progress = (step: string) => {
    const ack = acks.find((ack) => ack.step === step);
    return ack ? decodeProgress(ack.progress) : null;
  };
  const intent =
    row.intent.kind === 'unmerge'
      ? { ...row.intent, undoJob: { ...row.intent.undoJob, epoch: BigInt(row.intent.undoJob.epoch) } }
      : row.intent;
  return {
    ref: job,
    intent,
    receipt: decodeReceipt(row.receipt),
    state: row.state,
    mapping: progress('mapping'),
    participants: {
      'search-canonical-index': progress('search-canonical-index'),
      'library-private-follow-counts': progress('library-private-follow-counts'),
    },
  };
}

/** One keyed selection in the captured generation, independent of presentation visibility. */
export async function selectIdentityEpochRemainder(
  tx: CommandTransaction,
  intent: IdentityIntent,
  input: { partition_no: number; terminal: string; generation: string },
): Promise<string | null> {
  if (intent.kind === 'merge' || input.terminal !== intent.original) return null;
  return (
    (await tx.query(selectRemainder.sql, [input.partition_no, input.generation, intent.original])).rows[0]?.original ??
    null
  );
}

type TransformSource = {
  input_original: string;
  terminal: string;
  observed_count: string;
  remainder_terminal?: string | null;
};
/** Validate the captured transform before binding or allocating an attempt. */
export function identityEpochRemainderTerminal(
  intent: IdentityIntent,
  sources: readonly TransformSource[],
): string | null {
  if (intent.kind === 'merge') return null;
  const source = sources.find((row) => row.input_original === intent.original);
  if (!source) throw unavailable();
  const count = BigInt(source.observed_count);
  if (count < 1n) throw unavailable();
  if (count - 1n > 4096n)
    throw new IdentityEpochStoreError(
      'identity_group_overflow',
      'Resulting identity group exceeds 4096 complete originals',
    );
  if (intent.kind === 'repoint') {
    const target = sources.find((row) => row.input_original === intent.terminal);
    if (!target || target.terminal !== intent.terminal || source.terminal === target.terminal) throw stale();
  }
  if (source.terminal !== intent.original) return null;
  const remainder = source.remainder_terminal ?? null;
  if (count > 1n !== (remainder !== null) || remainder === intent.original) throw unavailable();
  return remainder;
}

/** The store page and executable mapping consume the same immutable constant transform. */
export function identityEpochChangeTerminal(
  intent: IdentityIntent,
  remainder: string | null,
  original: string,
  previous: string,
): string {
  return libraryChangeTerminal(intent, remainder, original, previous);
}

function libraryChangeTerminal(
  intent: IdentityEpochLibraryTransform,
  remainder: string | null,
  original: string,
  previous: string,
): string {
  if (intent.kind === 'merge') return intent.survivor;
  if (original === intent.original) return intent.kind === 'unmerge' ? intent.original : intent.terminal;
  return previous === intent.original && remainder !== null ? remainder : previous;
}

/** Only the constant fields consumed by pageChanges; unrelated immutable intent data stays native. */
export type IdentityEpochLibraryTransform =
  | Readonly<{ kind: 'merge'; survivor: string }>
  | Readonly<{ kind: 'unmerge'; original: string }>
  | Readonly<{ kind: 'repoint'; original: string; terminal: string }>;

// The third row is a paid rejection sentinel, never a silently truncated input generation.
export const identityEpochLibraryInputsSQL =
  'SELECT generation,terminal,control_partition FROM semantic.identity_epoch_input WHERE partition_no=$1 AND job_id=$2 ORDER BY terminal LIMIT 3';

/** Library-only bounded projection of the ordinary pageChanges algorithm, on the caller's RR snapshot.
 * This neither admits a job nor changes the ordinary store API. Every output ID is native UUID width.
 */
export async function pageLibraryIdentityEpochChanges(
  tx: CommandTransaction,
  job: IdentityJobRef,
  after: string | null,
): Promise<{ changes: IdentityChange[]; next: string | null }> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(job.jobId) || typeof job.epoch !== 'bigint' || job.epoch <= 0n ||
      job.epoch > 9223372036854775807n || (after !== null && !uuid.test(after)))
    throw new TypeError('Invalid Library native transform locator');
  const partition = identityJobPartition(job);
  const saved = (await tx.query<{
    kind: 'merge' | 'unmerge' | 'repoint' | null;
    survivor: string | null; original: string | null; terminal: string | null; remainder_terminal: string | null;
  }>(libraryTransform.sql, [partition, job.jobId, job.epoch.toString()])).rows[0];
  if (!saved) throw unavailable();
  const id = (value: string | null): value is string => typeof value === 'string' && uuid.test(value);
  let transform: IdentityEpochLibraryTransform;
  if (saved.kind === 'merge' && id(saved.survivor) && saved.remainder_terminal === null)
    transform = { kind: saved.kind, survivor: saved.survivor };
  else if (saved.kind === 'unmerge' && id(saved.original))
    transform = { kind: saved.kind, original: saved.original };
  else if (saved.kind === 'repoint' && id(saved.original) && id(saved.terminal))
    transform = { kind: saved.kind, original: saved.original, terminal: saved.terminal };
  else throw unavailable();
  if (saved.remainder_terminal !== null &&
      (!id(saved.remainder_terminal) || (transform.kind !== 'merge' && saved.remainder_terminal === transform.original)))
    throw unavailable();
  const inputs = (await tx.query<{ generation: string; terminal: string; control_partition: number }>(
    identityEpochLibraryInputsSQL, [partition, job.jobId],
  )).rows;
  if (inputs.length < 1 || inputs.length > 2 || inputs.some((input) =>
    !id(input.generation) || !id(input.terminal) || input.control_partition !== partition,
  )) throw unavailable();
  const limit = inputs.length === 1 ? 100 : 50;
  const pages: Array<Array<{ original: string; terminal: string }>> = [];
  for (const input of inputs) {
    const page = (await tx.query<{ original: string; terminal: string }>(storeSelectOriginal.sql, [
      input.generation, after, limit, input.terminal, input.control_partition,
    ])).rows;
    if (page.length > limit || page.some((row, index) => !id(row.original) || !id(row.terminal) ||
      (after !== null && row.original <= after) || (index > 0 && page[index - 1]!.original >= row.original)))
      throw unavailable();
    pages.push(page);
  }
  const cutoff = pages.filter((page) => page.length === limit).map((page) => page.at(-1)!.original).sort()[0];
  const originals = new Map<string, string>();
  for (const row of pages.flat()) {
    if (cutoff && row.original > cutoff) continue;
    const previous = originals.get(row.original);
    if (previous !== undefined && previous !== row.terminal) throw unavailable();
    originals.set(row.original, row.terminal);
  }
  const changes = [...originals].sort(([a], [b]) => a.localeCompare(b)).map(([original, previousTerminal]) => ({
    original, previousTerminal,
    terminal: libraryChangeTerminal(transform, saved.remainder_terminal, original, previousTerminal),
  }));
  return { changes, next: cutoff ? changes.at(-1)!.original : null };
}

/** Native source mappings and partition-scoped admission. Participant completion is never inferred. */
export const identityEpochStore: IdentityEpochStore = {
  // Compatibility for topology observations only; actual job homes are encoded by their native routed IDs.
  controlPartition: IDENTITY_EPOCH_CONTROL_PARTITION,
  prepareAdmission: prepareIdentityEpochAdmission,
  bindReceipt: bindIdentityEpochReceipt,
  async readEpoch(tx, partition = 0) {
    const owner = await readPartition(tx, partition);
    if (!owner) return { state: 'unavailable', reason: 'missing-owner' };
    if (owner.writeState !== 'active')
      return { state: 'unavailable', reason: owner.writeState === 'moved' ? 'moved-owner' : 'bootstrap' };
    if ((await readIdentityEpochCutover(tx)).state !== 'ready') return { state: 'unavailable', reason: 'bootstrap' };
    const row = (await tx.query(storeSelectControl.sql, [partition])).rows[0];
    if (!row) return { state: 'unavailable', reason: 'bootstrap' };
    return row.pending_job
      ? {
          state: 'pending',
          publishedEpoch: BigInt(row.published_epoch),
          job: { jobId: row.pending_job, epoch: BigInt(row.pending_epoch) },
        }
      : { state: 'published', epoch: BigInt(row.published_epoch) };
  },
  readJob,
  async findJob(tx, receipt, binding) {
    const command = currentCommand(tx);
    await authorizeIdentityAdmission(tx, receipt, binding);
    if (binding) {
      const data = identityBindingData(binding);
      if (data.key !== receiptKey(receipt) || canonicalize(data.receipt) !== canonicalize(receiptValue(receipt)))
        throw new IdempotencyConflictError(command.partition);
      if (command.partition !== data.home) throw new TypeError('Job lookup requires the explicit native job home');
      return readJob(tx, data.job);
    }
    if (command.partition !== identityReceiptPartition(receipt))
      throw new TypeError('Cross-home receipt lookup requires a released native binding proof');
    const row = (
      await tx.query(storeSelectJob2.sql, [receiptKey(receipt), json(receiptValue(receipt)), command.partition])
    ).rows[0];
    return row ? readJob(tx, { jobId: row.job_id, epoch: BigInt(row.epoch) }) : null;
  },
  readMappings: readIdentityMappings,
  async readMapping(pool, original) {
    return (await readIdentityMappings(pool, [original]))[0]!;
  },
  async admit(tx, { intent, receipt, binding }) {
    if (binding) return admitBoundIdentityEpoch(tx, { intent, receipt, binding }, true);
    if (currentCommand(tx).partition !== identityReceiptPartition(receipt)) {
      await authorizeIdentityAdmission(tx, receipt);
      throw new TypeError('Cross-home receipt admission requires a released native binding proof');
    }
    const command = control(tx);
    const accountSource = await authorizeIdentityAdmission(tx, receipt, undefined, intent);
    const claimed = await readIdentityBinding(tx, { intent, receipt });
    if (claimed) return admitBoundIdentityEpoch(tx, { intent, receipt, binding: claimed }, true);
    const prior = (await tx.query(storeSelectJob3.sql, [receiptKey(receipt), command.partition])).rows[0];
    if (prior) {
      if (
        canonicalize(prior.intent) !== canonicalize(JSON.parse(json(intent))) ||
        canonicalize(prior.receipt) !== canonicalize(receiptValue(receipt))
      )
        throw new IdempotencyConflictError(command.partition);
      if (prior.state !== 'pending' && prior.state !== 'published') throw unavailable();
      return noEffect({ jobId: prior.job_id, epoch: BigInt(prior.epoch) });
    }
    const ids =
      intent.kind === 'merge'
        ? [intent.redirected, intent.survivor]
        : intent.kind === 'repoint'
          ? [intent.original, intent.terminal]
          : [intent.original];
    const routes = ids.map(route);
    if (routes.some((r) => partitionOf(r) !== command.partition))
      throw new IdentityEpochStoreError(
        'identity_epoch_unavailable',
        'Identity inputs require released-home preparation',
      );
    const sources = (await tx.query(storeSelectMapping.sql, [ids, routes, command.partition])).rows;
    if (new Set(sources.map((g) => g.input_original)).size !== new Set(ids).size) throw unavailable();
    const inputs = [...new Map(sources.map((g) => [g.terminal, g])).values()];
    const sourceClosure = (await tx.query(storeSelectBootstrapHome.sql, [command.partition])).rows[0];
    if (
      !inputs.length ||
      (inputs.some((g) => !g.ready) &&
        ((await readIdentityEpochCutover(tx)).state !== 'ready' || !sourceClosure?.sealed_generation))
    )
      throw unavailable();
    if (inputs.some((g) => g.pending_job))
      throw new IdentityEpochStoreError('identity_epoch_busy', 'An input group is already claimed');
    for (const input of inputs) {
      const remainder = await selectIdentityEpochRemainder(tx, intent, input);
      for (const source of sources.filter((row) => row.terminal === input.terminal))
        source.remainder_terminal = remainder;
    }
    const remainderTerminal = identityEpochRemainderTerminal(intent, sources);
    const resulting =
      intent.kind === 'merge'
        ? inputs.reduce((n, g) => n + BigInt(g.observed_count), 0n)
        : intent.kind === 'repoint'
          ? BigInt(sources.find((g) => g.input_original === intent.terminal)!.observed_count) +
            (sources[0]!.generation === sources[1]!.generation ? 0n : 1n)
          : 1n;
    if (resulting > 4096n)
      throw new IdentityEpochStoreError(
        'identity_group_overflow',
        'Resulting identity group exceeds 4096 complete originals',
      );
    if (
      (
        await tx.query(
          `SELECT slot FROM semantic.identity_epoch_mapping_generation WHERE partition_no=$1 ORDER BY slot LIMIT 1`,
          [command.partition],
        )
      ).rowCount
    )
      throw unavailable();
    // Lock/revalidate every immutable input BEFORE reservation. The control row serializes local P=1 capacity.
    const state = (await tx.query(storeSelectControl2.sql, [command.partition])).rows[0];
    const locked = (await tx.query(storeSelectGroup.sql, [command.partition, inputs.map((g) => g.terminal)])).rows;
    if (
      locked.some(
        (g) =>
          !inputs.some(
            (v) =>
              v.terminal === g.terminal && v.generation === g.generation && BigInt(v.version) === BigInt(g.version),
          ),
      )
    )
      throw unavailable();
    await assertIdentityTerminalGroupsOpen(
      tx,
      locked.map((g) => g.terminal),
    );
    if (locked.some((g) => g.pending_job))
      throw new IdentityEpochStoreError('identity_epoch_busy', 'An input group is already claimed');
    if (!state || state.pending_job || state.prepare_job || state.retained_preparation)
      throw new IdentityEpochStoreError('identity_epoch_unavailable', 'Native identity home capacity is occupied');
    const job = { jobId: newId(command.partition * 16), epoch: BigInt(state.allocated_epoch) + 1n };
    const scope = createHash('sha256')
      .update(
        json([intent, inputs.map((g) => [g.terminal, g.generation, g.version, g.observed_count]), remainderTerminal]),
      )
      .digest('hex');
    if (accountSource) bindSemanticProducerRoles(tx, accountSource.roles);
    recordIdentityEpochNativeCommit(tx, 'admission');
    registerCommandCallback(tx, async (transactionId) => {
      await tx.query(bindingInsert.sql, [
        command.partition,
        receiptKey(receipt),
        identityBindingDigest({ intent, receipt }),
        json(receiptValue(receipt)),
        json(intent),
        job.jobId,
        command.partition,
        job.epoch.toString(),
        scope,
        json(sources),
        transactionId,
        receipt.kind === 'subject.merge' ? receipt.command.actorAccountId : receipt.account,
      ]);
      await tx.query(bindingAccept.sql, [command.partition, receiptKey(receipt), '1', job.jobId, job.epoch.toString()]);
      await tx.query(admissionInsertJob.sql, [
        command.partition,
        job.jobId,
        job.epoch.toString(),
        json(intent),
        receiptKey(receipt),
        json(receiptValue(receipt)),
        scope,
        transactionId,
        remainderTerminal,
      ]);
      await tx.query(admissionInsertBases.sql, [command.partition, job.jobId, json(sources)]);
      await tx.query(admissionHandoff.sql, [
        command.partition,
        job.jobId,
        job.epoch.toString(),
        scope,
        command.partition,
        transactionId,
        json(
          inputs.map((g) => ({
            terminal: g.terminal,
            generation: g.generation,
            basis_version: g.version,
            owner_epoch: g.owner_epoch,
          })),
        ),
      ]);
      await tx.query(admissionPrepare.sql, [command.partition, job.jobId, job.epoch.toString(), scope]);
      await tx.query(admissionRecord.sql, [command.partition, transactionId, job.jobId, 'prepared']);
      await recordPreparedIdentityPrearm(tx, job, scope, transactionId);
      const prepared = (
        await tx.query(admissionReceipt.sql, [command.partition, job.jobId, job.epoch.toString(), 'prepared'])
      ).rows[0];
      await tx.query(admissionCustodyPrepare.sql, [
        job.jobId,
        command.partition,
        prepared.transaction_id,
        prepared.native_epoch,
        prepared.native_position,
        command.partition,
      ]);
      await sealColocatedEmptyIdentityPrearm(tx, job, transactionId);
      await tx.query(admissionAcquire.sql, [command.partition, job.jobId, job.epoch.toString(), scope]);
      await tx.query(admissionRecord.sql, [command.partition, transactionId, job.jobId, 'acquired']);
      const claimed = (
        await tx.query(admissionReceipt.sql, [command.partition, job.jobId, job.epoch.toString(), 'acquired'])
      ).rows[0];
      await tx.query(admissionCustodyAcquire.sql, [
        job.jobId,
        command.partition,
        claimed.transaction_id,
        claimed.native_epoch,
        claimed.native_position,
        command.partition,
      ]);
      if ((await tx.query(admissionPromote.sql, [job.jobId, job.epoch.toString(), command.partition])).rowCount !== 1)
        throw stale();
    });
    return {
      value: job,
      events: [
        {
          type: IDENTITY_EPOCH_ADMITTED,
          data: { jobId: job.jobId, epoch: job.epoch.toString(), partition: command.partition },
        },
      ],
    };
  },
  async initializeSubject(tx, original) {
    const command = currentCommand(tx);
    const originalRoute = route(original);
    if (command.partition !== partitionOf(originalRoute)) throw new TypeError('Wrong subject creation home');
    if (
      command.basis !== null &&
      (!command.authorization ||
        command.authorization.action !== 'subject:create' ||
        command.authorization.mode !== 'execute')
    )
      throw new TypeError('Exact self requires native subject:create authorization');
    const source = (await tx.query(storeSelectSubject2.sql, [originalRoute, original])).rows[0];
    if (!source) throw new TypeError('initializeSubject requires the same native creation transaction');
    // A birth mapping is tied to the actual source-home fence that commits revision 1. Zero is
    // not a current epoch, and a process-local/default value would let a moved home look current.
    const owner = await readPartition(tx, command.partition);
    if (!owner || owner.writeState !== 'active') throw unavailable();
    const existing = (await tx.query(storeSelectMapping3.sql, [originalRoute, original])).rows[0];
    if (existing) {
      if (
        existing.terminal === original &&
        existing.owner_epoch === owner.epoch &&
        BigInt(existing.epoch) > 0n &&
        existing.origin === 'creation' &&
        existing.recorded_transaction_id === source.recorded_transaction_id &&
        existing.gate_transaction_id === source.recorded_transaction_id &&
        !existing.pending_job &&
        existing.pending_epoch === null
      )
        return;
      throw new TypeError('Identity self mapping already exists outside this exact creation transaction');
    }
    const header = (await tx.query(storeInsertGroup.sql, [command.partition, original, owner.epoch])).rows[0];
    if (!header) throw unavailable();
    await tx.query(storeInsertMapping.sql, [
      originalRoute,
      original,
      owner.epoch,
      source.recorded_transaction_id,
      command.partition,
      header.published_epoch,
    ]);
    await tx.query(storeInsertHomeGate.sql, [
      originalRoute,
      original,
      header.published_epoch,
      source.recorded_transaction_id,
    ]);
    await tx.query(storeInsertOriginal.sql, [command.partition, header.generation, original]);
    await tx.query(storeUpdateDirty.sql, [originalRoute, original]);
    registerCommandCallback(tx, async (transactionId) => {
      if (transactionId !== source.recorded_transaction_id)
        throw new TypeError('initializeSubject requires the executor native creation transaction');
    });
  },
  async pageChanges(tx, job, after) {
    const partition = identityJobPartition(job);
    const owner = await readPartition(tx, partition);
    if (!owner || owner.writeState !== 'active') throw unavailable();
    const saved = (await tx.query(storeSelectJob4.sql, [partition, job.jobId, job.epoch.toString()])).rows[0];
    if (!saved) throw new TypeError('Unknown native identity job');
    const inputs = (await tx.query(storeSelectInput.sql, [partition, job.jobId])).rows;
    const pages: Array<{ original: string; terminal: string }[]> = [];
    const allowance = inputs.length === 1 ? 100 : 50;
    for (const input of inputs)
      pages.push(
        (
          await tx.query(storeSelectOriginal.sql, [
            input.generation,
            after,
            allowance,
            input.terminal,
            input.control_partition,
          ])
        ).rows,
      );
    const fences = pages
      .filter((p) => p.length === allowance)
      .map((p) => p.at(-1)!.original)
      .sort();
    const frontier = fences[0];
    const intent = saved.intent as IdentityIntent;
    const changes: IdentityChange[] = pages
      .flat()
      .filter((r) => !frontier || r.original <= frontier)
      .sort((a, b) => a.original.localeCompare(b.original))
      .map((r) => ({
        original: r.original,
        previousTerminal: r.terminal,
        terminal: identityEpochChangeTerminal(intent, saved.remainder_terminal, r.original, r.terminal),
      }));
    return { changes, next: frontier ? changes.at(-1)!.original : null };
  },
  async admitHomeEffect(tx, effect) {
    const command = currentCommand(tx);
    if (effect.kind === 'receiving') return admitIdentityReceivingEffect(tx, effect);
    if (effect.kind === 'structural' && effect.controlGroup) {
      if (command.basis !== null || effect.destination !== undefined) throw stale();
      const group = (
        await tx.query(
          `SELECT g.pending_job,g.pending_epoch,g.generation FROM semantic.identity_epoch_group g
        JOIN core.partition p ON p.partition_no=g.partition_no AND p.epoch=g.owner_epoch AND p.write_state='active'
        WHERE g.partition_no=$1 AND g.terminal=$2 FOR UPDATE OF g`,
          [command.partition, effect.controlGroup.terminal],
        )
      ).rows[0];
      if (
        !group ||
        group.pending_job !== effect.job.jobId ||
        BigInt(group.pending_epoch ?? -1) !== effect.job.epoch ||
        group.generation !== effect.controlGroup.generation
      )
        throw stale();
      return;
    }
    const destination = effect.kind === 'follow-count' ? effect.terminal : (effect.destination ?? effect.original);
    const destinationRoute = route(destination);
    if (command.partition !== partitionOf(destinationRoute)) throw stale();
    const gate = (await tx.query(storeSelectHomeGate.sql, [destinationRoute, destination, effect.original])).rows[0];
    if (!gate) throw stale();
    if (effect.kind === 'follow-count') {
      if (gate.pending_job || gate.terminal !== effect.terminal || BigInt(gate.epoch) !== effect.epoch) throw stale();
      if (
        effect.original === destination &&
        (await tx.query(storeSelectRedirect2.sql, [destinationRoute, effect.original])).rowCount
      )
        throw stale();
    } else {
      if (
        command.basis !== null ||
        gate.pending_job !== effect.job.jobId ||
        BigInt(gate.pending_epoch ?? -1) !== effect.job.epoch
      )
        throw stale();
      await tx.query("SELECT set_config('semantic.identity_prearm_effect_job',$1,true)", [effect.job.jobId]);
    }
    return;
  },
  async reconcileStepReceipt(pool: Pool, receipt: IdentityStepReceipt) {
    if (
      receipt.version !== 1 ||
      !['mapping', 'search-canonical-index', 'library-private-follow-counts'].includes(receipt.step)
    )
      throw invalidReceipt();
    const saved = await withConnection(pool, async (tx) => {
      const owner = await readPartition(tx, receipt.native.partition);
      if (
        !owner ||
        owner.writeState !== 'active' ||
        owner.epoch !== receipt.native.epoch ||
        owner.position < receipt.native.position
      )
        throw invalidReceipt();
      const row = (
        await tx.query(storeSelectStep.sql, [
          receipt.native.partition,
          receipt.native.transactionId,
          receipt.native.epoch,
          receipt.native.position.toString(),
          receipt.job.jobId,
          receipt.job.epoch.toString(),
          receipt.step,
        ])
      ).rows[0];
      if (!row) throw invalidReceipt();
      return row;
    });
    // Source home is released. No caller-supplied completion or frontier enters the control transaction.
    const { runCommand } = await import('../command/command.ts');
    const result = await runCommand<IdentityStepProgress>(
      pool,
      { partition: identityJobPartition(receipt.job) },
      async (tx) => {
        control(tx, true);
        const job = (
          await tx.query(storeSelectJob5.sql, [
            receipt.job.jobId,
            receipt.job.epoch.toString(),
            identityJobPartition(receipt.job),
          ])
        ).rows[0];
        if (!job || saved.scope_digest !== job.scope_digest) throw invalidReceipt();
        // Custody of every prior withdrawal, addition and fence must already exist. A locator is insufficient.
        const missing = (
          await tx.query(storeSelectEffectReceipt.sql, [
            receipt.job.jobId,
            receipt.step,
            identityJobPartition(receipt.job),
          ])
        ).rowCount;
        if (missing || saved.state !== 'complete') throw invalidReceipt();
        const progress: IdentityStepProgress = {
          job: receipt.job,
          frontier: saved.frontier,
          state: saved.state,
          work: saved.work,
          receipt,
        };
        const previous = (
          await tx.query(storeSelectAck2.sql, [receipt.job.jobId, receipt.step, identityJobPartition(receipt.job)])
        ).rows[0];
        if (previous) {
          if (canonicalize(previous.progress) !== canonicalize(JSON.parse(json(progress)))) throw invalidReceipt();
          return noEffect(decodeProgress(previous.progress));
        }
        await tx.query(storeInsertAck.sql, [
          identityJobPartition(receipt.job),
          receipt.job.jobId,
          receipt.step,
          job.scope_digest,
          json(progress),
          receipt.native.partition,
          receipt.native.epoch,
          receipt.native.position.toString(),
          receipt.native.transactionId,
        ]);
        return {
          value: progress,
          events: [
            {
              type: IDENTITY_EPOCH_ADMITTED,
              data: {
                jobId: receipt.job.jobId,
                epoch: receipt.job.epoch.toString(),
                partition: identityJobPartition(receipt.job),
              },
            },
          ],
        };
      },
    );
    return result.value;
  },
  async publish(tx, job) {
    control(tx, true);
    const saved = await readJob(tx, job);
    if (
      !saved ||
      saved.mapping?.state !== 'complete' ||
      saved.participants['search-canonical-index']?.state !== 'complete' ||
      saved.participants['library-private-follow-counts']?.state !== 'complete'
    )
      throw new IdentityEpochStoreError(
        'identity_participants_incomplete',
        'Actual mapping, Search and Library ACK custody is incomplete',
      );
    if (saved.state === 'published') return noEffect(job);
    const partition = identityJobPartition(job);
    if (currentCommand(tx).partition !== partition) throw new TypeError('Wrong identity publication home');
    const state = (await tx.query(storeSelectControl3.sql, [partition])).rows[0];
    if (state?.pending_job !== job.jobId || BigInt(state.pending_epoch) !== job.epoch) throw stale();
    const outstanding = (await tx.query(storeSelectEffectReceipt2.sql, [partition, job.jobId])).rowCount;
    if (outstanding)
      throw new IdentityEpochStoreError('identity_participants_incomplete', 'Prior effects lack receiving custody');
    const publishingGroups = (
      await tx.query(
        `SELECT terminal FROM semantic.identity_epoch_group
      WHERE partition_no=$1 AND pending_job=$2 ORDER BY terminal LIMIT 100 FOR UPDATE`,
        [partition, job.jobId],
      )
    ).rows;
    await assertIdentityTerminalGroupsOpen(
      tx,
      publishingGroups.map((g) => g.terminal),
    );
    await tx.query(storeUpdateJob.sql, [partition, job.jobId]);
    await tx.query(storeUpdateControl2.sql, [partition, job.epoch.toString()]);
    await tx.query(storeUpdateGroup2.sql, [partition, job.epoch.toString(), job.jobId]);
    return {
      value: job,
      events: [
        { type: IDENTITY_EPOCH_ADMITTED, data: { jobId: job.jobId, epoch: job.epoch.toString(), partition } },
        identityHomeAvailable(partition),
      ],
    };
  },
};
