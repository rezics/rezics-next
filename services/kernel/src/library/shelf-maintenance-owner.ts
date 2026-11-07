/** Native shelf owner admission and gate initialization, independent of maintenance execution. */
import { memoizedValue } from '../memoized.ts';
import { shareAccount, fenceOperationalAccount } from './access-port.ts';
import { GrantDeniedError } from '../access/contract/errors.ts';
import { hasLiveOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import {
  currentCommand,
  hasLiveCommandTransaction,
  CommandUnavailableError,
  type CommandTransaction,
} from '../command/command.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import {
  EMPTY_SHELF_GENERATION,
  initialShelfReadiness,
  type ShelfMaintenanceKind,
  type ShelfMaintenanceCursor,
  type ShelfOwner,
} from './contract/index.ts';
import type { ShelfMaintenanceBinding } from './shelf-maintenance-ops-contract.ts';
import { consumeShelfMaintenance, shelfMaintenanceQuery } from './shelf-maintenance-bounds.ts';
import { shelfMaintenanceStatementPlan } from './shelf-maintenance-statement-bounds.ts';
import accountShareQuery from '../access/account-share.sql';
import gateEnsureQuery from './shelf-maintenance-gate-ensure.sql';
import gateReadQuery from './shelf-maintenance-gate-read.sql';
import gateLockQuery from './shelf-maintenance-gate-lock.sql';
import gateShareQuery from './shelf-maintenance-gate-share.sql';
import gateSaveQuery from './shelf-maintenance-gate-save.sql';
import inputsQuery from './shelf-maintenance-inputs.sql';
import runReadQuery from './shelf-maintenance-run-read.sql';
import runCreateQuery from './shelf-maintenance-run-create.sql';
import stepSaveQuery from './shelf-maintenance-step-save.sql';
import authorizedCollectionQuery from './shelf-maintenance-authorized-collection.sql';
export function gateEnsure() {
  return memoizedValue(gateEnsure, () => shelfMaintenanceQuery(gateEnsureQuery));
}

export function gateRead() {
  return memoizedValue(gateRead, () => shelfMaintenanceQuery(gateReadQuery));
}

export function gateLock() {
  return memoizedValue(gateLock, () => shelfMaintenanceQuery(gateLockQuery));
}

export function gateShare() {
  return memoizedValue(gateShare, () => shelfMaintenanceQuery(gateShareQuery));
}

export function gateSave() {
  return memoizedValue(gateSave, () => shelfMaintenanceQuery(gateSaveQuery));
}

export function inputs() {
  return memoizedValue(inputs, () => shelfMaintenanceQuery(inputsQuery));
}

export function runRead() {
  return memoizedValue(runRead, () => shelfMaintenanceQuery(runReadQuery));
}

export function runCreate() {
  return memoizedValue(runCreate, () => shelfMaintenanceQuery(runCreateQuery));
}

export function stepSave() {
  return memoizedValue(stepSave, () => shelfMaintenanceQuery(stepSaveQuery));
}

export function authorizedCollection() {
  return memoizedValue(authorizedCollection, () => shelfMaintenanceQuery(authorizedCollectionQuery));
}

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const decimal = /^(0|[1-9][0-9]*)$/;

export type Run = NonNullable<Awaited<ReturnType<ReturnType<typeof runRead>['run']>>>;

export type Gate = NonNullable<Awaited<ReturnType<ReturnType<typeof gateRead>['run']>>>;

export const ownerArgs = (owner: ShelfOwner) => ({ route: owner.route, account_id: owner.accountId });

export const runArgs = (owner: ShelfOwner, runId: string) => ({ ...ownerArgs(owner), run_id: runId });

export function unavailable(owner: ShelfOwner): never {
  throw new CommandUnavailableError('contention', partitionOf(owner.route));
}

export function ownerCheck(owner: ShelfOwner) {
  if (!owner || !uuid.test(owner.accountId) || routeOf(owner.accountId) !== owner.route)
    throw new TypeError('Invalid shelf maintenance owner');
  partitionOf(owner.route);
}

