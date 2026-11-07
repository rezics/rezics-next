import {
  gateEnsure,
  gateLock,
  inputs,
  runRead,
  stepSave,
  uuid,
  type Run,
  type Gate,
  ownerArgs,
  runArgs,
  unavailable,
  ownerCheck,
  closed,
  validateShelfMaintenanceCursor,
  validateShelfMaintenanceBinding,
  bindingFor,
  live,
  shareShelfAccount,
  saveGate,
  createRun,
  initialize,
} from './shelf-maintenance-owner.ts';
export {
  enterShelfWrite,
  fenceShelfTechnicalWrite,
  validateShelfMaintenanceCursor,
  validateShelfMaintenanceBinding,
} from './shelf-maintenance-owner.ts';
import { memoizedValue } from '../memoized.ts';
import { cleanupShelfTitleKeys } from './shelf-title-maintenance-store.ts';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import canonicalize from 'canonicalize';

import { GrantDeniedError } from '../access/resource-access-errors.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import {
  noEffect,
  normalizeCommandKey,
  principalCommandIdentity,
  runCommand,
  withSingleCommandAttempt,
  type LegacyCommandOptions,
  type PrincipalCommandOptions,
  type CommandResult,
  IdempotencyConflictError,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { CloudEvent } from '../events/log.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { createWorkClient, type WorkClient } from '../work/client.ts';
import type { ShelfTypeKeys, ShelfTypeResolution } from './shelf-contract.ts';
import {
  createShelfTypeKeys,
  shelfTypeDigestFromEnvironment,
  withShelfDerivedTypePreparation,
} from './shelf-type-dictionary.ts';
import { observePreparationSource, observePreparationIdentity } from './preparation-source.ts';
import type { TypePreparationIdentity } from './type-preparation-contract.ts';
import {
  EMPTY_SHELF_GENERATION,
  SHELF_BACKFILL_PHASES,
  SHELF_COUNTER_PHASES,
  SHELF_PURGE_PHASES,
} from './contract/index.ts';
import {
  type ShelfDerivedPage,
  type ShelfMaintenanceBinding,
  type ShelfMaintenanceCursor,
  type ShelfMaintenanceDependencies,
  type ShelfMaintenanceDerivedPorts,
  type ShelfMaintenanceOps,
  type ShelfMaintenancePhase,
  type ShelfMaintenanceReceipt,
  type ShelfMaintenanceTypeObservation,
  type ShelfOwner,
} from './shelf-maintenance-ops-contract.ts';
import { runLibraryCommand } from './library-command-execution.ts';
import { workStepDeadline } from './collection-command-work.ts';
import {
  consumeShelfMaintenance,
  shelfMaintenanceQuery,
  withShelfMaintenanceAllocator,
  shelfMaintenanceEnqueuePlan,
  shelfMaintenanceCommandPlan,
  shelfMaintenanceSourceExecution,
  SHELF_MAINTENANCE_OPERATIONS,
} from './shelf-maintenance-bounds.ts';

import accountShareQuery from '../access/account-share.sql';
import { readMaintenanceSessions } from './maintenance-session-page.ts';
import { readMaintenanceHistoryPage } from './maintenance-history-page.ts';
import erasureProbe from './erasure-probe.sql';
import { libraryErasureWorkflowId } from './erasure-workflow-id.ts';
import scope from './erasure-scope.sql';

import runLockQuery from './shelf-maintenance-run-lock.sql';

import stepReadQuery from './shelf-maintenance-step-read.sql';

import stepBindQuery from './shelf-maintenance-step-bind.sql';
import advanceQuery from './shelf-maintenance-advance.sql';
import cancelQuery from './shelf-maintenance-cancel.sql';
import runnableQuery from './shelf-maintenance-runnable.sql';
import ackQuery from './shelf-maintenance-ack.sql';
import tombstone from './shelf-maintenance-tombstone.sql';

import entriesQuery from './shelf-maintenance-entries.sql';
import entryBackfillQuery from './shelf-maintenance-entry-backfill.sql';
import stampIncarnationQuery from './entry-legacy-incarnation-stamp.sql';
import sessionScratchQuery from './shelf-maintenance-session-scratch.sql';
import sessionsQuery from './shelf-maintenance-sessions.sql';
import headInputsQuery from './shelf-maintenance-head-inputs.sql';
import headsQuery from './shelf-maintenance-heads.sql';
import countEntriesQuery from './shelf-maintenance-count-entries.sql';
import countCollectionsQuery from './shelf-maintenance-count-collections.sql';
import validateQuery from './shelf-maintenance-validate.sql';
import retireCountsQuery from './shelf-maintenance-retire-counts.sql';
import retireReservationsQuery from './shelf-maintenance-retire-reservations.sql';
import scratchSessionsQuery from './shelf-maintenance-scratch-sessions.sql';
import scratchHeadsQuery from './shelf-maintenance-scratch-heads.sql';
import scratchSourcesQuery from './shelf-maintenance-scratch-sources.sql';
import scratchStepsQuery from './shelf-maintenance-scratch-steps.sql';
import sourceReadQuery from './shelf-maintenance-source-read.sql';
import sourceSaveQuery from './shelf-maintenance-source-save.sql';
import sourceProgressQuery from './shelf-maintenance-source-progress.sql';
import sourceAttachQuery from './shelf-maintenance-source-attach.sql';
import sourceResetQuery from './shelf-maintenance-source-reset.sql';
import reservationBindQuery from './shelf-maintenance-reservation-bind.sql';
import reservationCheckQuery from './shelf-maintenance-reservation-check.sql';
import bulkPending from './shelf-maintenance-bulk-pending.sql';

function runLock() {
  return memoizedValue(runLock, () => shelfMaintenanceQuery(runLockQuery));
}

function stepRead() {
  return memoizedValue(stepRead, () => shelfMaintenanceQuery(stepReadQuery));
}

function stepBind() {
  return memoizedValue(stepBind, () => shelfMaintenanceQuery(stepBindQuery));
}
function advance() {
  return memoizedValue(advance, () => shelfMaintenanceQuery(advanceQuery));
}
function cancel() {
  return memoizedValue(cancel, () => shelfMaintenanceQuery(cancelQuery));
}
function runnable() {
  return memoizedValue(runnable, () => shelfMaintenanceQuery(runnableQuery));
}
function ack() {
  return memoizedValue(ack, () => shelfMaintenanceQuery(ackQuery));
}

