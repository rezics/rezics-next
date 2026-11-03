import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { QueryResultRow } from 'pg';
import {
  currentCommand,
  currentCommandResources,
  hasLiveCommandTransaction,
  registerCommandCallback,
  type CommandTransaction,
} from '../command/command.ts';
import type { IdentityFrontier, IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import {
  identityJobPartition,
  recordIdentityEpochNativeCommit,
  serializeIdentityValue as json,
} from '../semantic/identity-epoch-store.ts';
import { currentReadSnapshot, withReadTransaction } from '../semantic/read.ts';
import { subjectPartition } from './source.ts';
import { decodeSearchRepairWriterReceipt, validateSearchRepairWriterEvidence } from './writer-guard.ts';
import type {
  SearchIdentityReceivingContext,
  SearchIdentityReceivingHold,
  SearchIdentityReceivingLocator,
  SearchIdentityReceivingSelection,
  SearchIdentityReceivingRecord,
} from './identity-receiving-native-contract.ts';
import { snapshotSearchIdentityReceivingFrontier } from './identity-receiving-native-contract.ts';
import type {
  CopyRow,
  HoldRow,
  OperationRow,
  PlanRow,
  SearchNativeReceivingConfiguration,
  SearchNativeReceivingCopy,
  SearchNativeReceivingOperation,
  SearchNativeReceivingPlan,
  SearchNativeReceivingPreparation,
  SearchNativeReceivingStored,
  StoredCopy,
  StoredReceipt,
  WriterRow,
} from './identity-receiving-native-internal.ts';
import {
  SearchNativeReceivingError,
  SearchNativeReceivingWork,
  type SearchNativeReceivingSql,
} from './identity-receiving-native-work.ts';
import ownerSql from './identity-receiving-native-owner.sql';
import planSql from './identity-receiving-native-plan.sql';
import prepareSql from './identity-receiving-native-prepare.sql';
import documentSql from './identity-receiving-native-document.sql';
import lockSql from './identity-receiving-native-lock.sql';
import writerSql from './identity-receiving-native-writer.sql';
import actionSql from './identity-receiving-native-action.sql';
import receiptSql from './identity-receiving-native-receipt.sql';
import holdSql from './identity-receiving-native-hold.sql';
import peekHoldSql from './identity-receiving-native-peek-hold.sql';
import acceptSql from './identity-receiving-native-accept.sql';
import acceptedSql from './identity-receiving-native-accepted.sql';
import bindAcceptanceSql from './identity-receiving-native-bind-acceptance.sql';
import operationSql from './identity-receiving-native-operation.sql';
import dispatchSql from './identity-receiving-native-dispatch.sql';
import visibleSql from './identity-receiving-native-visible.sql';
import applySql from './identity-receiving-native-apply.sql';
import appliedSql from './identity-receiving-native-applied.sql';
import copiesSql from './identity-receiving-native-copies.sql';
import insertCopiesSql from './identity-receiving-native-insert-copies.sql';
import copySql from './identity-receiving-native-copy.sql';
import copyLastSql from './identity-receiving-native-copy-last.sql';
import copyOwnerSql from './identity-receiving-native-copy-owner.sql';
import reconcileSql from './identity-receiving-native-reconcile.sql';
import pendingSql from './identity-receiving-native-pending.sql';
import controlSql from './identity-receiving-native-control.sql';
import releaseSql from './identity-receiving-native-release.sql';
import releaseProofSql from './identity-receiving-native-release-proof.sql';
import drainSql from './identity-receiving-native-drain.sql';
import drainGateSql from './identity-receiving-native-drain-gate.sql';

/** Indexed SQL text for SearchNativeReceivingSql. Declaration emit cannot name reylo error fields. */
export type SearchNativeReceivingStatements = {
  readonly [K in SearchNativeReceivingSql]: { readonly sql: string };
};

export const searchNativeReceivingStatements: SearchNativeReceivingStatements = Object.freeze({
  owner: ownerSql,
  plan: planSql,
  prepare: prepareSql,
  document: documentSql,
  lock: lockSql,
  writer: writerSql,
  action: actionSql,
  receipt: receiptSql,
  hold: holdSql,
  peekHold: peekHoldSql,
  accept: acceptSql,
  accepted: acceptedSql,
  bindAcceptance: bindAcceptanceSql,
  operation: operationSql,
  dispatch: dispatchSql,
  visible: visibleSql,
  apply: applySql,
  applied: appliedSql,
  copies: copiesSql,
  insertCopies: insertCopiesSql,
  copy: copySql,
  copyLast: copyLastSql,
  copyOwner: copyOwnerSql,
  reconcile: reconcileSql,
  pending: pendingSql,
  control: controlSql,
  release: releaseSql,
  releaseProof: releaseProofSql,
  drain: drainSql,
  drainGate: drainGateSql,
});
const statements = searchNativeReceivingStatements;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const unsigned = /^(0|[1-9][0-9]*)$/;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const nativeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? { nativeBigint: String(item) } : item));
const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(JSON.parse(json(a)), JSON.parse(json(b)));
const receipt = (value: StoredReceipt): IdentityNativeReceipt => ({ ...value, position: BigInt(value.position) });
const copy = (value: StoredCopy): SearchNativeReceivingCopy => ({
  ...value,
  close: receipt(value.close),
  enrollment: value.enrollment && receipt(value.enrollment),
  visible: value.visible && receipt(value.visible),
});
const key = (locator: SearchIdentityReceivingLocator): readonly [number, string] => [locator.partition, locator.planId];
const validReceipt = (value: IdentityNativeReceipt, home: number): boolean =>
  value.partition === home &&
  Number.isInteger(value.epoch) &&
  value.epoch > 0 &&
  value.epoch <= 2147483647 &&
  typeof value.position === 'bigint' &&
  value.position > 0n &&
  value.position <= 9223372036854775807n &&
  uuid.test(value.transactionId);

/** An opaque observation returned only by this store's real, released owner read. */
export type SearchNativeReceivingCopyObservation = Readonly<{ copyNo: number; settlement: IdentityNativeReceipt }>;
/** Actual applied control custody; serialization or copying loses its in-process capability. */
export type SearchNativeReceivingReleaseObservation = Readonly<{ custody: IdentityNativeReceipt }>;
type CopyEvidence = { locator: SearchIdentityReceivingLocator; original: SearchNativeReceivingCopy };
type ReleaseEvidence = {
  locator: SearchIdentityReceivingLocator;
  applied: IdentityNativeReceipt;
  accepted: IdentityNativeReceipt;
  frontier: IdentityFrontier;
  source: SearchNativeReceivingPlan['source'];
};
type Component = { epoch: number; position: string };
type WriterEvidence = { repair_locator: string | null; value: string | null };
type OwnerCopyRow = Component & { close_proven: boolean } & Omit<
    WriterRow,
    | 'owner_epoch'
    | 'enrollment_generation'
    | 'fence_generation'
    | 'closed_token'
    | 'source_position'
    | 'changed_in_command'
  >;