export function closed(input: object, keys: readonly string[]) {
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

export function bindingFor(owner: ShelfOwner, run: Run): ShelfMaintenanceBinding {
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

export function live(tx: CommandTransaction, owner: ShelfOwner) {
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

export async function shareShelfAccount(tx: CommandTransaction, accountId: string) {
  const plan = shelfMaintenanceStatementPlan(
    accountShareQuery.sql,
    accountShareQuery.params.map((name) => (name === 'route' ? routeOf(accountId)! : accountId)),
  )!;
  return consumeShelfMaintenance('account', plan.total, () => shareAccount(tx, accountId));
}

export async function ownerAuthority(tx: CommandTransaction, owner: ShelfOwner) {
  const command = live(tx, owner);
  if (command.authorization!.resource.id === owner.accountId && command.authorization!.resource.route === owner.route)
    return;
  // A Collection writer has already admitted its actual resource. Resolve its immutable curator natively.
  if (
    command.authorization!.resource.route !== owner.route ||
    !(await authorizedCollection().run(tx, { ...ownerArgs(owner), collection_id: command.authorization!.resource.id }))
  )
    throw new GrantDeniedError();
}

export async function saveGate(tx: CommandTransaction, owner: ShelfOwner, gate: Gate) {
  await gateSave().run(tx, {
    ...ownerArgs(owner),
    mode: gate.mode,
    ready: gate.ready,
    epoch: BigInt(gate.epoch),
    active_generation: gate.activeGeneration,
    run_id: gate.runId,
  });
}

export async function createRun(tx: CommandTransaction, owner: ShelfOwner, gate: Gate, kind: ShelfMaintenanceKind) {
  const runId = newId(owner.route);
  await runCreate().run(tx, {
    ...runArgs(owner, runId),
    epoch: BigInt(gate.epoch),
    kind,
    phase: kind === 'purge' ? 'cancel-work' : 'drain',
    build_generation: null,
  });
  gate.runId = runId;
  await saveGate(tx, owner, gate);
  await stepSave().run(tx, runArgs(owner, runId));
  const run = await runRead().run(tx, runArgs(owner, runId));
  if (!run) throw new Error('Missing newly committed shelf run');
  return bindingFor(owner, run);
}

/** Called only in an already admitted live owner command. No absent-row empty inference. */
export async function initialize(tx: CommandTransaction, owner: ShelfOwner) {
  await ownerAuthority(tx, owner);
  await shareShelfAccount(tx, owner.accountId);
  let gate = await gateRead().run(tx, ownerArgs(owner));
  if (!gate) {
    await gateEnsure().run(tx, ownerArgs(owner));
    gate = await gateLock().run(tx, ownerArgs(owner));
  } else if (!gate.initialized) gate = await gateLock().run(tx, ownerArgs(owner));
  if (!gate) throw new Error('Shelf gate disappeared');
  const initializedNow = !gate.initialized;
  if (!gate.initialized) {
    const facts = await inputs().run(tx, ownerArgs(owner));
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
  gate = await gateShare().run(tx, ownerArgs(owner));
  if (!gate) throw new Error('Shelf gate disappeared');
  const run = gate.runId ? await runRead().run(tx, runArgs(owner, gate.runId)) : null;
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
  const gate = await gateShare().run(tx, ownerArgs(owner));
  if (!gate || gate.mode !== 'open') unavailable(owner);
  return { ready: gate.ready, epoch: BigInt(gate.epoch), generationId: gate.activeGeneration };
}

/** Technical input repairs retain their existing operational authority. They can
 * create an uninitialized gate, but cannot declare readiness or mint derived pages. */
export async function fenceShelfTechnicalWrite(tx: OperationalTransaction, owner: ShelfOwner): Promise<void> {
  ownerCheck(owner);
  if (!hasLiveOperationalTransaction(tx)) throw new TypeError('No live shelf technical transaction');
  await fenceOperationalAccount(tx, owner.accountId);
  await gateEnsure().run(tx, ownerArgs(owner));
  const gate = await gateShare().run(tx, ownerArgs(owner));
  if (!gate || gate.mode !== 'open') unavailable(owner);
}
