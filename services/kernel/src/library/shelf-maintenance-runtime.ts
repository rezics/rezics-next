import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { shareAccount, fenceOperationalAccount } from '../access/account-share.ts';
import { hasLiveOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import {
  currentCommand,
  hasLiveCommandTransaction,
  noEffect,
  normalizeCommandKey,
  principalCommandIdentity,
  runCommand,
  CommandUnavailableError,
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
} from './shelf-type-keys.ts';
import { observePreparationSource, observePreparationIdentity } from './preparation-source.ts';
import type { TypePreparationIdentity } from './type-preparation-contract.ts';
import {
  EMPTY_SHELF_GENERATION,
  SHELF_BACKFILL_PHASES,
  SHELF_COUNTER_PHASES,
  SHELF_PURGE_PHASES,
  initialShelfReadiness,
  type ShelfDerivedPage,
  type ShelfMaintenanceBinding,
  type ShelfMaintenanceCursor,
  type ShelfMaintenanceDependencies,
  type ShelfMaintenanceDerivedPorts,
  type ShelfMaintenanceKind,
  type ShelfMaintenanceOps,
  type ShelfMaintenancePhase,
  type ShelfMaintenanceReceipt,
  type ShelfMaintenanceTypeObservation,
  type ShelfOwner,
} from './shelf-maintenance-ops-contract.ts';
import { workStepDeadline } from './command-support.ts';
import { readMaintenanceSessions } from './maintenance-session-page.ts';
import { readMaintenanceHistoryPage } from './maintenance-history-page.ts';
import erasureProbe from './erasure-probe.sql';
import { libraryErasureWorkflowId } from './erasure-participant.ts';
import scope from './erasure-scope.sql';
import gateEnsure from './shelf-maintenance-gate-ensure.sql';
import gateRead from './shelf-maintenance-gate-read.sql';
import gateLock from './shelf-maintenance-gate-lock.sql';
import gateShare from './shelf-maintenance-gate-share.sql';
import gateSave from './shelf-maintenance-gate-save.sql';
import inputs from './shelf-maintenance-inputs.sql';
import runRead from './shelf-maintenance-run-read.sql';
import runLock from './shelf-maintenance-run-lock.sql';
import runCreate from './shelf-maintenance-run-create.sql';
import stepRead from './shelf-maintenance-step-read.sql';
import stepSave from './shelf-maintenance-step-save.sql';
import stepBind from './shelf-maintenance-step-bind.sql';
import advance from './shelf-maintenance-advance.sql';
import cancel from './shelf-maintenance-cancel.sql';
import runnable from './shelf-maintenance-runnable.sql';
import ack from './shelf-maintenance-ack.sql';
import tombstone from './shelf-maintenance-tombstone.sql';
import authorizedCollection from './shelf-maintenance-authorized-collection.sql';
import entries from './shelf-maintenance-entries.sql';
import entryBackfill from './shelf-maintenance-entry-backfill.sql';
import stampIncarnation from './entry-legacy-incarnation-stamp.sql';
import sessionScratch from './shelf-maintenance-session-scratch.sql';
import sessions from './shelf-maintenance-sessions.sql';
import headInputs from './shelf-maintenance-head-inputs.sql';
import heads from './shelf-maintenance-heads.sql';
import countEntries from './shelf-maintenance-count-entries.sql';
import countCollections from './shelf-maintenance-count-collections.sql';
import validate from './shelf-maintenance-validate.sql';
import retireCounts from './shelf-maintenance-retire-counts.sql';
import retireReservations from './shelf-maintenance-retire-reservations.sql';
import scratchSessions from './shelf-maintenance-scratch-sessions.sql';
import scratchHeads from './shelf-maintenance-scratch-heads.sql';
import scratchSources from './shelf-maintenance-scratch-sources.sql';
import scratchSteps from './shelf-maintenance-scratch-steps.sql';
import sourceRead from './shelf-maintenance-source-read.sql';
import sourceSave from './shelf-maintenance-source-save.sql';
import sourceProgress from './shelf-maintenance-source-progress.sql';
import sourceAttach from './shelf-maintenance-source-attach.sql';
import sourceReset from './shelf-maintenance-source-reset.sql';
import reservationBind from './shelf-maintenance-reservation-bind.sql';
import reservationCheck from './shelf-maintenance-reservation-check.sql';
import bulkPending from './shelf-maintenance-bulk-pending.sql';

export const SHELF_MAINTENANCE_WORKFLOW = 'library.shelfMaintenance';
export const SHELF_MAINTENANCE_EVENT = 'com.rezics.library.shelf-maintenance.advanced.v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal = /^(0|[1-9][0-9]*)$/;
type Run = NonNullable<Awaited<ReturnType<typeof runRead.run>>>;
type Gate = NonNullable<Awaited<ReturnType<typeof gateRead.run>>>;
type Step = NonNullable<Awaited<ReturnType<typeof stepRead.run>>>;
type SourceRow = NonNullable<Awaited<ReturnType<typeof sourceRead.run>>>;
const ownerArgs = (owner: ShelfOwner) => ({ route: owner.route, account_id: owner.accountId });
const runArgs = (owner: ShelfOwner, runId: string) => ({ ...ownerArgs(owner), run_id: runId });
function unavailable(owner: ShelfOwner): never {
  throw new CommandUnavailableError('contention', partitionOf(owner.route));
}
function ownerCheck(owner: ShelfOwner) {
  if (!owner || !uuid.test(owner.accountId) || routeOf(owner.accountId) !== owner.route)
    throw new TypeError('Invalid shelf maintenance owner');
  partitionOf(owner.route);
}
function closed(input: object, keys: readonly string[]) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(input, k))
  )
    throw new TypeError('Invalid shelf maintenance locator');
}
export function validateShelfMaintenanceCursor(cursor: ShelfMaintenanceCursor): void {
  if (
    !Array.isArray(cursor) ||
    cursor.length > 8 ||
    cursor.some(
      (v) =>
        v !== null &&
        typeof v !== 'string' &&
        typeof v !== 'boolean' &&
        (typeof v !== 'number' || !Number.isSafeInteger(v)),
    ) ||
    Buffer.byteLength(JSON.stringify(cursor)) > 2048
  )
    throw new TypeError('Invalid shelf maintenance checkpoint');
}
export function validateShelfMaintenanceBinding(binding: ShelfMaintenanceBinding): void {
  closed(binding, ['route', 'accountId', 'runId', 'epoch', 'sequence', 'segment']);
  ownerCheck(binding);
  if (
    !uuid.test(binding.runId) ||
    !decimal.test(binding.epoch) ||
    !decimal.test(binding.sequence) ||
    !Number.isSafeInteger(binding.segment) ||
    binding.segment < 0 ||
    Buffer.byteLength(JSON.stringify(binding)) > 4096
  )
    throw new TypeError('Invalid shelf maintenance locator');
  if (BigInt(binding.sequence) / 100n !== BigInt(binding.segment))
    throw new TypeError('Invalid shelf maintenance segment');
}
function bindingFor(owner: ShelfOwner, run: Run): ShelfMaintenanceBinding {
  const value = {
    ...owner,
    runId: run.runId,
    epoch: BigInt(run.epoch).toString(),
    sequence: BigInt(run.sequence).toString(),
    segment: run.segment,
  };
  validateShelfMaintenanceBinding(value);
  return value;
}
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
function live(tx: CommandTransaction, owner: ShelfOwner) {
  ownerCheck(owner);
  const command = currentCommand(tx);
  if (
    !hasLiveCommandTransaction(tx) ||
    command.partition !== partitionOf(owner.route) ||
    command.authorization?.mode !== 'execute'
  )
    throw new TypeError('Shelf maintenance requires a live authorized owner command');
  return command;
}
async function ownerAuthority(tx: CommandTransaction, owner: ShelfOwner) {
  const command = live(tx, owner);
  if (command.authorization!.resource.id === owner.accountId && command.authorization!.resource.route === owner.route)
    return;
  // A Collection writer has already admitted its actual resource. Resolve its immutable curator natively.
  if (
    command.authorization!.resource.route !== owner.route ||
    !(await authorizedCollection.run(tx, { ...ownerArgs(owner), collection_id: command.authorization!.resource.id }))
  )
    throw new GrantDeniedError();
}
async function saveGate(tx: CommandTransaction, owner: ShelfOwner, gate: Gate) {
  await gateSave.run(tx, {
    ...ownerArgs(owner),
    mode: gate.mode,
    ready: gate.ready,
    epoch: BigInt(gate.epoch),
    active_generation: gate.activeGeneration,
    run_id: gate.runId,
  });
}
async function createRun(tx: CommandTransaction, owner: ShelfOwner, gate: Gate, kind: ShelfMaintenanceKind) {
  const runId = newId(owner.route);
  await runCreate.run(tx, {
    ...runArgs(owner, runId),
    epoch: BigInt(gate.epoch),
    kind,
    phase: kind === 'purge' ? 'cancel-work' : 'drain',
    build_generation: null,
  });
  gate.runId = runId;
  await saveGate(tx, owner, gate);
  await stepSave.run(tx, runArgs(owner, runId));
  const run = await runRead.run(tx, runArgs(owner, runId));
  if (!run) throw new Error('Missing newly committed shelf run');
  return bindingFor(owner, run);
}
/** Called only in an already admitted live owner command. No absent-row empty inference. */
async function initialize(tx: CommandTransaction, owner: ShelfOwner) {
  await ownerAuthority(tx, owner);
  await shareAccount(tx, owner.accountId);
  let gate = await gateRead.run(tx, ownerArgs(owner));
  if (!gate) {
    await gateEnsure.run(tx, ownerArgs(owner));
    gate = await gateLock.run(tx, ownerArgs(owner));
  } else if (!gate.initialized) gate = await gateLock.run(tx, ownerArgs(owner));
  if (!gate) throw new Error('Shelf gate disappeared');
  const initializedNow = !gate.initialized;
  if (!gate.initialized) {
    const facts = await inputs.run(tx, ownerArgs(owner));
    const readiness = initialShelfReadiness({
      hasEntries: facts.entries,
      hasCollections: facts.collections,
      hasSessions: facts.sessions,
    });
    gate.initialized = true;
    gate.ready = readiness === 'ready';
    gate.activeGeneration = gate.ready ? EMPTY_SHELF_GENERATION : null;
    if (!gate.ready) {
      await createRun(tx, owner, gate, 'backfill');
    } else await saveGate(tx, owner, gate);
  }
  gate = await gateShare.run(tx, ownerArgs(owner));
  if (!gate) throw new Error('Shelf gate disappeared');
  const run = gate.runId ? await runRead.run(tx, runArgs(owner, gate.runId)) : null;
  return {
    initializedNow,
    readiness: gate.ready ? ('ready' as const) : ('backfill' as const),
    generationId: gate.activeGeneration,
    requested: run && run.phase !== 'complete' && !run.cancelled ? bindingFor(owner, run) : null,
  };
}
/** Every ordinary input writer holds this lock through its own commit, including all late writers. */
export async function enterShelfWrite(tx: CommandTransaction, owner: ShelfOwner) {
  await initialize(tx, owner);
  const gate = await gateShare.run(tx, ownerArgs(owner));
  if (!gate || gate.mode !== 'open') unavailable(owner);
  return { ready: gate.ready, epoch: BigInt(gate.epoch), generationId: gate.activeGeneration };
}