function entries() {
  return memoizedValue(entries, () => shelfMaintenanceQuery(entriesQuery));
}
function entryBackfill() {
  return memoizedValue(entryBackfill, () => shelfMaintenanceQuery(entryBackfillQuery));
}
function stampIncarnation() {
  return memoizedValue(stampIncarnation, () => shelfMaintenanceQuery(stampIncarnationQuery));
}
function sessionScratch() {
  return memoizedValue(sessionScratch, () => shelfMaintenanceQuery(sessionScratchQuery));
}
function sessions() {
  return memoizedValue(sessions, () => shelfMaintenanceQuery(sessionsQuery));
}
function headInputs() {
  return memoizedValue(headInputs, () => shelfMaintenanceQuery(headInputsQuery));
}
function heads() {
  return memoizedValue(heads, () => shelfMaintenanceQuery(headsQuery));
}
function countEntries() {
  return memoizedValue(countEntries, () => shelfMaintenanceQuery(countEntriesQuery));
}
function countCollections() {
  return memoizedValue(countCollections, () => shelfMaintenanceQuery(countCollectionsQuery));
}
function validate() {
  return memoizedValue(validate, () => shelfMaintenanceQuery(validateQuery));
}
function retireCounts() {
  return memoizedValue(retireCounts, () => shelfMaintenanceQuery(retireCountsQuery));
}
function retireReservations() {
  return memoizedValue(retireReservations, () => shelfMaintenanceQuery(retireReservationsQuery));
}
function scratchSessions() {
  return memoizedValue(scratchSessions, () => shelfMaintenanceQuery(scratchSessionsQuery));
}
function scratchHeads() {
  return memoizedValue(scratchHeads, () => shelfMaintenanceQuery(scratchHeadsQuery));
}
function scratchSources() {
  return memoizedValue(scratchSources, () => shelfMaintenanceQuery(scratchSourcesQuery));
}
function scratchSteps() {
  return memoizedValue(scratchSteps, () => shelfMaintenanceQuery(scratchStepsQuery));
}
function sourceRead() {
  return memoizedValue(sourceRead, () => shelfMaintenanceQuery(sourceReadQuery));
}
function sourceSave() {
  return memoizedValue(sourceSave, () => shelfMaintenanceQuery(sourceSaveQuery));
}
function sourceProgress() {
  return memoizedValue(sourceProgress, () => shelfMaintenanceQuery(sourceProgressQuery));
}
function sourceAttach() {
  return memoizedValue(sourceAttach, () => shelfMaintenanceQuery(sourceAttachQuery));
}
function sourceReset() {
  return memoizedValue(sourceReset, () => shelfMaintenanceQuery(sourceResetQuery));
}
function reservationBind() {
  return memoizedValue(reservationBind, () => shelfMaintenanceQuery(reservationBindQuery));
}
function reservationCheck() {
  return memoizedValue(reservationCheck, () => shelfMaintenanceQuery(reservationCheckQuery));
}
function accountShare() {
  return memoizedValue(accountShare, () => shelfMaintenanceQuery(accountShareQuery));
}

const pageDeadlines = new AsyncLocalStorage<number>();

export const SHELF_MAINTENANCE_WORKFLOW = 'library.shelfMaintenance';
export const SHELF_MAINTENANCE_EVENT = 'com.rezics.library.shelf-maintenance.advanced.v1';

type Step = NonNullable<Awaited<ReturnType<ReturnType<typeof stepRead>['run']>>>;
type SourceRow = NonNullable<Awaited<ReturnType<ReturnType<typeof sourceRead>['run']>>>;

function cursorOf(step: { cursor: unknown }): ShelfMaintenanceCursor {
  const cursor = step.cursor as ShelfMaintenanceCursor;
  validateShelfMaintenanceCursor(cursor);
  return cursor;
}
const digest = (input: unknown) => {
  const encoded = canonicalize(input);
  if (typeof encoded !== 'string') throw new TypeError('Shelf receipt input must be canonical JSON');
  return createHash('sha256').update(encoded).digest();
};
const event = (owner: ShelfOwner) => ({
  type: SHELF_MAINTENANCE_EVENT,
  subject: owner.accountId,
  data: { accountId: owner.accountId },
});