/** Search-owned transaction/storage core. It is deliberately not Semantic admission or Source eligibility.
 * Public receiving wrappers must obtain those owners' genuine witnesses before selecting a plan or dispatching.
 */
export function createSearchIdentityReceivingNativeStore(configuration: SearchNativeReceivingConfiguration) {
  const { pool, index, consumer } = configuration;
  if (
    !pool ||
    !/^[a-z0-9][a-z0-9-]{0,127}subjects-g[1-9][0-9]*$/.test(index) ||
    !consumer ||
    Buffer.byteLength(consumer) > 256
  )
    throw new TypeError('Invalid native receiving owner');
  const copyEvidence = new WeakMap<SearchNativeReceivingCopyObservation, CopyEvidence>();
  const releaseEvidence = new WeakMap<
    SearchNativeReceivingReleaseObservation,
    ReleaseEvidence & { consumed: boolean; revoked: boolean }
  >();

  async function sql<R extends QueryResultRow>(
    tx: CommandTransaction,
    work: SearchNativeReceivingWork,
    name: SearchNativeReceivingSql,
    args: readonly unknown[],
  ) {
    work.sql(name);
    const result = await tx.query<R>(statements[name].sql, [...args]);
    if ((name === 'copy' || name === 'copies') && result.rows.some((row) => row.proven !== true))
      work.fail('unavailable', 'Registered original copy has unavailable commit provenance');
    return result;
  }
  async function copies(
    tx: CommandTransaction,
    work: SearchNativeReceivingWork,
    locator: SearchIdentityReceivingLocator,
    after: number,
    limit: number,
  ) {
    work.page('copies', limit);
    const result = await tx.query<CopyRow>(copiesSql.sql, [...key(locator), after, limit]);
    if (result.rows.some((row) => !row.proven)) work.fail('unavailable', 'Registered original copy commit unavailable');
    return result.rows;
  }
  function validateCopies(
    items: readonly SearchNativeReceivingCopy[],
    original: string,
    work: SearchNativeReceivingWork,
  ) {
    if (items.length > 100) work.fail('changed', 'Native copy registration page exceeds 100');
    for (const item of items) {
      if (
        !Number.isInteger(item.home) ||
        item.home < 0 ||
        item.home > 4095 ||
        item.original !== original ||
        !uuid.test(item.original) ||
        !validReceipt(item.close, item.home) ||
        !['enrolled', 'dispatched', 'settled', 'cancelled'].includes(item.state) ||
        Buffer.byteLength(json(item)) > 1792 ||
        !item.physicalTarget ||
        !item.incarnation ||
        !item.consumer ||
        (item.enrollment && !validReceipt(item.enrollment, item.home)) ||
        (item.visible && !validReceipt(item.visible, item.home))
      )
        work.fail('changed', 'Invalid original copy locator');
    }
  }
  async function perform<T>(
    context: SearchIdentityReceivingContext,
    tx: CommandTransaction | null,
    mutate: boolean,
    body: (work: SearchNativeReceivingWork) => Promise<T>,
  ): Promise<SearchNativeReceivingStored<T>> {
    const work = new SearchNativeReceivingWork(context);
    let failed = false;
    try {
      if (!tx && currentReadSnapshot(pool))
        work.fail('unavailable', 'Native owner reconciliation requires independently released read homes');
      if (tx) {
        if (!hasLiveCommandTransaction(tx)) work.fail('unavailable', 'Native receiving requires a live command client');
        const resources = currentCommandResources(tx);
        if (resources.pool !== pool || currentCommand(tx).basis !== null || work.context.deadline > resources.deadline)
          work.fail('unavailable', 'Native receiving Pool, maintenance basis or deadline changed');
        if (mutate) {
          work.rollback();
          registerCommandCallback(tx, () => {
            if (failed) work.fail('unavailable', 'A failed native mutation cannot commit');
          });
        }
      }
      const value = await body(work);
      return { value, work: work.snapshot() };
    } catch (error) {
      failed = true;
      if (error instanceof SearchNativeReceivingError) throw error;
      throw new SearchNativeReceivingError('unavailable', 'Native receiving storage failed', work.snapshot(), {
        cause: error,
      });
    }
  }
  function validateLocator(locator: SearchIdentityReceivingLocator, work: SearchNativeReceivingWork) {
    if (
      locator.kind !== 'search-canonical-index' ||
      locator.version !== 1 ||
      !uuid.test(locator.planId) ||
      !Number.isInteger(locator.partition) ||
      locator.partition < 0 ||
      locator.partition > 4095
    )
      work.fail('changed', 'Invalid native Search locator');
  }
  async function owner(
    tx: CommandTransaction,
    work: SearchNativeReceivingWork,
    locator: SearchIdentityReceivingLocator,
  ) {
    validateLocator(locator, work);
    const command = currentCommand(tx);
    if (command.partition !== locator.partition) work.fail('changed', 'Native receiving home changed');
    const row = (await sql<Component>(tx, work, 'owner', [locator.partition])).rows[0];
    if (!row) work.fail('unavailable', 'Native receiving owner unavailable');
    return {
      partition: locator.partition,
      epoch: row.epoch,
      position: BigInt(row.position) + 1n,
      transactionId: command.transactionId,
    };
  }
  async function readPlan(
    tx: CommandTransaction,
    work: SearchNativeReceivingWork,
    locator: SearchIdentityReceivingLocator,
  ) {
    validateLocator(locator, work);
    const row = (await sql<PlanRow>(tx, work, 'plan', key(locator))).rows[0];
    if (!row) work.fail('unavailable', 'Native plan is absent, uncommitted or no longer at its owner');
    const s = row.source;
    if (
      !unsigned.test(s.enrollmentGeneration) ||
      !unsigned.test(s.fenceGeneration) ||
      !unsigned.test(s.plan.position) ||
      !unsigned.test(s.originalFence.position) ||
      !unsigned.test(row.obligations.documentFence.position) ||
      !same(s.locator, locator) ||
      s.physicalTarget !== index ||
      s.consumer !== consumer ||
      s.receivingHome !== locator.partition ||
      s.receivingEpoch !== row.native_epoch ||
      !same(s.plan, {
        partition: locator.partition,
        epoch: row.native_epoch,
        position: row.native_position,
        transactionId: row.transaction_id,
      })
    )
      work.fail('changed', 'Committed native plan provenance changed');
    const source = {
      ...s,
      enrollmentGeneration: BigInt(s.enrollmentGeneration),
      fenceGeneration: BigInt(s.fenceGeneration),
      originalFence: receipt(s.originalFence),
      plan: receipt(s.plan),
    };
    const refs = row.obligations;
    const references = {
      ...refs,
      documentFence: receipt(refs.documentFence),
      originalSupport: refs.originalSupport && {
        ...refs.originalSupport,
        generation: BigInt(refs.originalSupport.generation),
      },
      terminalSupport: refs.terminalSupport && {
        ...refs.terminalSupport,
        generation: BigInt(refs.terminalSupport.generation),
      },
    };
    const selection: SearchIdentityReceivingSelection = {
      job: { jobId: row.job_id, epoch: BigInt(row.job_epoch) },
      original: source.original,
      effectKey: row.effect_key,
      owner: source.owner,
      sourceId: source.sourceId,
      scope: source.scope,
      disposition: source.disposition,
      native: locator,
    };
    return {
      selection,
      source,
      references,
      scopeDigest: row.scope_digest,
      actionDigest: row.action_digest,
      initialCopyCount: row.initial_copy_count,
    };
  }
  async function lockDocument(
    tx: CommandTransaction,
    work: SearchNativeReceivingWork,
    plan: SearchNativeReceivingPlan,
  ) {
    const row = (await sql(tx, work, 'lock', [plan.source.receivingHome, index, plan.source.documentId])).rows[0];
    if (!row) work.fail('unavailable', 'Native document preparation lock absent');
  }
  async function writer(tx: CommandTransaction, work: SearchNativeReceivingWork, plan: SearchNativeReceivingPlan) {
    const source = plan.source;
    const row = (await sql<WriterRow>(tx, work, 'writer', [source.receivingHome, index, source.documentId])).rows[0];
    const fence = plan.references.documentFence;
    if (
      !row ||
      row.consumer !== consumer ||
      row.incarnation !== source.incarnation ||
      row.write_alias !== source.writeAlias ||
      row.owner_epoch !== source.receivingEpoch ||
      BigInt(row.enrollment_generation) !== source.enrollmentGeneration ||
      BigInt(row.fence_generation) !== source.fenceGeneration ||
      row.closed_job !== plan.selection.job.jobId ||
      row.closed_epoch !== String(plan.selection.job.epoch) ||
      row.closed_transaction_id !== fence.transactionId ||
      row.closed_position !== String(fence.position) ||
      fence.partition !== source.receivingHome ||
      fence.epoch !== row.owner_epoch ||
      row.closed_token !== source.barrier.token ||
      source.barrier.partition !== source.receivingHome
    )
      work.fail('changed', 'Native writer preparation, original close or physical owner changed');
    return row;
  }
  function nativeCommit(tx: CommandTransaction, work: SearchNativeReceivingWork, purpose = 'search-canonical-index') {
    work.nativeCommit();
    recordIdentityEpochNativeCommit(tx, purpose);
  }
  function late(tx: CommandTransaction, body: () => Promise<void>) {
    registerCommandCallback(tx, () => {
      registerCommandCallback(tx, body);
    });
  }
  async function accepted(
    tx: CommandTransaction,
    work: SearchNativeReceivingWork,
    plan: SearchNativeReceivingPlan,
    hold: HoldRow,
    current: boolean,
    reserved = false,
  ) {
    const args = [
      plan.source.receivingHome,
      plan.selection.job.jobId,
      String(plan.selection.job.epoch),
      plan.selection.effectKey,
      plan.source.original,
      plan.source.owner,
      hold.accepted_transaction_id,
      plan.scopeDigest,
      json(plan.source),
      current,
      plan.source.locator.planId,
    ];
    const rows = reserved
      ? (await tx.query<Component>(acceptedSql.sql, args)).rows
      : (await sql<Component>(tx, work, 'accepted', args)).rows;
    const row = rows[0];
    if (
      !row ||
      row.epoch !== plan.source.receivingEpoch ||
      (!current && (hold.accepted_epoch !== row.epoch || hold.accepted_position !== row.position))
    )
      work.fail('changed', 'Original common Search acceptance is absent or has different native custody');
    return row;
  }
  async function held(
    tx: CommandTransaction,
    work: SearchNativeReceivingWork,
    locator: SearchIdentityReceivingLocator,
    holdId: string,
    allowReleased = false,
  ) {
    const own = await owner(tx, work, locator);
    const plan = await readPlan(tx, work, locator);
    if (own.epoch !== plan.source.receivingEpoch) work.fail('changed', 'Accepted native owner moved');
    const hold = (await sql<HoldRow>(tx, work, 'peekHold', key(locator))).rows[0];
    if (!hold || hold.hold_id !== holdId || (hold.released_transaction_id && !allowReleased))
      work.fail('changed', 'Original native hold is absent or released');
    // Resolve accepted custody before any fresh writer/business eligibility probe.
    await accepted(tx, work, plan, hold, false);
    const writerRow = await writer(tx, work, plan);
    await lockDocument(tx, work, plan);
    const locked = (await sql<HoldRow>(tx, work, 'hold', key(locator))).rows[0];
    if (!same(hold, locked)) work.fail('changed', 'Original accepted hold changed while acquiring its native locks');
    return { plan, hold, own, writerRow };
  }
  function matchesRecord(
    plan: SearchNativeReceivingPlan,
    hold: HoldRow,
    record: SearchIdentityReceivingRecord,
    work: SearchNativeReceivingWork,
  ) {
    if (
      record.step !== 'search-canonical-index' ||
      record.version !== 1 ||
      !same(plan.source, record.source) ||
      !same(plan.selection.job, record.job) ||
      plan.selection.original !== record.original ||
      plan.selection.effectKey !== record.effectKey ||
      plan.selection.owner !== record.owner ||
      plan.scopeDigest !== record.scopeDigest ||
      hold.hold_id !== record.nativeHold.holdId ||
      !same(record.nativeHold.source, record.source) ||
      !same(record.nativeHold.locator, record.source.locator) ||
      !same(record.receipt, record.sourceHold) ||
      record.receipt.partition !== record.source.receivingHome ||
      record.receipt.epoch !== hold.accepted_epoch ||
      String(record.receipt.position) !== hold.accepted_position ||
      record.receipt.transactionId !== hold.accepted_transaction_id
    )
      work.fail('changed', 'Exact original common/native receiving record required');
  }
  async function operation(tx: CommandTransaction, work: SearchNativeReceivingWork, plan: SearchNativeReceivingPlan) {
    const row = (await sql<OperationRow>(tx, work, 'operation', key(plan.source.locator))).rows[0];
    if (
      row &&
      (row.dispatch_epoch !== plan.source.receivingEpoch ||
        (row.state !== 'dispatched' && !row.visibility_component) ||
        (row.state === 'applied' && !row.applied_position))
    )
      work.fail('changed', 'Native operation commit provenance changed');
    return row;
  }
  function appliedArgs(plan: SearchNativeReceivingPlan, current: boolean) {
    return [
      ...key(plan.source.locator),
      plan.selection.job.jobId,
      String(plan.selection.job.epoch),
      plan.selection.effectKey,
      plan.scopeDigest,
      current,
    ];
  }
  function operationValue(plan: SearchNativeReceivingPlan, row: OperationRow): SearchNativeReceivingOperation {
    return {
      operationId: row.operation_id,
      holdId: row.hold_id,
      state: row.state,
      dispatch: {
        partition: plan.source.receivingHome,
        epoch: row.dispatch_epoch,
        position: BigInt(row.dispatch_position),
        transactionId: row.dispatch_transaction_id,
      },
      applied:
        row.applied_transaction_id && row.applied_position
          ? {
              partition: plan.source.receivingHome,
              epoch: row.dispatch_epoch,
              position: BigInt(row.applied_position),
              transactionId: row.applied_transaction_id,
            }
          : null,
      frontier: row.frontier,
    };
  }

  return Object.freeze({
    /** Operational preparation only. Source must independently prove complete admitted support/first absence. */
    preparePlan(
      tx: CommandTransaction,
      input: SearchNativeReceivingPreparation,
      context: SearchIdentityReceivingContext,
    ) {
      return perform(context, tx, true, async (work: SearchNativeReceivingWork) => {
        const locator = input.selection.native;
        const own = await owner(tx, work, locator);
        const source = { ...input.source, plan: own };
        const plan = {
          selection: input.selection,
          source,
          references: input.references,
          scopeDigest: input.scopeDigest,
          actionDigest: input.actionDigest,
          initialCopyCount: input.copies.length,
        };
        if (
          !same(source.locator, locator) ||
          source.receivingHome !== own.partition ||
          source.receivingEpoch !== own.epoch ||
          source.physicalTarget !== index ||
          source.consumer !== consumer ||
          subjectPartition(source.documentId) !== own.partition ||
          source.owner !== source.documentId ||
          source.sourceId !== source.documentId ||
          !same(
            [source.original, source.owner, source.sourceId, source.scope, source.disposition],
            [
              input.selection.original,
              input.selection.owner,
              input.selection.sourceId,
              input.selection.scope,
              input.selection.disposition,
            ],
          ) ||
          !uuid.test(source.original) ||
          !uuid.test(source.terminal) ||
          !uuid.test(source.documentId) ||
          !uuid.test(source.owner) ||
          !uuid.test(input.selection.job.jobId) ||
          input.selection.job.epoch <= 0n ||
          !digest.test(input.scopeDigest) ||
          !digest.test(input.actionDigest) ||
          source.enrollmentGeneration < 0n ||
          source.fenceGeneration < 0n ||
          !Number.isSafeInteger(source.physicalGeneration) ||
          source.physicalGeneration < 1 ||
          !source.incarnation ||
          Buffer.byteLength(source.incarnation) > 128 ||
          !index.endsWith(`-g${source.physicalGeneration}`) ||
          !new RegExp(`^${index}-writer-[a-f0-9]{32}$`).test(source.writeAlias) ||
          Buffer.byteLength(source.writeAlias) > 255 ||
          Buffer.byteLength(json(source)) > 7168 ||
          Buffer.byteLength(json(input.references)) > 7168 ||
          Buffer.byteLength(input.selection.effectKey) < 1 ||
          Buffer.byteLength(input.selection.effectKey) > 256 ||
          input.copies.length > 100 ||
          (source.disposition === 'handoff' && !input.references.predecessor) ||
          (source.disposition === 'OLD' && source.documentId !== source.original) ||
          ((source.disposition === 'NEW' || source.disposition === 'first-apply') &&
            source.documentId !== source.terminal)
        )
          work.fail('changed', 'Invalid immutable native preparation');
        if (
          !validReceipt(source.originalFence, subjectPartition(source.original)) ||
          !validReceipt(input.references.documentFence, own.partition)
        )
          work.fail('changed', 'Invalid native original or document close locator');
        if (input.references.predecessor) {
          validateLocator(input.references.predecessor, work);
          if (same(input.references.predecessor, locator))
            work.fail('changed', 'Native plan cannot be its own predecessor');
        }
        validateCopies(input.copies, source.original, work);
        await writer(tx, work, plan);
        await sql(tx, work, 'document', [own.partition, index, source.documentId]);
        await lockDocument(tx, work, plan);
        const inserted = await sql(tx, work, 'prepare', [
          own.partition,
          locator.planId,
          input.selection.job.jobId,
          String(input.selection.job.epoch),
          source.original,
          source.documentId,
          index,
          input.selection.effectKey,
          input.scopeDigest,
          json(source),
          json(input.references),
          input.actionDigest,
          own.transactionId,
          input.copies.length,
        ]);
        if (!inserted.rowCount) {
          const prior = await readPlan(tx, work, locator);
          const initial = await copies(tx, work, locator, -1, input.copies.length);
          if (
            !same({ ...prior, source: { ...prior.source, plan: own } }, plan) ||
            !same(
              initial.map((item) => copy(item.locator)),
              input.copies,
            )
          )
            work.fail('changed', 'Immutable native plan replay changed');
          return prior;
        }
        work.page('insertCopies', input.copies.length);
        await tx.query(insertCopiesSql.sql, [...key(locator), json(input.copies), 0, own.transactionId]);
        nativeCommit(tx, work);
        return plan;
      });
    },
    /** Append an admitted owner's bounded operational page before acceptance seals the directory. */
    registerOriginalCopies(
      tx: CommandTransaction,
      locator: SearchIdentityReceivingLocator,
      after: number,
      items: readonly SearchNativeReceivingCopy[],
      context: SearchIdentityReceivingContext,
    ) {
      return perform(context, tx, true, async (work: SearchNativeReceivingWork) => {
        const own = await owner(tx, work, locator);
        const plan = await readPlan(tx, work, locator);
        validateCopies(items, plan.source.original, work);
        if (!Number.isInteger(after) || after < -1 || after >= 2147483647)
          work.fail('changed', 'Invalid original copy registration cursor');
        await writer(tx, work, plan);
        await lockDocument(tx, work, plan);
        if ((await sql(tx, work, 'hold', key(locator))).rowCount)
          work.fail('changed', 'Accepted original copy directory is sealed');
        const last = (await sql<{ copy_no: number }>(tx, work, 'copyLast', key(locator))).rows[0]?.copy_no ?? -1;
        if (last !== after) {
          const original = await copies(tx, work, locator, after, items.length);
          if (
            last < after + items.length ||
            !same(
              original.map((row) => copy(row.locator)),
              items,
            )
          )
            work.fail('changed', 'Original copy registration replay changed');
          return { after: after + items.length };
        }
        if (last + items.length >= 2147483647) work.fail('unavailable', 'Original native copy cursor exhausted');
        if (items.length) {
          work.page('insertCopies', items.length);
          await tx.query(insertCopiesSql.sql, [...key(locator), json(items), last + 1, own.transactionId]);
          nativeCommit(tx, work);
        }
        return { after: last + items.length };
      });
    },
    readPlan(locator: SearchIdentityReceivingLocator, context: SearchIdentityReceivingContext) {
      return perform(context, null, false, async (work: SearchNativeReceivingWork) => {
        work.readTransaction();
        return withReadTransaction(pool, (tx) => readPlan(tx, work, locator), work.context.deadline);
      });
    },
    /** One indexed outstanding-custody probe, not a census or a complete Source/publication proof. */
    readDrain(tx: CommandTransaction, context: SearchIdentityReceivingContext) {
      return perform(context, tx, false, async (work: SearchNativeReceivingWork) => {
        const partition = currentCommand(tx).partition;
        const own = (await sql<Component>(tx, work, 'owner', [partition])).rows[0];
        if (!own) work.fail('unavailable', 'Native drain owner unavailable');
        const gate = (
          await sql<{ consumer: string; owner_epoch: number; closed_token: string | null }>(tx, work, 'drainGate', [
            partition,
            index,
          ])
        ).rows[0];
        if (!gate) work.fail('unavailable', 'Native drain generation is unprepared');
        if (gate.consumer !== consumer || gate.owner_epoch !== own.epoch || !gate.closed_token)
          work.fail('changed', 'Native drain requires the exact current closed generation gate');
        const row = (await sql<{ plan_id: string }>(tx, work, 'drain', [partition, index])).rows[0];
        return row
          ? {
              state: 'draining' as const,
              locator: { kind: 'search-canonical-index' as const, version: 1 as const, partition, planId: row.plan_id },
            }
          : { state: 'empty' as const };
      });
    },
    /** Acquisition registers no separate native purpose: Semantic must commit the exact accepted record in this T. */
    readAndHold(
      tx: CommandTransaction,
      locator: SearchIdentityReceivingLocator,
      context: SearchIdentityReceivingContext,
      binding?: import('./identity-receiving-native-contract.ts').SearchIdentityReceivingBinding,
    ) {
      return perform<SearchIdentityReceivingHold>(context, tx, true, async (work: SearchNativeReceivingWork) => {
        const own = await owner(tx, work, locator);
        const plan = await readPlan(tx, work, locator);
        if (
          binding &&
          (binding.scopeDigest !== plan.scopeDigest ||
            !same(binding.source, plan.source) ||
            !same(binding.job, plan.selection.job) ||
            binding.original !== plan.selection.original ||
            binding.effectKey !== plan.selection.effectKey ||
            binding.owner !== plan.selection.owner)
        )
          work.fail('changed', 'Common binding differs from the committed native plan');
        if (own.epoch !== plan.source.receivingEpoch) work.fail('changed', 'Prepared native owner moved');
        const observed = (await sql<HoldRow>(tx, work, 'peekHold', key(locator))).rows[0];
        if (observed) {
          if (observed.released_transaction_id) work.fail('changed', 'Original native hold already released');
          await accepted(tx, work, plan, observed, false);
        }
        await writer(tx, work, plan);
        await lockDocument(tx, work, plan);
        const prior = (await sql<HoldRow>(tx, work, 'hold', key(locator))).rows[0];
        if (prior) {
          if (prior.released_transaction_id) work.fail('changed', 'Original native hold already released');
          if (observed) {
            if (!same(observed, prior)) work.fail('changed', 'Original accepted hold changed under its native lock');
          } else await accepted(tx, work, plan, prior, false);
          return { locator, holdId: prior.hold_id, source: plan.source };
        }
        if (observed) work.fail('changed', 'Original accepted hold disappeared');
        const holdId = Bun.randomUUIDv7();
        const result = await sql(tx, work, 'accept', [...key(locator), holdId, own.transactionId]);
        if (result.rowCount !== 1) work.fail('changed', 'Native hold acquisition lost custody');
        // Charge both deferred probes now, before registering any deferred dispatch.
        work.sql('accepted');
        work.sql('bindAcceptance');
        const hold: HoldRow = {
          hold_id: holdId,
          accepted_transaction_id: own.transactionId,
          accepted_epoch: null,
          accepted_position: null,
          released_transaction_id: null,
        };
        late(tx, async () => {
          const component = await accepted(tx, work, plan, hold, true, true);
          const bound = await tx.query(bindAcceptanceSql.sql, [
            ...key(locator),
            own.transactionId,
            component.epoch,
            component.position,
          ]);
          if (bound.rowCount !== 1) work.fail('changed', 'Native and common acceptance must commit together');
        });
        return { locator, holdId, source: plan.source };
      });
    },
    revalidateHold(
      tx: CommandTransaction,
      locator: SearchIdentityReceivingLocator,
      holdId: string,
      context: SearchIdentityReceivingContext,
      record?: SearchIdentityReceivingRecord,
    ) {
      return perform<SearchIdentityReceivingHold>(context, tx, false, async (work: SearchNativeReceivingWork) => {
        const { plan, hold } = await held(tx, work, locator, holdId, record?.applied !== null && !!record);
        if (record) matchesRecord(plan, hold, record, work);
        return { locator, holdId, source: plan.source };
      });
    },
    /** Called by the sole Source writer inside its existing dispatch transaction, before external engine work. */
    recordDispatch(
      tx: CommandTransaction,
      locator: SearchIdentityReceivingLocator,
      holdId: string,
      operationId: string,
      context: SearchIdentityReceivingContext,
    ) {
      return perform(context, tx, true, async (work: SearchNativeReceivingWork) => {
        const { plan, own, writerRow: row } = await held(tx, work, locator, holdId);
        const previous = await operation(tx, work, plan);
        if (previous) {
          if (previous.operation_id !== operationId || previous.hold_id !== holdId)
            work.fail('changed', 'Original operation changed');
          return operationValue(plan, previous).dispatch;
        }
        if (
          !uuid.test(operationId) ||
          !row.changed_in_command ||
          row.dispatch_state !== 'dispatched' ||
          !row.writer_token ||
          !row.writer_transaction_id ||
          !row.writer_position
        )
          work.fail('draining', 'Genuine native writer dispatch with the prepared action is required');
        const action = (await sql<WriterEvidence>(tx, work, 'action', [own.partition, index, plan.source.documentId]))
          .rows[0];
        if (!action?.value || !action.repair_locator || hash(action.value) !== plan.actionDigest)
          work.fail('changed', 'Actual retained native dispatch action differs from its immutable plan');
        const result = await sql(tx, work, 'dispatch', [
          ...key(locator),
          operationId,
          holdId,
          row.writer_token,
          row.writer_transaction_id,
          row.writer_position,
          own.transactionId,
          action.repair_locator,
        ]);
        if (result.rowCount !== 1) work.fail('changed', 'Native dispatch registration failed');
        nativeCommit(tx, work);
        return own;
      });
    },
    /** Records only the actual writer's retained bulk/recovery receipt, never caller-supplied engine JSON. */
    recordVisible(
      tx: CommandTransaction,
      locator: SearchIdentityReceivingLocator,
      holdId: string,
      operationId: string,
      context: SearchIdentityReceivingContext,
    ) {
      return perform(context, tx, true, async (work: SearchNativeReceivingWork) => {
        const { plan, own, writerRow: row } = await held(tx, work, locator, holdId);
        const op = await operation(tx, work, plan);
        if (!op || op.operation_id !== operationId || op.hold_id !== holdId)
          work.fail('changed', 'Original native dispatch absent');
        if (op.state !== 'dispatched')
          return {
            partition: own.partition,
            epoch: own.epoch,
            position: BigInt(op.visibility_component!),
            transactionId: op.visible_transaction_id!,
          };
        if (
          !row.changed_in_command ||
          row.writer_token ||
          row.dispatch_state !== 'settled' ||
          row.writer_transaction_id !== op.writer_transaction_id ||
          row.writer_position !== op.writer_position ||
          row.settled_transaction_id !== own.transactionId ||
          row.settled_position !== String(own.position) ||
          row.visible_transaction_id !== own.transactionId ||
          row.visible_position !== String(own.position)
        )
          work.fail('draining', 'Original writer dispatch has no genuine same-transaction visibility settlement');
        const evidence = (
          await sql<WriterEvidence>(tx, work, 'receipt', [own.partition, index, plan.source.documentId])
        ).rows[0];
        if (!evidence?.value) work.fail('unavailable', 'Actual retained native settlement receipt unavailable');
        const retained = decodeSearchRepairWriterReceipt(evidence.value);
        validateSearchRepairWriterEvidence(index, retained);
        if (
          retained.locator !== op.writer_locator ||
          evidence.repair_locator !== op.writer_locator ||
          retained.subject !== plan.source.documentId ||
          retained.consumer !== consumer ||
          retained.incarnation !== plan.source.incarnation ||
          retained.writeAlias !== plan.source.writeAlias ||
          retained.epoch !== own.epoch ||
          !same(retained.completion, own) ||
          retained.enrollment.transactionId !== op.writer_transaction_id ||
          String(retained.enrollment.position) !== op.writer_position ||
          hash(nativeJson(retained.action)) !== plan.actionDigest
        )
          work.fail('changed', 'Retained native action, dispatch or completion differs from original operation');
        const result = await sql(tx, work, 'visible', [
          ...key(locator),
          operationId,
          own.transactionId,
          String(own.position),
          hash(evidence.value),
        ]);
        if (result.rowCount !== 1) work.fail('changed', 'Native visibility registration failed');
        nativeCommit(tx, work);
        return own;
      });
    },
    recordApplied(
      tx: CommandTransaction,
      locator: SearchIdentityReceivingLocator,
      holdId: string,
      operationId: string | null,
      frontier: IdentityFrontier,
      context: SearchIdentityReceivingContext,
      record?: SearchIdentityReceivingRecord,
    ) {
      return perform(context, tx, true, async (work: SearchNativeReceivingWork) => {
        const savedFrontier = snapshotSearchIdentityReceivingFrontier(frontier);
        if (!savedFrontier) work.fail('changed', 'Invalid native application frontier');
        const { plan, own, hold } = await held(tx, work, locator, holdId);
        if (record) matchesRecord(plan, hold, record, work);
        // The public adapter uses null: resolve the actual operation on this SAME client/T.
        // The historical store signature remains available to the sole writer's exact replay path.
        const op = await operation(tx, work, plan);
        if (
          !op ||
          (operationId !== null && op.operation_id !== operationId) ||
          op.hold_id !== holdId ||
          op.state === 'dispatched'
        )
          work.fail('draining', 'Original native mutation is not visibly settled');
        if (op.state === 'applied') {
          if (
            !same(op.frontier, savedFrontier) ||
            (await sql(tx, work, 'applied', appliedArgs(plan, false))).rowCount !== 1
          )
            work.fail('changed', 'Original applied frontier/common commit changed');
          return operationValue(plan, op).applied!;
        }
        const result = await sql(tx, work, 'apply', [
          ...key(locator),
          op.operation_id,
          own.transactionId,
          json(savedFrontier),
        ]);
        if (result.rowCount !== 1) work.fail('changed', 'Native application lost its original operation');
        nativeCommit(tx, work);
        work.sql('applied');
        late(tx, async () => {
          if ((await tx.query(appliedSql.sql, appliedArgs(plan, true))).rowCount !== 1)
            work.fail('changed', 'Native operation, common effect and fixed-step frontier must commit in the same T');
        });
        return own;
      });
    },
    readOriginalCopies(
      locator: SearchIdentityReceivingLocator,
      after: number,
      limit: number,
      context: SearchIdentityReceivingContext,
    ) {
      return perform(context, null, false, async (work: SearchNativeReceivingWork) => {
        if (
          !Number.isInteger(after) ||
          after < -1 ||
          after >= 2147483647 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          work.fail('changed', 'Invalid original copy cursor or page size');
        work.readTransaction();
        return withReadTransaction(
          pool,
          async (tx) => {
            await readPlan(tx, work, locator);
            const rows = await copies(tx, work, locator, after, limit);
            return rows.map((row) => ({
              copyNo: row.copy_no,
              locator: copy(row.locator),
              reconciled: !!row.reconciled_transaction_id,
            }));
          },
          work.context.deadline,
        );
      });
    },
    /** Released immutable/accepted/applied custody, also used on settled/released replay. */
    readOriginalState(locator: SearchIdentityReceivingLocator, context: SearchIdentityReceivingContext) {
      return perform(context, null, false, async (work: SearchNativeReceivingWork) => {
        work.readTransaction();
        return withReadTransaction(
          pool,
          async (tx) => {
            const plan = await readPlan(tx, work, locator);
            const hold = (await sql<HoldRow>(tx, work, 'peekHold', key(locator))).rows[0];
            if (!hold) work.fail('draining', 'Original common/native hold is not accepted');
            await accepted(tx, work, plan, hold, false);
            const op = await operation(tx, work, plan);
            if (
              !op ||
              op.state !== 'applied' ||
              (await sql(tx, work, 'applied', appliedArgs(plan, false))).rowCount !== 1
            )
              work.fail('draining', 'Original native/common/fixed-step application is not committed');
            return {
              plan,
              holdId: hold.hold_id,
              accepted: {
                partition: locator.partition,
                epoch: hold.accepted_epoch!,
                position: BigInt(hold.accepted_position!),
                transactionId: hold.accepted_transaction_id,
              },
              operation: operationValue(plan, op),
              pending: !!(await sql(tx, work, 'pending', key(locator))).rowCount,
            };
          },
          work.context.deadline,
        );
      });
    },
    /** Actual structural close at the ORIGINAL home. No current Subject read stands in for this. */
    observeOriginalFence(plan: SearchNativeReceivingPlan, context: SearchIdentityReceivingContext) {
      return perform(context, null, false, async (work: SearchNativeReceivingWork) => {
        work.readTransaction();
        return withReadTransaction(
          pool,
          async (tx) => {
            const source = plan.source;
            const fence = source.originalFence;
            const row = (
              await sql<OwnerCopyRow>(tx, work, 'copyOwner', [fence.partition, source.physicalTarget, source.original])
            ).rows[0];
            if (!row?.close_proven) work.fail('unavailable', 'Original structural close is not committed');
            if (
              row.epoch !== fence.epoch ||
              row.incarnation !== source.incarnation ||
              row.consumer !== source.consumer ||
              row.write_alias !== source.writeAlias ||
              row.closed_job !== plan.selection.job.jobId ||
              row.closed_epoch !== String(plan.selection.job.epoch) ||
              row.closed_transaction_id !== fence.transactionId ||
              row.closed_position !== String(fence.position)
            )
              work.fail('changed', 'Original structural close requires genuine retained owner handoff');
            if (row.writer_token || row.dispatch_state === 'enrolled' || row.dispatch_state === 'dispatched')
              work.fail('draining', 'Original structural close still has uncertain writer custody');
            return fence;
          },
          work.context.deadline,
        );
      });
    },
    /** Receiving home is released before the exact original owner is entered. No engine GET or refresh. */
    observeOriginalCopy(
      locator: SearchIdentityReceivingLocator,
      copyNo: number,
      context: SearchIdentityReceivingContext,
    ) {
      return perform(context, null, false, async (work: SearchNativeReceivingWork) => {
        if (!Number.isInteger(copyNo) || copyNo < 0 || copyNo >= 2147483647)
          work.fail('changed', 'Invalid original copy key');
        work.readTransaction();
        const original = await withReadTransaction(
          pool,
          async (tx) => {
            const plan = await readPlan(tx, work, locator);
            const row = (await sql<CopyRow>(tx, work, 'copy', [...key(locator), copyNo])).rows[0];
            if (!row) work.fail('unavailable', 'Original copy obligation unavailable');
            return { plan, item: copy(row.locator) };
          },
          work.context.deadline,
        );
        work.readTransaction();
        const settlement = await withReadTransaction(
          pool,
          async (tx) => {
            const item = original.item;
            const row = (
              await sql<OwnerCopyRow>(tx, work, 'copyOwner', [item.home, item.physicalTarget, item.original])
            ).rows[0];
            if (!row) work.fail('unavailable', 'Original copy owner unavailable');
            if (!row.close_proven) work.fail('unavailable', 'Original copy close lacks committed native provenance');
            if (
              row.epoch !== item.close.epoch ||
              row.consumer !== item.consumer ||
              row.incarnation !== item.incarnation ||
              row.write_alias !== item.writeAlias ||
              row.closed_job !== original.plan.selection.job.jobId ||
              row.closed_epoch !== String(original.plan.selection.job.epoch) ||
              row.closed_transaction_id !== item.close.transactionId ||
              row.closed_position !== String(item.close.position)
            )
              work.fail('changed', 'Original copy requires actual current-owner handoff');
            // First absence is proven by the genuine native close under writer enrollment locks.
            if (
              !item.enrollment &&
              !item.visible &&
              item.state === 'cancelled' &&
              !row.writer_token &&
              !row.writer_transaction_id &&
              row.dispatch_state === 'cancelled'
            )
              return item.close;
            if (
              row.writer_token ||
              !item.enrollment ||
              row.writer_transaction_id !== item.enrollment.transactionId ||
              row.writer_position !== String(item.enrollment.position) ||
              !row.settled_transaction_id ||
              !row.settled_position ||
              (row.dispatch_state !== 'settled' && row.dispatch_state !== 'cancelled') ||
              ((item.state === 'dispatched' || item.state === 'settled') && row.dispatch_state !== 'settled') ||
              BigInt(row.position) < BigInt(row.settled_position) ||
              (row.dispatch_state === 'settled' &&
                (!row.visible_transaction_id ||
                  !row.visible_position ||
                  row.visible_transaction_id !== row.settled_transaction_id ||
                  row.visible_position !== row.settled_position))
            )
              work.fail('draining', 'Uncertain original copy still requires its actual writer recovery');
            return {
              partition: item.home,
              epoch: row.epoch,
              position: BigInt(row.settled_position),
              transactionId: row.settled_transaction_id,
            };
          },
          work.context.deadline,
        );
        const observation = Object.freeze({ copyNo, settlement: Object.freeze(settlement) });
        copyEvidence.set(observation, { locator: { ...locator }, original: original.item });
        return observation;
      });
    },
    /** Settles the registered directory only. Even an empty directory is not complete Source support. */
    reconcileOriginal(
      tx: CommandTransaction,
      locator: SearchIdentityReceivingLocator,
      observations: readonly SearchNativeReceivingCopyObservation[],
      context: SearchIdentityReceivingContext,
    ) {
      return perform(context, tx, true, async (work: SearchNativeReceivingWork) => {
        const own = await owner(tx, work, locator);
        const plan = await readPlan(tx, work, locator);
        await writer(tx, work, plan);
        await lockDocument(tx, work, plan);
        if (observations.length > 100 || new Set(observations.map((item) => item.copyNo)).size !== observations.length)
          work.fail('changed', 'Native reconciliation page exceeds 100 or repeats a copy');
        let changed = false;
        for (const observation of observations) {
          const evidence = copyEvidence.get(observation);
          if (!evidence || !same(evidence.locator, locator))
            work.fail('changed', 'Genuine released original-owner observation required');
          const row = (await sql<CopyRow>(tx, work, 'copy', [...key(locator), observation.copyNo])).rows[0];
          if (!row || !same(copy(row.locator), evidence.original))
            work.fail('changed', 'Original copy directory changed');
          if (row.reconciled_transaction_id) {
            if (!same(row.settlement, observation.settlement))
              work.fail('changed', 'Original settlement replay changed');
          } else {
            const result = await sql(tx, work, 'reconcile', [
              ...key(locator),
              observation.copyNo,
              own.transactionId,
              json(observation.settlement),
            ]);
            if (result.rowCount !== 1) work.fail('changed', 'Original copy settlement lost custody');
            changed = true;
          }
        }
        if (changed) nativeCommit(tx, work);
        return {
          registeredCopies: (await sql(tx, work, 'pending', key(locator))).rowCount
            ? ('progress' as const)
            : ('complete' as const),
        };
      });
    },
    observeRelease(locator: SearchIdentityReceivingLocator, context: SearchIdentityReceivingContext) {
      return perform(context, null, false, async (work: SearchNativeReceivingWork) => {
        work.readTransaction();
        const local = await withReadTransaction(
          pool,
          async (tx) => {
            const plan = await readPlan(tx, work, locator);
            const row = await operation(tx, work, plan);
            if (
              !row ||
              row.state !== 'applied' ||
              (await sql(tx, work, 'applied', appliedArgs(plan, false))).rowCount !== 1
            )
              work.fail('draining', 'Original native/common application is not committed');
            const hold = (await sql<HoldRow>(tx, work, 'peekHold', key(locator))).rows[0];
            if (!hold) work.fail('changed', 'Original accepted hold absent');
            await accepted(tx, work, plan, hold, false);
            if ((await sql(tx, work, 'pending', key(locator))).rowCount)
              work.fail('draining', 'Original copies prevent release observation');
            return {
              plan,
              applied: operationValue(plan, row).applied!,
              frontier: row.frontier!,
              accepted: {
                partition: locator.partition,
                epoch: hold.accepted_epoch!,
                position: BigInt(hold.accepted_position!),
                transactionId: hold.accepted_transaction_id,
              },
            };
          },
          work.context.deadline,
        );
        work.readTransaction();
        const custody = await withReadTransaction(
          pool,
          async (tx) => {
            const { plan, applied } = local;
            const row = (
              await sql<Component & { transaction_id: string }>(tx, work, 'control', [
                identityJobPartition(plan.selection.job),
                plan.selection.job.jobId,
                String(plan.selection.job.epoch),
                plan.selection.effectKey,
                plan.scopeDigest,
                applied.partition,
                applied.epoch,
                String(applied.position),
                applied.transactionId,
              ])
            ).rows[0];
            if (!row) work.fail('draining', 'Actual original applied control custody required');
            return {
              partition: identityJobPartition(plan.selection.job),
              epoch: row.epoch,
              position: BigInt(row.position),
              transactionId: row.transaction_id,
            };
          },
          work.context.deadline,
        );
        const observation = Object.freeze({ custody: Object.freeze(custody) });
        releaseEvidence.set(observation, {
          consumed: false,
          revoked: false,
          locator: { ...locator },
          applied: local.applied,
          accepted: local.accepted,
          frontier: local.frontier,
          source: local.plan.source,
        });
        return observation;
      });
    },
    /** Private factory lifetime fencing, including an observation already consumed by an
     * in-flight release. Revocation grants no authority and requires no database work.
     */
    revokeRelease(observation: SearchNativeReceivingReleaseObservation) {
      const evidence = releaseEvidence.get(observation);
      if (evidence) evidence.revoked = true;
    },
    releaseHold(
      tx: CommandTransaction,
      locator: SearchIdentityReceivingLocator,
      holdId: string,
      observation: SearchNativeReceivingReleaseObservation,
      context: SearchIdentityReceivingContext,
      record?: SearchIdentityReceivingRecord,
    ) {
      // Consume on entry, including refusal, invalid transaction, exhausted work and thrown SQL.
      const candidate = releaseEvidence.get(observation);
      const evidence = candidate && !candidate.consumed ? candidate : undefined;
      if (candidate) candidate.consumed = true;
      return perform(context, tx, true, async (work: SearchNativeReceivingWork) => {
        if (!evidence || evidence.revoked || !same(evidence.locator, locator))
          work.fail('changed', 'Fresh released control observation required');
        // Another reconciliation or the enclosing invocation's end can supersede this call
        // while it awaits native locks. Fence that race before COMMIT, also on released replay.
        registerCommandCallback(tx, () => {
          if (evidence.revoked) work.fail('changed', 'Native release observation was superseded');
        });
        const own = await owner(tx, work, locator);
        const plan = await readPlan(tx, work, locator);
        const hold = (await sql<HoldRow>(tx, work, 'peekHold', key(locator))).rows[0];
        if (!hold || hold.hold_id !== holdId) work.fail('changed', 'Original native release hold absent');
        if (record) matchesRecord(plan, hold, record, work);
        await accepted(tx, work, plan, hold, false);
        await writer(tx, work, plan);
        await lockDocument(tx, work, plan);
        const locked = (await sql<HoldRow>(tx, work, 'hold', key(locator))).rows[0];
        if (!same(hold, locked)) work.fail('changed', 'Original native hold changed before release');
        const op = await operation(tx, work, plan);
        if (
          !op ||
          op.state !== 'applied' ||
          !same(evidence.source, plan.source) ||
          !same(evidence.accepted, {
            partition: locator.partition,
            epoch: hold.accepted_epoch,
            position: BigInt(hold.accepted_position!),
            transactionId: hold.accepted_transaction_id,
          }) ||
          !same(operationValue(plan, op).applied, evidence.applied) ||
          !same(op.frontier, evidence.frontier) ||
          (record &&
            (!record.applied ||
              !same(record.applied.receipt, evidence.applied) ||
              !same(record.applied.frontier, evidence.frontier))) ||
          (await sql(tx, work, 'applied', appliedArgs(plan, false))).rowCount !== 1
        )
          work.fail('changed', 'Genuine original applied control custody required for release');
        if ((await sql(tx, work, 'pending', key(locator))).rowCount)
          work.fail('draining', 'Original copies still prevent release');
        if (evidence.revoked) work.fail('changed', 'Native release observation was superseded');
        if (hold.released_transaction_id) {
          const row = (
            await sql<Component & { transaction_id: string }>(tx, work, 'releaseProof', [
              ...key(locator),
              holdId,
              false,
            ])
          ).rows[0];
          if (evidence.revoked) work.fail('changed', 'Native release observation was superseded');
          if (!row) work.fail('changed', 'Original native release has no committed provenance');
          return {
            partition: locator.partition,
            epoch: row.epoch,
            position: BigInt(row.position),
            transactionId: row.transaction_id,
          };
        }
        if ((await sql(tx, work, 'release', [...key(locator), holdId, own.transactionId, index])).rowCount !== 1)
          work.fail('changed', 'Native hold release lost custody');
        nativeCommit(tx, work, 'identity-receiving-custody');
        work.sql('releaseProof');
        late(tx, async () => {
          if (evidence.revoked) work.fail('changed', 'Native release observation was superseded');
          if ((await tx.query(releaseProofSql.sql, [...key(locator), holdId, true])).rowCount !== 1)
            work.fail('changed', 'Native release must retain its actual commit');
          if (evidence.revoked) work.fail('changed', 'Native release observation was superseded');
        });
        return own;
      });
    },
  });
}