/** Technical input repairs retain their existing operational authority. They can
 * create an uninitialized gate, but cannot declare readiness or mint derived pages. */
export async function fenceShelfTechnicalWrite(tx: OperationalTransaction, owner: ShelfOwner): Promise<void> {
  ownerCheck(owner);
  if (!hasLiveOperationalTransaction(tx)) throw new TypeError('No live shelf technical transaction');
  await fenceOperationalAccount(tx, owner.accountId);
  await gateEnsure.run(tx, ownerArgs(owner));
  const gate = await gateShare.run(tx, ownerArgs(owner));
  if (!gate || gate.mode !== 'open') unavailable(owner);
}

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
  const gate = await gateLock.run(tx, ownerArgs(proof.owner));
  const run = await runLock.run(tx, runArgs(proof.owner, proof.run.runId));
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
  await shareAccount(tx, proof.owner.accountId);
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
      const result = await withShelfDerivedTypePreparation(tx, page, null, () =>
        proof.keys.reserve({ client: tx, ...proof.owner }, source.fullType),
      );
      if (!result.done) {
        const rows = await reservationBind.run(tx, {
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
        ? await sourceRead.run(tx, { ...runArgs(proof.owner, page.runId), subject_id: proof.source.subjectId })
        : null;
      if (
        !saved ||
        saved.reservationId !== reservationId ||
        !(await reservationCheck.run(tx, {
          ...runArgs(proof.owner, page.runId),
          reservation_id: reservationId,
          generation: page.generationId,
        }))
      )
        throw new TypeError('Reservation is not bound to this live shelf page');
      return withShelfDerivedTypePreparation(tx, page, reservationId, () =>
        proof.keys.continue({ client: tx, ...proof.owner }, { reservationId }),
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
    const entry = await entries.run(client, {
      ...ownerArgs(owner),
      after: typeof after === 'string' ? after : EMPTY_SHELF_GENERATION,
    });
    const saved = entry
      ? await sourceRead.run(client, { ...runArgs(owner, runId), subject_id: entry.subjectId })
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
  if (run.phase === 'cancel-work') return { complete: true, cursor: [] };
  if (run.phase === 'bulk-evidence') {
    if (await bulkPending.run(tx, ownerArgs(owner))) unavailable(owner);
    const sub = typeof cursor[0] === 'number' ? cursor[0] : 0;
    const removed =
      sub < 3
        ? await [scratchSessions, scratchHeads, scratchSources][sub]!.run(tx, ownerArgs(owner))
        : await scratchSteps.run(tx, { ...runArgs(owner, run.runId), before: sub === 3 });
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
      observe: (id) => observePreparationSource(dependencies, id),
      observeIdentity: (id) => observePreparationIdentity(dependencies, id),
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
  async function requestRebuild(
    actor: Parameters<ShelfMaintenanceOps['requestRebuild']>[0],
    input: Parameters<ShelfMaintenanceOps['requestRebuild']>[1],
  ) {
    closed(input, ['owner', 'kind', 'requestKey']);
    ownerCheck(input.owner);
    if (input.kind !== 'backfill' && input.kind !== 'counters') throw new TypeError('Invalid shelf rebuild kind');
    const owner = { ...input.owner };
    const identity = principalCommandIdentity(actor);
    const resource = { route: owner.route, id: owner.accountId };
    const authorization = resourceAuthorization({
      access,
      actor,
      action: 'account:manage',
      anchor: {
        resource,
        async validate(tx) {
          await shareAccount(tx, owner.accountId);
          return true;
        },
      },
      context: { pool, deadline: workStepDeadline(), partition: partitionOf(owner.route) },
    });
    const result = await runCommand(
      pool,
      {
        ...identity,
        partition: partitionOf(owner.route),
        deadline: workStepDeadline(),
        clock,
        receipt: { kind: 'library.shelf-maintenance.request', key: input.requestKey, digest: digest(input) },
        authorization,
      },
      async (tx) => {
        await initialize(tx, owner);
        const gate = await gateLock.run(tx, ownerArgs(owner));
        if (!gate || (gate.mode !== 'open' && gate.mode !== 'rebuilding')) unavailable(owner);
        if (gate.runId) {
          const current = await runLock.run(tx, runArgs(owner, gate.runId));
          if (current && current.phase !== 'complete' && !current.cancelled) {
            if (current.phase === 'retire-counts' || current.phase === 'retire-reservations') unavailable(owner);
            if (current.kind !== input.kind) unavailable(owner);
            return noEffect(bindingFor(owner, current));
          }
        }
        if (input.kind === 'counters' && !gate.ready) unavailable(owner);
        const requested = await createRun(tx, owner, gate, input.kind);
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
    const result = await runCommand(
      pool,
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
        await gateEnsure.run(tx, ownerArgs(owner));
        const gate = await gateLock.run(tx, ownerArgs(owner));
        if (!gate) throw new Error('Missing terminal shelf gate');
        if (gate.runId && (gate.mode === 'purging' || gate.mode === 'purged')) {
          const current = await runRead.run(tx, runArgs(owner, gate.runId));
          if (!current) throw new Error('Missing terminal shelf run');
          return noEffect(bindingFor(owner, current));
        }
        if (gate.runId) await cancel.run(tx, runArgs(owner, gate.runId));
        gate.mode = 'purging';
        gate.ready = false;
        gate.activeGeneration = null;
        gate.epoch = BigInt(gate.epoch) + 1n;
        const requested = await createRun(tx, owner, gate, 'purge');
        return { value: requested, events: [event(owner)] };
      },
    );
    return result.value;
  }
  async function executePage(binding: ShelfMaintenanceBinding, retry: number): Promise<ShelfMaintenanceReceipt> {
    binding = Object.freeze({ ...binding });
    validateShelfMaintenanceBinding(binding);
    const owner = { route: binding.route, accountId: binding.accountId };
    const args = { ...runArgs(owner, binding.runId), epoch: BigInt(binding.epoch), sequence: BigInt(binding.sequence) };
    const header = await withConnection(pool, (client) => stepRead.run(client, args));
    if (!header) throw new TypeError('Unknown native shelf maintenance step');
    const cursor = cursorOf(header);
    let admitted: { gate: Gate; run: Run } | undefined;
    // Capture the initial bounded input before Core hashes its immutable receipt.
    // On replay the applied header supplies that exact commitment without a source read.
    let typeInput: Awaited<ReturnType<typeof prepareType>> | undefined;
    if (header.inputIdentity === null && (header.phase === 'types' || header.phase === 'validate')) {
      const current = await withConnection(pool, (c) => runRead.run(c, runArgs(owner, binding.runId)));
      if (
        current &&
        !current.cancelled &&
        BigInt(current.epoch) === args.epoch &&
        BigInt(current.sequence) === args.sequence &&
        (header.phase === 'types' || current.kind === 'backfill')
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
      const outcome = await runCommand<ShelfMaintenanceReceipt>(
        pool,
        {
          partition: partitionOf(owner.route),
          deadline: workStepDeadline(),
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
              const current = await withConnection(pool, (c) => runRead.run(c, runArgs(owner, binding.runId)));
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
              const current = await runRead.run(tx, runArgs(owner, binding.runId));
              if (!current) throw new GrantDeniedError();
              if (current.kind === 'purge') {
                if (!(await scope.run(tx, ownerArgs(owner)))) throw new GrantDeniedError();
              } else await shareAccount(tx, owner.accountId);
              const gate = await gateLock.run(tx, ownerArgs(owner));
              const run = await runLock.run(tx, runArgs(owner, binding.runId));
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
          if (header.inputIdentity === null && !(await stepBind.run(tx, { ...args, identity: commitment as never })))
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
                await sessionScratch.run(tx, {
                  ...runArgs(owner, binding.runId),
                  session_id: parent,
                  time: history.lastChangedAt,
                });
                nextCursor = history.complete ? [parent, null, 0] : [cursor[0] ?? null, parent, history.after];
              }
            } else if (phase === 'sessions' || phase === 'head-inputs' || phase === 'heads') {
              const rows = await { sessions, 'head-inputs': headInputs, heads }[phase].run(tx, query);
              const last = rows
                .map((r) => r.id)
                .sort()
                .at(-1);
              complete = rows.length < 100;
              nextCursor = last ? [last] : cursor;
            } else if (phase === 'entries') {
              const rows = await entryBackfill.run(tx, { ...ownerArgs(owner), after });
              for (const row of rows)
                if (row.incarnationId === null) {
                  const stamped = await stampIncarnation.run(tx, {
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
                const current = await entries.run(tx, { ...ownerArgs(owner), after });
                if (
                  !current ||
                  current.subjectId !== source.subjectId ||
                  current.incarnationId !== source.incarnationId ||
                  current.transactionId !== source.transactionId
                )
                  unavailable(owner);
                if (typeInput.refresh) {
                  await sourceReset.run(tx, { ...runArgs(owner, run.runId), subject_id: source.subjectId });
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
                    if (typeInput.saved) await sourceProgress.run(tx, saved);
                    else
                      await sourceSave.run(tx, {
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
                      const attached = await sourceAttach.run(tx, {
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
              const rows = await (phase === 'count-entries' ? countEntries : countCollections).run(tx, {
                ...ownerArgs(owner),
                after,
                generation: build,
              });
              complete = rows.length < 100;
              nextCursor = rows.at(-1) ? [rows.at(-1)!.id] : cursor;
            } else if (phase === 'validate') {
              const row = await validate.run(tx, { ...ownerArgs(owner), after });
              if (run.kind === 'backfill') {
                if (typeInput === undefined) unavailable(owner);
                if (typeInput === null) {
                  if (row !== null) unavailable(owner);
                  complete = true;
                } else {
                  if (!row || row.id !== typeInput.source.subjectId) unavailable(owner);
                  if (typeInput.refresh) {
                    await sourceReset.run(tx, { ...runArgs(owner, run.runId), subject_id: row.id });
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
              const rows = await retireCounts.run(tx, { ...ownerArgs(owner), generation: build, before: sub === 0 });
              complete = sub === 1 && rows.length < 100;
              nextCursor = [sub + (rows.length < 100 ? 1 : 0)];
            } else if (phase === 'retire-reservations') {
              if (gate.activeGeneration !== build) unavailable(owner);
              const sub = typeof cursor[0] === 'number' ? cursor[0] : 0;
              const rows =
                sub < 2
                  ? await retireReservations.run(tx, { ...ownerArgs(owner), generation: build, before: sub === 0 })
                  : await [scratchSessions, scratchHeads, scratchSources][sub - 2]!.run(tx, ownerArgs(owner));
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
            gate.mode = 'purged';
            await saveGate(tx, owner, gate);
          }
          validateShelfMaintenanceCursor(nextCursor);
          const nextSequence = BigInt(binding.sequence) + 1n;
          const segment = Number(nextSequence / 100n);
          const updated = await advance.run(tx, {
            ...args,
            next_epoch: BigInt(run.epoch),
            segment,
            phase,
            cursor: nextCursor as never,
            build_generation: run.buildGeneration,
          });
          if (!updated) unavailable(owner);
          await stepSave.run(tx, runArgs(owner, binding.runId));
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
      );
      return outcome.value;
    } catch (error) {
      // A concurrent winner may have captured another current observation. Its
      // immutable native header, never that losing observation, defines replay.
      if (retry === 0 && error instanceof IdempotencyConflictError) return executePage(binding, 1);
      throw error;
    }
  }
  async function page(binding: ShelfMaintenanceBinding) {
    return executePage(binding, 0);
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
    const rows = await withConnection(pool, (c) =>
      runnable.run(c, {
        after_route: input.after?.[0] ?? -1,
        after_account: input.after?.[1] ?? EMPTY_SHELF_GENERATION,
        after_run: input.after?.[2] ?? EMPTY_SHELF_GENERATION,
        page_limit: input.limit,
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
      await runCommand(
        pool,
        { partition: partitionOf(owner.route), deadline: workStepDeadline(), clock },
        async (tx) => {
          await ack.run(tx, {
            ...runArgs(owner, row.runId),
            epoch: BigInt(row.epoch),
            sequence: BigInt(row.sequence),
            segment: row.segment,
            attempt: BigInt(row.attempt),
          });
          return noEffect(null);
        },
      );
      enqueued.push(binding);
    }
    const last = rows.at(-1);
    return {
      enqueued,
      next: rows.length === input.limit && last ? ([last.route, last.accountId, last.runId] as const) : null,
    };
  }
  return Object.freeze({ initialize, requestRebuild, requestPurge, page, recover });
}
export async function enqueueShelfMaintenance(
  client: WorkClient,
  binding: ShelfMaintenanceBinding,
  attempt = '0',
): Promise<void> {
  validateShelfMaintenanceBinding(binding);
  await client.enqueue(
    {
      workflowName: SHELF_MAINTENANCE_WORKFLOW,
      queueName: 'maintenance',
      workflowID: `shelf:${binding.accountId}:${binding.runId}:${binding.epoch}:${binding.sequence}:${binding.segment}:${attempt}`,
      workflowIDReusePolicy: 'return-existing',
    },
    binding,
  );
}

/** Installed exactly once by the existing Library WorkModule. */
export async function registerShelfMaintenanceWork(
  context: import('../work/registry.ts').WorkContext,
): Promise<ShelfMaintenanceOps> {
  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  const { COMMAND_STEP_RETRIES } = await import('../work/retries.ts');
  const { createAccess } = await import('../access/index.ts');
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
      let binding: ShelfMaintenanceBinding | null = start;
      for (let n = 0; n < 100 && binding && binding.segment === start.segment; n++)
        binding = (await page(binding)).next;
      if (binding) await continuation(binding);
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
      await context.client.enqueue(
        {
          workflowName: 'library.shelfMaintenanceRecoverySegment',
          queueName: 'maintenance',
          workflowID: `shelf-recovery:${input.root}:${input.segment}`,
          workflowIDReusePolicy: 'return-existing',
        },
        input,
      );
    },
    { name: 'library.shelfMaintenanceRecoveryContinue', ...COMMAND_STEP_RETRIES },
  );
  const sweep = async (input: Recovery) => {
    let after = input.after;
    for (let n = 0; n < 100; n++) {
      after = (await recover(after)).next;
      if (!after) return;
    }
    await next({ ...input, segment: input.segment + 1, after });
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