type DerivedAuthority = {
  tx: CommandTransaction;
  owner: ShelfOwner;
  run: Run;
  gate: Gate;
  keys: ShelfTypeKeys | undefined;
  source: ShelfMaintenanceTypeObservation | null;
  fresh: boolean;
};
const derivedPages = new WeakMap<ShelfDerivedPage, DerivedAuthority>();
async function derivedAuthority(tx: CommandTransaction, page: ShelfDerivedPage) {
  const proof = derivedPages.get(page);
  if (!proof || proof.tx !== tx || !proof.fresh) throw new TypeError('No live native shelf derived page');
  live(tx, proof.owner);
  const gate = await gateLock().run(tx, ownerArgs(proof.owner));
  const run = await runLock().run(tx, runArgs(proof.owner, proof.run.runId));
  if (
    !gate ||
    !run ||
    run.cancelled ||
    gate.mode !== 'rebuilding' ||
    gate.runId !== run.runId ||
    BigInt(gate.epoch) !== BigInt(run.epoch) ||
    BigInt(run.epoch) !== page.epoch ||
    run.buildGeneration !== page.generationId ||
    run.phase !== 'types' ||
    BigInt(run.sequence) !== BigInt(proof.run.sequence)
  )
    unavailable(proof.owner);
  await shareShelfAccount(tx, proof.owner.accountId);
  if (!proof.keys) unavailable(proof.owner);
  return { ...proof, keys: proof.keys };
}
/** Allocator integration reads actual same-tx/run/build authority; this never mints a page. */
export async function readShelfDerivedAllocation(tx: CommandTransaction, page: ShelfDerivedPage) {
  const proof = await derivedAuthority(tx, page);
  return {
    owner: proof.owner,
    runId: proof.run.runId,
    epoch: BigInt(proof.run.epoch),
    generationId: proof.run.buildGeneration!,
  };
}
/** No public mint operation. Copied/serialized branded objects cannot reach the allocator. */
export function createShelfMaintenanceDerivedPorts(): ShelfMaintenanceDerivedPorts {
  return {
    async reserve(tx, page, source) {
      const proof = await derivedAuthority(tx, page);
      if (proof.source !== source) throw new TypeError('Shelf source is not bound to this live page');
      const result = await withShelfDerivedTypePreparation(
        tx,
        page,
        null,
        () =>
          withShelfMaintenanceAllocator(tx, source.fullType, () =>
            proof.keys.reserve({ client: tx, ...proof.owner }, source.fullType),
          ),
        readShelfDerivedAllocation,
      );
      if (!result.done) {
        const rows = await reservationBind().run(tx, {
          ...runArgs(proof.owner, page.runId),
          reservation_id: result.reservation.reservationId,
          generation: page.generationId,
        });
        if (!rows) throw new Error('Allocator reservation did not bind the native shelf run');
      }
      return result;
    },
    async continue(tx, page, reservationId) {
      const proof = await derivedAuthority(tx, page);
      const saved = proof.source
        ? await sourceRead().run(tx, { ...runArgs(proof.owner, page.runId), subject_id: proof.source.subjectId })
        : null;
      if (
        !saved ||
        saved.reservationId !== reservationId ||
        !(await reservationCheck().run(tx, {
          ...runArgs(proof.owner, page.runId),
          reservation_id: reservationId,
          generation: page.generationId,
        }))
      )
        throw new TypeError('Reservation is not bound to this live shelf page');
      return withShelfDerivedTypePreparation(
        tx,
        page,
        reservationId,
        () =>
          withShelfMaintenanceAllocator(tx, undefined, () =>
            proof.keys.continue({ client: tx, ...proof.owner }, { reservationId }),
          ),
        readShelfDerivedAllocation,
      );
    },
  };
}
function sameIdentity(a: TypePreparationIdentity, b: TypePreparationIdentity | null): boolean {
  return (
    !!b &&
    a.sourceId === b.sourceId &&
    a.partition === b.partition &&
    a.epoch === b.epoch &&
    a.revision === b.revision &&
    a.transactionId === b.transactionId &&
    a.redirect === b.redirect
  );
}
function sourceObservation(row: SourceRow): ShelfMaintenanceTypeObservation {
  return {
    subjectId: row.subjectId,
    incarnationId: row.incarnationId,
    transactionId: row.transactionId,
    sourceId: row.sourceId,
    stamp: { partition: row.sourcePartition, epoch: row.sourceEpoch, position: BigInt(row.sourcePosition) },
    identity: row.identity as unknown as TypePreparationIdentity,
    originIdentity: row.originIdentity as unknown as TypePreparationIdentity,
    fullType: '',
  };
}
async function prepareType(deps: ShelfMaintenanceDependencies, owner: ShelfOwner, step: Step, runId: string) {
  const after = cursorOf(step)[0];
  const candidate = await withConnection(deps.pool, async (client) => {
    const entry = await entries().run(client, {
      ...ownerArgs(owner),
      after: typeof after === 'string' ? after : EMPTY_SHELF_GENERATION,
    });
    const saved = entry
      ? await sourceRead().run(client, { ...runArgs(owner, runId), subject_id: entry.subjectId })
      : null;
    return { entry, saved };
  });
  if (!candidate.entry) return null;
  if (!deps.sources || !deps.derivedKeys || !candidate.entry.incarnationId) unavailable(owner);
  let source: ShelfMaintenanceTypeObservation;
  if (candidate.saved) source = sourceObservation(candidate.saved);
  else {
    const origin = await deps.sources.observe(candidate.entry.subjectId);
    if (
      !origin.identity ||
      origin.identity.sourceId !== candidate.entry.subjectId ||
      origin.identity.partition !== origin.stamp.partition ||
      origin.identity.epoch !== origin.stamp.epoch
    )
      unavailable(owner);
    const sourceId = origin.identity.redirect ?? candidate.entry.subjectId;
    const resolved = sourceId === candidate.entry.subjectId ? origin : await deps.sources.observe(sourceId);
    if (
      !resolved.identity ||
      resolved.identity.sourceId !== sourceId ||
      resolved.identity.partition !== resolved.stamp.partition ||
      resolved.identity.epoch !== resolved.stamp.epoch ||
      resolved.identity.redirect !== null ||
      resolved.type === null
    )
      unavailable(owner);
    source = {
      subjectId: candidate.entry.subjectId,
      incarnationId: candidate.entry.incarnationId,
      transactionId: candidate.entry.transactionId,
      sourceId,
      stamp: resolved.stamp,
      identity: resolved.identity,
      originIdentity: origin.identity,
      fullType: resolved.type,
    };
  }
  return { source, saved: candidate.saved, refresh: await changedSource(deps, owner, source) };
}
async function changedSource(
  deps: ShelfMaintenanceDependencies,
  owner: ShelfOwner,
  source: ShelfMaintenanceTypeObservation,
) {
  if (!deps.sources) unavailable(owner);
  // Fresh metadata-only observations are released before entering the account command.
  const origin = await deps.sources.observeIdentity(source.subjectId);
  const current = source.sourceId === source.subjectId ? origin : await deps.sources.observeIdentity(source.sourceId);
  if (!origin.identity || !current.identity) unavailable(owner);
  return (
    origin.stamp.partition !== source.originIdentity.partition ||
    origin.stamp.epoch !== source.originIdentity.epoch ||
    !sameIdentity(source.originIdentity, origin.identity) ||
    !sameIdentity(source.identity, current.identity) ||
    current.stamp.epoch !== source.stamp.epoch ||
    current.stamp.partition !== source.stamp.partition
  );
}
function inputIdentity(input: Awaited<ReturnType<typeof prepareType>> | undefined) {
  if (!input) return null;
  const source = input.source;
  return {
    subjectId: source.subjectId,
    incarnationId: source.incarnationId,
    transactionId: source.transactionId,
    sourceId: source.sourceId,
    stamp: { ...source.stamp, position: source.stamp.position.toString() },
    identity: source.identity,
    originIdentity: source.originIdentity,
    refresh: input.refresh,
  };
}

/** The existing Library erasure participant is the sole deletion engine. These
 * checkpoints attest only its actual indexed shelf-domain exhaustion; they never
 * ACK public/shared obligations or dispose of them on a lease or timer. */
async function purgePage(
  tx: CommandTransaction,
  owner: ShelfOwner,
  run: Run,
  cursor: ShelfMaintenanceCursor,
): Promise<{ complete: boolean; cursor: ShelfMaintenanceCursor }> {
  if (run.phase === 'cancel-work') {
    if ((await cleanupShelfTitleKeys(tx, owner)) === 100) return { complete: false, cursor: [] };
    await tx.query('DELETE FROM library.shelf_title_head WHERE route=$1 AND account_id=$2::uuid', [
      owner.route,
      owner.accountId,
    ]);
    return { complete: true, cursor: [] };
  }
  if (run.phase === 'bulk-evidence') {
    if (await bulkPending.run(tx, ownerArgs(owner))) unavailable(owner);
    const sub = typeof cursor[0] === 'number' ? cursor[0] : 0;
    const removed =
      sub < 3
        ? await [scratchSessions(), scratchHeads(), scratchSources()][sub]!.run(tx, ownerArgs(owner))
        : await scratchSteps().run(tx, { ...runArgs(owner, run.runId), before: sub === 3 });
    return { complete: sub === 4 && removed.length < 100, cursor: [sub + (removed.length < 100 ? 1 : 0)] };
  }
  const stores: Partial<Record<ShelfMaintenancePhase, readonly string[]>> = {
    reservations: ['shelf_type_reservation'],
    'type-sources': ['type_preparation_slot', 'type_preparation_progress', 'type_preparation_header'],
    'progress-changes': ['progress_session'],
    'progress-units': ['progress_session'],
    sessions: ['progress_session'],
    heads: ['progress_head'],
    copies: ['copy'],
    entries: ['entry', 'entry_deleted'],
    follows: ['follow'],
    'collection-members': ['collection'],
    collections: ['collection'],
    'published-logs': ['published_log'],
    counts: ['shelf_count'],
    'type-nodes': ['shelf_type_node'],
    'type-roots': ['shelf_type_root'],
    'type-values': ['shelf_type_value'],
  };
  const required = stores[run.phase as ShelfMaintenancePhase];
  if (!required) throw new Error('Invalid native shelf purge phase');
  const remaining = await erasureProbe.run(tx, ownerArgs(owner));
  if (remaining.some((row) => row.store !== null && required.includes(row.store))) unavailable(owner);
  return { complete: true, cursor: [] };
}

export function createShelfMaintenanceOps(dependencies: ShelfMaintenanceDependencies): ShelfMaintenanceOps {
  const deps: ShelfMaintenanceDependencies = {
    ...dependencies,
    derivedKeys:
      dependencies.derivedKeys ??
      createShelfTypeKeys(
        dependencies.shelfTypeDigest === undefined ? undefined : { digest: dependencies.shelfTypeDigest },
      ),
    sources: dependencies.sources ?? {
      observe: (id) =>
        observePreparationSource(
          { ...dependencies, deadline: pageDeadlines.getStore(), execution: shelfMaintenanceSourceExecution },
          id,
        ),
      observeIdentity: (id) =>
        observePreparationIdentity(
          { ...dependencies, deadline: pageDeadlines.getStore(), execution: shelfMaintenanceSourceExecution },
          id,
        ),
    },
  };
  const { pool, clock, access } = deps;
  let work: Promise<WorkClient> | undefined;
  const workClient = () =>
    typeof deps.client === 'function'
      ? deps.client()
      : deps.client
        ? Promise.resolve(deps.client)
        : (work ??= createWorkClient(pool.options.connectionString ?? '', pool));
  const ports = createShelfMaintenanceDerivedPorts();
  function command<T>(
    options: LegacyCommandOptions | PrincipalCommandOptions,
    body: (
      tx: CommandTransaction,
      context: { transactionId: string; time: import('../command/command.ts').AuthoritativeTime },
    ) => Promise<CommandResult<T>>,
    policy: 'rebuild' | 'purge' = 'rebuild',
  ) {
    const dispatch = () => ('principal' in options ? runCommand(pool, options, body) : runCommand(pool, options, body));
    // Erasure retains its own command retry policy and cost owner.
    if (policy === 'purge') return dispatch();
    const declaration = shelfMaintenanceCommandPlan(pool, options);
    return runLibraryCommand(
      () => withSingleCommandAttempt(dispatch),
      (run) => consumeShelfMaintenance('command', declaration.total, run),
    );
  }
  async function requestRebuild(
    actor: Parameters<ShelfMaintenanceOps['requestRebuild']>[0],
    input: Parameters<ShelfMaintenanceOps['requestRebuild']>[1],
  ) {
    closed(input, ['owner', 'kind', 'requestKey']);
    ownerCheck(input.owner);
    if (input.kind !== 'backfill' && input.kind !== 'counters') throw new TypeError('Invalid shelf rebuild kind');
    // The receipt and the body must describe the same request across authorization
    // awaits. Retain values, rather than the caller's mutable request container.
    const owner = Object.freeze({ ...input.owner });
    const request = Object.freeze({ owner, kind: input.kind, requestKey: input.requestKey });
    const deadline = workStepDeadline();
    const identity = principalCommandIdentity(actor);
    const resource = { route: owner.route, id: owner.accountId };
    const authorization = resourceAuthorization({
      access,
      actor,
      action: 'account:manage',
      anchor: {
        resource,
        async validate(tx) {
          // Access preparation supplies its released native client, before Core owns a transaction.
          const account = await accountShare().run(tx, ownerArgs(owner));
          return account?.state === 'active' && !account.fenced;
        },
      },
      context: { pool, deadline, partition: partitionOf(owner.route) },
    });
    const result = await command(
      {
        ...identity,
        partition: partitionOf(owner.route),
        deadline,
        clock,
        receipt: { kind: 'library.shelf-maintenance.request', key: request.requestKey, digest: digest(request) },
        authorization,
      },
      async (tx) => {
        await initialize(tx, owner);
        const gate = await gateLock().run(tx, ownerArgs(owner));
        if (!gate || (gate.mode !== 'open' && gate.mode !== 'rebuilding')) unavailable(owner);
        if (gate.runId) {
          const current = await runLock().run(tx, runArgs(owner, gate.runId));
          if (current && current.phase !== 'complete' && !current.cancelled) {
            if (current.phase === 'retire-counts' || current.phase === 'retire-reservations') unavailable(owner);
            if (current.kind !== request.kind) unavailable(owner);
            return noEffect(bindingFor(owner, current));
          }
        }
        if (request.kind === 'counters' && !gate.ready) unavailable(owner);
        const requested = await createRun(tx, owner, gate, request.kind);
        return { value: requested, events: [event(owner)] };
      },
    );
    return result.value;
  }
  async function requestPurge(envelope: CloudEvent) {
    const data = envelope.data as { accountId?: string };
    const match = /^urn:rezics:log:([0-9]+)\.([1-9][0-9]*)$/.exec(envelope.source);
    if (
      !data ||
      typeof data.accountId !== 'string' ||
      envelope.type !== 'com.rezics.access.account-tombstoned.v1' ||
      envelope.subject !== data.accountId ||
      !match ||
      !/^[0-9]{19}$/.test(envelope.sequence) ||
      !uuid.test(envelope.id) ||
      envelope.specversion !== '1.0' ||
      envelope.datacontenttype !== 'application/json'
    )
      throw new TypeError('Invalid shelf purge tombstone envelope');
    const owner = { route: routeOf(data.accountId)!, accountId: data.accountId };
    ownerCheck(owner);
    if (Number(match[1]) !== partitionOf(owner.route)) throw new TypeError('Foreign shelf purge envelope');
    const result = await command(
      {
        partition: partitionOf(owner.route),
        deadline: workStepDeadline(),
        clock,
        receipt: {
          actorAccountId: owner.accountId,
          kind: 'library.shelf-maintenance.purge',
          key: normalizeCommandKey({ kind: 'account', id: owner.accountId }, envelope.id),
          digest: digest(envelope),
        },
        authorization: {
          action: 'library:shelf-purge',
          resource: { route: owner.route, id: owner.accountId },
          denied: () => new GrantDeniedError(),
          async authorize(tx) {
            if (
              !(await tombstone.run(tx, {
                ...ownerArgs(owner),
                partition: partitionOf(owner.route),
                position: BigInt(envelope.sequence),
                event_id: envelope.id,
                event_epoch: Number(match[2]),
                data: envelope.data as never,
                time: envelope.time,
              }))
            )
              throw new GrantDeniedError();
            return 'execute';
          },
        },
      },
      async (tx) => {
        live(tx, owner);
        await gateEnsure().run(tx, ownerArgs(owner));
        const gate = await gateLock().run(tx, ownerArgs(owner));
        if (!gate) throw new Error('Missing terminal shelf gate');
        if (gate.runId && (gate.mode === 'purging' || gate.mode === 'purged')) {
          const current = await runRead().run(tx, runArgs(owner, gate.runId));
          if (!current) throw new Error('Missing terminal shelf run');
          return noEffect(bindingFor(owner, current));
        }
        if (gate.runId) await cancel().run(tx, runArgs(owner, gate.runId));
        gate.mode = 'purging';
        gate.ready = false;
        gate.activeGeneration = null;
        gate.epoch = BigInt(gate.epoch) + 1n;
        const requested = await createRun(tx, owner, gate, 'purge');
        return { value: requested, events: [event(owner)] };
      },
      'purge',
    );
    return result.value;
  }
  async function executePage(
    binding: ShelfMaintenanceBinding,
    retry: number,
    deadline: number,
  ): Promise<ShelfMaintenanceReceipt> {
    const owner = { route: binding.route, accountId: binding.accountId };
    const args = { ...runArgs(owner, binding.runId), epoch: BigInt(binding.epoch), sequence: BigInt(binding.sequence) };
    const { header, scheduledRun } = await withConnection(pool, async (client) => {
      const header = await stepRead().run(client, args);
      return { header, scheduledRun: header ? await runRead().run(client, runArgs(owner, binding.runId)) : null };
    });
    if (!header) throw new TypeError('Unknown native shelf maintenance step');
    const cursor = cursorOf(header);
    let admitted: { gate: Gate; run: Run } | undefined;
    // Capture the initial bounded input before Core hashes its immutable receipt.
    // On replay the applied header supplies that exact commitment without a source read.
    let typeInput: Awaited<ReturnType<typeof prepareType>> | undefined;
    if (header.inputIdentity === null && (header.phase === 'types' || header.phase === 'validate')) {
      if (
        scheduledRun &&
        !scheduledRun.cancelled &&
        BigInt(scheduledRun.epoch) === args.epoch &&
        BigInt(scheduledRun.sequence) === args.sequence &&
        (header.phase === 'types' || scheduledRun.kind === 'backfill')
      )
        typeInput = await prepareType(deps, owner, header, binding.runId);
    }
    const { inputIdentity: committedInput, ...fixedHeader } = header;
    const commitment = committedInput ?? inputIdentity(typeInput);
    const receiptKey = normalizeCommandKey(
      { kind: 'account', id: owner.accountId },
      `shelf:${binding.runId}:${binding.epoch}:${binding.sequence}`,
    );
    try {
      const outcome = await command<ShelfMaintenanceReceipt>(
        {
          partition: partitionOf(owner.route),
          deadline,
          clock,
          receipt: {
            actorAccountId: owner.accountId,
            kind: 'library.shelf-maintenance.page',
            key: receiptKey,
            digest: digest([binding, fixedHeader, commitment]),
          },
          authorization: {
            action: 'library:shelf-page',
            resource: { route: owner.route, id: owner.accountId },
            denied: () => new GrantDeniedError(),
            async prepare() {
              // An already advanced step must reach Core replay without a fresh source dependency.
              const current = await withConnection(pool, (c) => runRead().run(c, runArgs(owner, binding.runId)));
              if (
                current &&
                !current.cancelled &&
                BigInt(current.epoch) === args.epoch &&
                BigInt(current.sequence) === args.sequence &&
                typeInput &&
                (await changedSource(deps, owner, typeInput.source)) !== typeInput.refresh
              )
                unavailable(owner);
            },
            async authorize(tx) {
              const current = await runRead().run(tx, runArgs(owner, binding.runId));
              if (!current) throw new GrantDeniedError();
              if (current.kind === 'purge') {
                if (!(await scope.run(tx, ownerArgs(owner)))) throw new GrantDeniedError();
              } else await shareShelfAccount(tx, owner.accountId);
              const gate = await gateLock().run(tx, ownerArgs(owner));
              const run = await runLock().run(tx, runArgs(owner, binding.runId));
              if (
                !gate ||
                !run ||
                gate.runId !== binding.runId ||
                run.cancelled ||
                (run.kind === 'purge'
                  ? gate.mode !== 'purging' && gate.mode !== 'purged'
                  : gate.mode !== 'open' && gate.mode !== 'rebuilding')
              )
                throw new GrantDeniedError();
              admitted = { gate, run };
              return 'execute';
            },
          },
        },
        async (tx, command) => {
          live(tx, owner);
          if (!admitted) throw new Error('Missing native shelf admission');
          const { gate, run } = admitted;
          if (
            BigInt(run.epoch) !== args.epoch ||
            BigInt(run.sequence) !== args.sequence ||
            run.segment !== binding.segment ||
            run.phase !== header.phase ||
            JSON.stringify(run.cursor) !== JSON.stringify(header.cursor) ||
            run.buildGeneration !== header.buildGeneration
          )
            unavailable(owner);
          if (header.inputIdentity === null && !(await stepBind().run(tx, { ...args, identity: commitment as never })))
            unavailable(owner);
          let phase = run.phase as ShelfMaintenancePhase;
          let nextCursor: ShelfMaintenanceCursor = cursor;
          let complete = false;
          const after = typeof cursor[0] === 'string' ? cursor[0] : EMPTY_SHELF_GENERATION;
          const build = run.buildGeneration;
          const query = { ...runArgs(owner, binding.runId), after };
          if (run.kind === 'purge') {
            const result = await purgePage(tx, owner, run, cursor);
            complete = result.complete;
            nextCursor = result.cursor;
          } else if (phase === 'drain') {
            if (
              gate.mode !== 'open' ||
              BigInt(gate.epoch) !== BigInt(run.epoch) ||
              (run.kind === 'counters' && !gate.ready)
            )
              unavailable(owner);
            gate.mode = 'rebuilding';
            gate.epoch = BigInt(gate.epoch) + 1n;
            if (run.kind === 'backfill') gate.ready = false;
            run.epoch = gate.epoch;
            run.buildGeneration = newId(owner.route);
            await saveGate(tx, owner, gate);
            complete = true;
          } else {
            const cleanup = phase === 'retire-counts' || phase === 'retire-reservations';
            if (!build || BigInt(gate.epoch) !== BigInt(run.epoch) || gate.mode !== (cleanup ? 'open' : 'rebuilding'))
              unavailable(owner);
            if (phase === 'session-changes') {
              const parent = typeof cursor[1] === 'string' ? cursor[1] : null;
              const ordinal = typeof cursor[2] === 'number' ? cursor[2] : 0;
              if (!parent) {
                const page = await readMaintenanceSessions(tx, {
                  ...owner,
                  after: typeof cursor[0] === 'string' ? cursor[0] : null,
                  limit: 1,
                });
                if (page.sessions.length === 0) complete = true;
                else nextCursor = [typeof cursor[0] === 'string' ? cursor[0] : null, page.sessions[0]!.sessionId, 0];
              } else {
                const history = await readMaintenanceHistoryPage(tx, { ...owner, sessionId: parent, after: ordinal });
                if (!history) throw new Error('Fenced shelf history parent disappeared');
                await sessionScratch().run(tx, {
                  ...runArgs(owner, binding.runId),
                  session_id: parent,
                  time: history.lastChangedAt,
                });
                nextCursor = history.complete ? [parent, null, 0] : [cursor[0] ?? null, parent, history.after];
              }
            } else if (phase === 'sessions' || phase === 'head-inputs' || phase === 'heads') {
              const rows = await { sessions: sessions(), 'head-inputs': headInputs(), heads: heads() }[phase].run(
                tx,
                query,
              );
              const last = rows
                .map((r) => r.id)
                .sort()
                .at(-1);
              complete = rows.length < 100;
              nextCursor = last ? [last] : cursor;
            } else if (phase === 'entries') {
              const rows = await entryBackfill().run(tx, { ...ownerArgs(owner), after });
              for (const row of rows)
                if (row.incarnationId === null) {
                  const stamped = await stampIncarnation().run(tx, {
                    ...ownerArgs(owner),
                    subject_id: row.subjectId,
                    revision: row.revision,
                    transaction_id: row.transactionId,
                    incarnation_id: newId(owner.route),
                  });
                  if (!stamped) unavailable(owner);
                }
              const last = rows
                .map((row) => row.subjectId)
                .sort()
                .at(-1);
              complete = rows.length < 100;
              nextCursor = last ? [last] : cursor;
            } else if (phase === 'types') {
              if (typeInput === undefined) unavailable(owner);
              if (typeInput === null) complete = true;
              else {
                const source = typeInput.source;
                const current = await entries().run(tx, { ...ownerArgs(owner), after });
                if (
                  !current ||
                  current.subjectId !== source.subjectId ||
                  current.incarnationId !== source.incarnationId ||
                  current.transactionId !== source.transactionId
                )
                  unavailable(owner);
                if (typeInput.refresh) {
                  await sourceReset().run(tx, { ...runArgs(owner, run.runId), subject_id: source.subjectId });
                } else {
                  const capability = Object.freeze({
                    owner,
                    runId: run.runId,
                    epoch: BigInt(run.epoch),
                    generationId: build,
                  }) as ShelfDerivedPage;
                  derivedPages.set(capability, { tx, owner, run, gate, keys: deps.derivedKeys, source, fresh: true });
                  try {
                    let result: ShelfTypeResolution;
                    if (typeInput.saved?.typeId) result = { done: true, typeId: typeInput.saved.typeId };
                    else if (typeInput.saved?.reservationId)
                      result = await ports.continue(tx, capability, typeInput.saved.reservationId);
                    else result = await ports.reserve(tx, capability, source);
                    const saved = {
                      ...runArgs(owner, run.runId),
                      subject_id: source.subjectId,
                      reservation_id: result.done ? null : result.reservation.reservationId,
                      type_id: result.done ? result.typeId : null,
                    };
                    if (typeInput.saved) await sourceProgress().run(tx, saved);
                    else
                      await sourceSave().run(tx, {
                        ...saved,
                        incarnation_id: source.incarnationId,
                        transaction_id: source.transactionId,
                        source_id: source.sourceId,
                        source_partition: source.stamp.partition,
                        source_epoch: source.stamp.epoch,
                        source_position: source.stamp.position,
                        identity: source.identity as never,
                        origin_identity: source.originIdentity as never,
                      });
                    if (result.done) {
                      const attached = await sourceAttach().run(tx, {
                        ...ownerArgs(owner),
                        subject_id: source.subjectId,
                        incarnation_id: source.incarnationId,
                        transaction_id: source.transactionId,
                        type_id: result.typeId,
                        source_id: source.sourceId,
                        source_partition: source.stamp.partition,
                        source_epoch: source.stamp.epoch,
                        source_position: source.stamp.position,
                      });
                      if (!attached) unavailable(owner);
                      nextCursor = [source.subjectId];
                    }
                  } finally {
                    derivedPages.delete(capability);
                  }
                }
              }
            } else if (phase === 'count-entries' || phase === 'count-collections') {
              const rows = await (phase === 'count-entries' ? countEntries() : countCollections()).run(tx, {
                ...ownerArgs(owner),
                after,
                generation: build,
              });
              complete = rows.length < 100;
              nextCursor = rows.at(-1) ? [rows.at(-1)!.id] : cursor;
            } else if (phase === 'validate') {
              const row = await validate().run(tx, { ...ownerArgs(owner), after });
              if (run.kind === 'backfill') {
                if (typeInput === undefined) unavailable(owner);
                if (typeInput === null) {
                  if (row !== null) unavailable(owner);
                  complete = true;
                } else {
                  if (!row || row.id !== typeInput.source.subjectId) unavailable(owner);
                  if (typeInput.refresh) {
                    await sourceReset().run(tx, { ...runArgs(owner, run.runId), subject_id: row.id });
                    // Discard this private count build. The changed item is refreshed,
                    // then counts and validation restart into a new empty generation.
                    run.buildGeneration = newId(owner.route);
                    phase = 'types';
                  } else {
                    if (!row.valid || !typeInput.saved?.typeId) unavailable(owner);
                    nextCursor = [row.id];
                  }
                }
              } else {
                if (row && !row.valid) unavailable(owner);
                complete = row === null;
                nextCursor = row ? [row.id] : cursor;
              }
            } else if (phase === 'publish') {
              // The exclusive gate has drained late writers and is reloaded in this very command.
              gate.ready = true;
              gate.activeGeneration = build;
              gate.mode = 'open';
              await saveGate(tx, owner, gate);
              complete = true;
            } else if (phase === 'retire-counts') {
              if (gate.activeGeneration !== build) unavailable(owner);
              const sub = typeof cursor[0] === 'number' ? cursor[0] : 0;
              const rows = await retireCounts().run(tx, { ...ownerArgs(owner), generation: build, before: sub === 0 });
              complete = sub === 1 && rows.length < 100;
              nextCursor = [sub + (rows.length < 100 ? 1 : 0)];
            } else if (phase === 'retire-reservations') {
              if (gate.activeGeneration !== build) unavailable(owner);
              const sub = typeof cursor[0] === 'number' ? cursor[0] : 0;
              const rows =
                sub < 2
                  ? await retireReservations().run(tx, { ...ownerArgs(owner), generation: build, before: sub === 0 })
                  : await [scratchSessions(), scratchHeads(), scratchSources()][sub - 2]!.run(tx, ownerArgs(owner));
              complete = sub === 4 && rows.length < 100;
              nextCursor = [sub + (rows.length < 100 ? 1 : 0)];
            } else throw new Error(`Invalid native shelf phase: ${phase}`);
          }
          if (complete) {
            const phases =
              run.kind === 'purge'
                ? SHELF_PURGE_PHASES
                : run.kind === 'backfill'
                  ? SHELF_BACKFILL_PHASES
                  : SHELF_COUNTER_PHASES;
            const index = (phases as readonly string[]).indexOf(phase);
            if (index < 0) throw new Error('Invalid native shelf phase transition');
            phase = phases[index + 1] ?? 'complete';
            nextCursor = [];
          }
          const terminal = phase === 'complete';
          if (terminal && run.kind === 'purge') {
            await tx.query('DELETE FROM library.shelf_title_owner WHERE route=$1 AND account_id=$2::uuid', [
              owner.route,
              owner.accountId,
            ]);
            gate.mode = 'purged';
            await saveGate(tx, owner, gate);
          }
          validateShelfMaintenanceCursor(nextCursor);
          const nextSequence = BigInt(binding.sequence) + 1n;
          const segment = Number(nextSequence / 100n);
          const updated = await advance().run(tx, {
            ...args,
            next_epoch: BigInt(run.epoch),
            segment,
            phase,
            cursor: nextCursor as never,
            build_generation: run.buildGeneration,
          });
          if (!updated) unavailable(owner);
          await stepSave().run(tx, runArgs(owner, binding.runId));
          const next = terminal
            ? null
            : { ...binding, epoch: BigInt(run.epoch).toString(), sequence: nextSequence.toString(), segment };
          const value: ShelfMaintenanceReceipt = {
            binding,
            phase,
            next,
            transactionId: command.transactionId,
            receiptKey,
            terminal,
            sharedEvidence: 'separate-contract',
          };
          return { value, events: [event(owner)] };
        },
        scheduledRun?.kind === 'purge' ? 'purge' : 'rebuild',
      );
      return outcome.value;
    } catch (error) {
      // A concurrent winner may have captured another current observation. Its
      // immutable native header, never that losing observation, defines replay.
      if (
        retry < SHELF_MAINTENANCE_OPERATIONS().page.conflictReconciliations &&
        error instanceof IdempotencyConflictError
      )
        return executePage(binding, retry + 1, deadline);
      throw error;
    }
  }
  async function page(binding: ShelfMaintenanceBinding) {
    const original = Object.freeze({ ...binding });
    validateShelfMaintenanceBinding(original);
    // Preparation and the one conflict reconciliation share the original page
    // budget. Re-reading a winner's header must not renew command execution time.
    const deadline = workStepDeadline();
    return pageDeadlines.run(deadline, () => executePage(original, 0, deadline));
  }
  async function recover(input: Parameters<ShelfMaintenanceOps['recover']>[0]) {
    closed(input, ['after', 'limit']);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new RangeError('Shelf recovery limit must be 1 through 100');
    if (
      input.after &&
      (!Array.isArray(input.after) ||
        input.after.length !== 3 ||
        routeOf(input.after[1]) !== input.after[0] ||
        !uuid.test(input.after[2]))
    )
      throw new TypeError('Invalid shelf recovery cursor');
    const after = input.after ? Object.freeze([...input.after] as const) : null;
    const limit = input.limit;
    const rows = await withConnection(pool, (c) =>
      runnable().run(c, {
        after_route: after?.[0] ?? -1,
        after_account: after?.[1] ?? EMPTY_SHELF_GENERATION,
        after_run: after?.[2] ?? EMPTY_SHELF_GENERATION,
        page_limit: limit,
      }),
    );
    const client = rows.length ? await workClient() : null;
    const enqueued: ShelfMaintenanceBinding[] = [];
    for (const row of rows) {
      const owner = { route: row.route, accountId: row.accountId };
      const binding = {
        ...owner,
        runId: row.runId,
        epoch: BigInt(row.epoch).toString(),
        sequence: BigInt(row.sequence).toString(),
        segment: row.segment,
      };
      if (row.kind === 'purge')
        await client!.enqueue(
          {
            workflowName: 'library.accountErasure',
            queueName: 'workflows',
            workflowID: `${libraryErasureWorkflowId(owner.accountId)}:shelf:${row.runId}:${row.attempt}`,
            workflowIDReusePolicy: 'return-existing',
          },
          owner.accountId,
        );
      await enqueueShelfMaintenance(client!, binding, BigInt(row.attempt).toString());
      // Conditional acknowledgement cannot erase a concurrently advanced successor intent.
      await command(
        { partition: partitionOf(owner.route), deadline: workStepDeadline(), clock },
        async (tx) => {
          await ack().run(tx, {
            ...runArgs(owner, row.runId),
            epoch: BigInt(row.epoch),
            sequence: BigInt(row.sequence),
            segment: row.segment,
            attempt: BigInt(row.attempt),
          });
          return noEffect(null);
        },
        row.kind === 'purge' ? 'purge' : 'rebuild',
      );
      enqueued.push(binding);
    }
    const last = rows.at(-1);
    return {
      enqueued,
      next: rows.length === limit && last ? ([last.route, last.accountId, last.runId] as const) : null,
    };
  }
  return Object.freeze({ initialize, requestRebuild, requestPurge, page, recover });
}
export async function enqueueShelfMaintenance(
  client: WorkClient,
  binding: ShelfMaintenanceBinding,
  attempt = '0',
): Promise<void> {
  const original = Object.freeze({ ...binding });
  validateShelfMaintenanceBinding(original);
  const declaration = shelfMaintenanceEnqueuePlan({ binding: original, attempt });
  await consumeShelfMaintenance('enqueue', declaration.total, () =>
    client.enqueue(
      {
        workflowName: SHELF_MAINTENANCE_WORKFLOW,
        queueName: 'maintenance',
        workflowID: `shelf:${original.accountId}:${original.runId}:${original.epoch}:${original.sequence}:${original.segment}:${attempt}`,
        workflowIDReusePolicy: 'return-existing',
      },
      original,
    ),
  );
}

/** Installed exactly once by the existing Library WorkModule. */
export async function registerShelfMaintenanceWork(
  context: import('../work/registry.ts').WorkContext,
): Promise<ShelfMaintenanceOps> {
  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  const { COMMAND_STEP_RETRIES } = await import('../work/retries.ts');
  const { createAccess } = await import('../access/factory.ts');
  const shelfTypeDigest = shelfTypeDigestFromEnvironment(context.env);
  const ops = createShelfMaintenanceOps({
    ...context,
    ...(shelfTypeDigest === undefined ? {} : { shelfTypeDigest }),
    access: createAccess({ actions: new Map(), clock: context.clock }),
  });
  const page = DBOS.registerStep(async (binding: ShelfMaintenanceBinding) => ops.page(binding), {
    name: 'library.shelfMaintenancePage',
    ...COMMAND_STEP_RETRIES,
  });
  const continuation = DBOS.registerStep(
    async (binding: ShelfMaintenanceBinding) => enqueueShelfMaintenance(context.client, binding),
    { name: 'library.shelfMaintenanceContinue', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (start: ShelfMaintenanceBinding) => {
      const original = Object.freeze({ ...start });
      let binding: ShelfMaintenanceBinding | null = original;
      for (
        let n = 0;
        n < SHELF_MAINTENANCE_OPERATIONS().segment.pages && binding && binding.segment === original.segment;
        n++
      ) {
        const locator: ShelfMaintenanceBinding = binding;
        binding = (await SHELF_MAINTENANCE_OPERATIONS().segment.step(locator, () => page(locator))).next;
      }
      if (binding) {
        const successor = binding;
        await SHELF_MAINTENANCE_OPERATIONS().segment.step(successor, () => continuation(successor));
      }
    },
    { name: SHELF_MAINTENANCE_WORKFLOW },
  );
  const recover = DBOS.registerStep(
    async (after: readonly [number, string, string] | null) => ops.recover({ after, limit: 100 }),
    { name: 'library.shelfMaintenanceRecoverPage', ...COMMAND_STEP_RETRIES },
  );
  type Recovery = { root: string; segment: number; after: readonly [number, string, string] | null };
  const next = DBOS.registerStep(
    async (input: Recovery) => {
      const original = Object.freeze({
        ...input,
        after: input.after ? Object.freeze([...input.after] as const) : null,
      });
      const declaration = shelfMaintenanceEnqueuePlan(original);
      await consumeShelfMaintenance('recovery.enqueue', declaration.total, () =>
        context.client.enqueue(
          {
            workflowName: 'library.shelfMaintenanceRecoverySegment',
            queueName: 'maintenance',
            workflowID: `shelf-recovery:${original.root}:${original.segment}`,
            workflowIDReusePolicy: 'return-existing',
          },
          original,
        ),
      );
    },
    { name: 'library.shelfMaintenanceRecoveryContinue', ...COMMAND_STEP_RETRIES },
  );
  const sweep = async (input: Recovery) => {
    const original = Object.freeze({ ...input, after: input.after ? Object.freeze([...input.after] as const) : null });
    let after = original.after;
    for (let n = 0; n < SHELF_MAINTENANCE_OPERATIONS().segment.pages; n++) {
      const cursor = after;
      after = (await SHELF_MAINTENANCE_OPERATIONS().segment.step(cursor, () => recover(cursor))).next;
      if (!after) return;
    }
    const successor = Object.freeze({ ...original, segment: original.segment + 1, after });
    await SHELF_MAINTENANCE_OPERATIONS().segment.step(successor, () => next(successor));
  };
  DBOS.registerWorkflow(sweep, { name: 'library.shelfMaintenanceRecoverySegment' });
  DBOS.registerWorkflow(() => sweep({ root: DBOS.workflowID!, segment: 0, after: null }), {
    name: 'library.shelfMaintenanceRecovery',
  });
  await context.client.applySchedules([
    {
      scheduleName: 'library.shelfMaintenance.every-10-minutes',
      workflowName: 'library.shelfMaintenanceRecovery',
      schedule: '*/10 * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
  return ops;
}
