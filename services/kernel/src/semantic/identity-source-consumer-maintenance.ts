import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkClient } from '../work/client.ts';
import type { HistoryRegistry } from '../history/registry.ts';
import type { KernelClock } from '../clock.ts';
import type { NativeStepWork } from './identity-epoch-contract.ts';
import type { WorkDimensions, WorkAllowance } from '../library/collection-source.ts';
import {
  withCommandDispatchLifetime,
  COMMAND_DISPATCH_ALLOWANCE,
  withSourceFenceCommandDispatchLifetime,
  SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE,
} from '../command/dispatch-lifetime.ts';
import {
  NativeCollectionWork,
  bindNativeCollectionWorkLifetime,
  withNativeCollectionWorkAllowance,
} from '../library/collection-source-work.ts';
import {
  currentIdentityOriginalTransfer,
  identityOriginalRemainder,
  identityOriginalLibraryWork,
  reserveIdentityOriginalSourceWork,
  originalWorkVector,
  ORIGINAL_AXES,
  HISTORY_ORIGINAL_LOCAL_ALLOWANCE,
  ADDITIONAL_ORIGINAL_TRANSFER_CONTROL,
  type HistoryOriginalDependencies,
  type IdentityOriginalSourceContext,
} from '../access/identity-original-admission.ts';
import {
  readIdentitySourceMaintenanceConfig,
  composeIdentitySourceReachedCosts,
  IDENTITY_SOURCE_ORIGINAL_SCHEDULE,
  type IdentitySourceLibraryOperation,
  type IdentitySourceScheduledOperation,
} from './identity-source-maintenance-config.ts';

const identitySourceConsumerMaintenance: unique symbol = Symbol('identity-source-consumer-maintenance');
export type IdentitySourceConsumerMaintenanceWork = Readonly<{
  [identitySourceConsumerMaintenance]: true;
}>;
export type IdentitySourceConsumerMaintenanceContext = Readonly<{
  deadline: number;
  identityConsumerWork: IdentitySourceConsumerMaintenanceWork;
}>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type NativeUsed = Mutable<NativeStepWork>;
type Frame = {
  token: IdentitySourceConsumerMaintenanceWork;
  pool: Pool;
  deadline: number;
  active: boolean;
  native: NativeStepWork;
  used: NativeUsed;
  library: NativeCollectionWork;
  original?: Readonly<{ deps: HistoryOriginalDependencies; parent: IdentityOriginalSourceContext }>;
  custodyClaimed?: boolean;
  reached?: Map<string, number>;
};

const frames = new WeakMap<IdentitySourceConsumerMaintenanceWork, Frame>();
const current = new AsyncLocalStorage<Frame>();
const libraryRemainder = new AsyncLocalStorage<Frame>();

function live(frame: Frame, pool: Pool, deadline?: number): boolean {
  if (frame.original) {
    try {
      authenticateOriginal(frame.original.deps, frame.original.parent);
    } catch {
      return false;
    }
  }
  return (
    frame.active &&
    current.getStore() === frame &&
    frame.pool === pool &&
    Number.isFinite(frame.deadline) &&
    Date.now() < frame.deadline &&
    (deadline === undefined ||
      (Number.isFinite(deadline) &&
        deadline > Date.now() &&
        (frame.original ? deadline === frame.deadline : deadline <= frame.deadline)))
  );
}

/** Server-only liveness check. The frame says nothing about Source or permission truth. */
export function isLiveIdentitySourceConsumerMaintenance(
  pool: Pool,
  work: IdentitySourceConsumerMaintenanceWork | undefined,
  deadline?: number,
): boolean {
  if (!work || typeof work !== 'object') return false;
  const frame = frames.get(work);
  return !!frame && live(frame, pool, deadline);
}

/** Charge a proved native operation before dispatch. Dispatched work is never refunded. */
export function reserveIdentitySourceConsumerNativeWork(
  pool: Pool,
  work: IdentitySourceConsumerMaintenanceWork | undefined,
  amount: NativeStepWork,
  declaration?: WorkDimensions,
): boolean {
  if (!work || typeof work !== 'object') return false;
  const frame = frames.get(work);
  if (!frame || !live(frame, pool)) return false;
  amount = Object.freeze({ ...amount });
  if (amount.engineRequests !== 0) return false;
  const keys = ['rows', 'points', 'statements', 'bytes', 'engineRequests'] as const;
  if (keys.some((key) => !Number.isSafeInteger(amount[key]) || amount[key] < 0)) return false;
  if (keys.some((key) => frame.used[key] + amount[key] > frame.native[key])) return false;
  if (frame.original) {
    // Five legacy axes are planning data, never an implicit eight-axis declaration.
    if (!declaration) return false;
    try {
      const vector = originalWorkVector(declaration);
      declaration = Object.freeze(
        Object.fromEntries(ORIGINAL_AXES.map((axis, i) => [axis, vector[i]!])) as unknown as WorkDimensions,
      );
      if (
        declaration.nativeRows !== amount.rows ||
        declaration.nativePoints !== amount.points ||
        declaration.statements !== amount.statements ||
        declaration.bytes !== amount.bytes
      )
        return false;
      reserveIdentityOriginalSourceWork(
        frame.original.deps,
        frame.original.parent.original,
        frame.original.parent.jobId,
        declaration,
      );
    } catch {
      return false;
    }
  }
  for (const key of keys) frame.used[key] += amount[key];
  return true;
}

/** Planning snapshot of this invocation's existing native balance, never new funding. */
export function identitySourceConsumerNativeWork(
  pool: Pool,
  work: IdentitySourceConsumerMaintenanceWork | undefined,
  deadline: number,
): NativeStepWork | null {
  if (!work || typeof work !== 'object') return null;
  const frame = frames.get(work);
  if (!frame || !live(frame, pool, deadline)) return null;
  return Object.freeze({
    rows: frame.native.rows - frame.used.rows,
    points: frame.native.points - frame.used.points,
    statements: frame.native.statements - frame.used.statements,
    bytes: frame.native.bytes - frame.used.bytes,
    engineRequests: frame.native.engineRequests - frame.used.engineRequests,
  });
}

/** Return the frame's existing Library ledger after validating pool, invocation and lifetime. */
export function identitySourceConsumerLibraryWork(
  pool: Pool,
  work: IdentitySourceConsumerMaintenanceWork | undefined,
  deadline: number,
): NativeCollectionWork | null {
  if (!work || typeof work !== 'object') return null;
  const frame = frames.get(work);
  return frame && live(frame, pool, deadline) ? frame.library : null;
}

/** Bind the owner's one planned remainder to the existing live ledger for the
 * entire page/receiving/fence continuation. Nested work spends that same balance.
 */
export async function withIdentitySourceConsumerLibraryRemainder<T>(
  pool: Pool,
  work: IdentitySourceConsumerMaintenanceWork,
  deadline: number,
  allowance: WorkAllowance,
  body: (budget: NativeCollectionWork) => Promise<T>,
): Promise<T | null> {
  const frame = frames.get(work);
  if (!frame || !live(frame, pool, deadline)) return null;
  return withNativeCollectionWorkAllowance(frame.library, allowance, () =>
    libraryRemainder.run(frame, async () => {
      if (!live(frame, pool, deadline))
        throw new IdentitySourceOriginalUnavailable(IDENTITY_SOURCE_ORIGINAL_TRANSFER_UNAVAILABLE);
      const result = await body(frame.library);
      if (!live(frame, pool, deadline))
        throw new IdentitySourceOriginalUnavailable(IDENTITY_SOURCE_ORIGINAL_TRANSFER_UNAVAILABLE);
      return result;
    }),
  );
}

/** A durable scope fence must run inside the original page's cumulative plan. */
export function currentIdentitySourceConsumerLibraryRemainder(
  pool: Pool,
  deadline: number,
): NativeCollectionWork | null {
  const frame = libraryRemainder.getStore();
  if (!frame || !live(frame, pool, deadline)) return null;
  frame.library.assertReady();
  return frame.library;
}

/** Current frame for a same-command Source verification whose public signature cannot change. */
export function currentIdentitySourceConsumerMaintenance(
  pool: Pool,
  deadline: number,
): IdentitySourceConsumerMaintenanceWork | null {
  const frame = current.getStore();
  if (!frame || !live(frame, pool, deadline)) return null;
  return frame.token;
}

/** The current async invocation's original Source allocation and deadline for nested History work.
 * Presence is provenance only: callers must still validate the token against the actual Pool,
 * current async frame, and deadline before dispatch. A settled or foreign invocation remains
 * observable so it cannot be mistaken for a genuinely absent Source frame. */
export function activeIdentitySourceConsumerMaintenance(_pool: Pool): IdentitySourceConsumerMaintenanceContext | null {
  const frame = current.getStore();
  if (!frame) return null;
  return Object.freeze({ deadline: frame.deadline, identityConsumerWork: frame.token });
}

function emptyNative(): NativeUsed {
  return { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 };
}

export const IDENTITY_SOURCE_ORIGINAL_TRANSFER_UNAVAILABLE = 'identity-history-original-source-transfer-unavailable';

export class IdentitySourceOriginalUnavailable extends Error {
  constructor(readonly gap: string) {
    super(gap);
  }
}

const receivedOriginals = new WeakSet<object>();

/** The installed Accounts accessors validate the private grant and exact callback,
 * Pool/WorkClient/registry and deadline without consuming or entering it again. */
function authenticateOriginal(deps: HistoryOriginalDependencies, parent: IdentityOriginalSourceContext): void {
  if (!parent || typeof parent !== 'object')
    throw new IdentitySourceOriginalUnavailable('identity-history-original-private-grant-unavailable');
  const library = identityOriginalLibraryWork(deps, parent.original, parent.jobId);
  const transfer = currentIdentityOriginalTransfer(deps, parent.jobId);
  if (!transfer) throw new IdentitySourceOriginalUnavailable('identity-history-original-handle-unavailable');
  const actual = identityOriginalRemainder(deps, transfer, parent.jobId);
  if (
    actual.originalId !== parent.originalId ||
    actual.position !== parent.position ||
    actual.position.job_id !== parent.jobId ||
    actual.deadline !== parent.deadline ||
    actual.source !== parent.native ||
    actual.source === null ||
    actual.library === null ||
    library !== parent.library ||
    !Number.isSafeInteger(parent.deadline) ||
    Date.now() >= parent.deadline
  )
    throw new IdentitySourceOriginalUnavailable('identity-history-original-private-grant-changed');
  originalWorkVector(parent.native);
}

/** Receive INSIDE withIdentityOriginalSourceTransfer. Accounts alone owns the durable
 * debit and settlement. This entry neither consumes nor enters that transfer again. */
export async function withPrepaidIdentitySourceConsumerMaintenance<T>(
  deps: HistoryOriginalDependencies,
  parent: IdentityOriginalSourceContext,
  body: (funded: IdentitySourceConsumerMaintenanceContext) => Promise<T>,
): Promise<T> {
  if (current.getStore()) throw new TypeError('Source maintenance cannot replace its original frame');
  deps = Object.freeze({ pool: deps.pool, client: deps.client, registry: deps.registry });
  parent = Object.freeze({ ...parent });
  authenticateOriginal(deps, parent);
  if (receivedOriginals.has(parent.original))
    throw new IdentitySourceOriginalUnavailable('identity-history-original-source-already-received');
  receivedOriginals.add(parent.original); // Failure/return never reopens this original.
  const token = Object.freeze({ [identitySourceConsumerMaintenance]: true }) as IdentitySourceConsumerMaintenanceWork;
  const frame: Frame = {
    token,
    pool: deps.pool,
    deadline: parent.deadline,
    active: true,
    native: Object.freeze({
      rows: parent.native.nativeRows,
      points: parent.native.nativePoints,
      statements: parent.native.statements,
      bytes: parent.native.bytes,
      engineRequests: 0,
    }),
    used: emptyNative(),
    library: parent.library,
    original: Object.freeze({ deps, parent }),
  };
  frames.set(token, frame);
  const funded = Object.freeze({ deadline: frame.deadline, identityConsumerWork: token });
  return current.run(frame, async () => {
    try {
      // Constrain the exact producer object, preserving its counters and original owner.
      bindNativeCollectionWorkLifetime(frame.library, () => {
        if (!live(frame, frame.pool, frame.deadline))
          throw new IdentitySourceOriginalUnavailable('identity-history-original-source-callback-ended');
      });
      const answer = await body(funded);
      authenticateOriginal(deps, parent);
      frame.library.assertReady();
      return answer;
    } catch (error) {
      // Do not clear producer poison or refund any dispatched partition.
      if (error instanceof Error) {
        try {
          frame.library.failure = error;
        } catch {
          /* Producer lifetime already ended. */
        }
      }
      throw error;
    } finally {
      frame.active = false;
      frames.delete(token);
      // Accounts owns the ledger. Do not close/reset it or read a post-settlement receipt.
    }
  });
}

/** Legacy selected-History entry has no private child context. It cannot admit one. */
export async function withIdentitySourceHistoryOriginalMaintenance<T>(
  deps: HistoryOriginalDependencies,
  jobId: string,
  _body: (funded: IdentitySourceConsumerMaintenanceContext) => Promise<T>,
): Promise<T> {
  const transfer = currentIdentityOriginalTransfer(deps, jobId);
  if (transfer) identityOriginalRemainder(deps, transfer, jobId);
  throw new IdentitySourceOriginalUnavailable(IDENTITY_SOURCE_ORIGINAL_TRANSFER_UNAVAILABLE);
}

/** Source owns one configured frame for the entire actual default-maintenance callback. */
export function withIdentitySourceConsumerMaintenance<T>(
  deps: Readonly<{
    pool: Pool;
    env: Readonly<Record<string, string | undefined>>;
    clock?: KernelClock;
    client?: WorkClient;
    registry?: HistoryRegistry;
    selectedHistoryJob?: string;
  }>,
  context: Readonly<{ deadline: number }>,
  body: (funded: IdentitySourceConsumerMaintenanceContext) => Promise<T>,
): Promise<T> {
  if (current.getStore()) throw new TypeError('Source maintenance cannot replace its original frame');
  // The actual History adapter supplies WorkClient. It may never fall through to
  // the independent native Source admission, including on absent producer source.
  let selectedOriginal = false;
  try {
    selectedOriginal =
      currentIdentityOriginalTransfer(
        { pool: deps.pool, client: deps.client!, registry: deps.registry! },
        deps.selectedHistoryJob ?? '',
      ) !== null;
  } catch {
    selectedOriginal = true; // Present but mismatched ancestry must never fund a fallback.
  }
  if (selectedOriginal || deps.client !== undefined) {
    if (!deps.client || !deps.registry || !deps.selectedHistoryJob)
      throw new IdentitySourceOriginalUnavailable(IDENTITY_SOURCE_ORIGINAL_TRANSFER_UNAVAILABLE);
    return withIdentitySourceHistoryOriginalMaintenance(
      { pool: deps.pool, client: deps.client, registry: deps.registry },
      deps.selectedHistoryJob,
      body,
    );
  }
  const config = readIdentitySourceMaintenanceConfig(deps.env);
  const now = Date.now();
  if (!deps.pool || typeof deps.pool.connect !== 'function') throw new TypeError('Invalid Source maintenance pool');
  if (!Number.isFinite(context.deadline) || context.deadline <= now)
    throw new RangeError('Source maintenance deadline has expired');
  // KernelClock is domain time and does not fund or extend an operation deadline.
  void deps.clock;
  const token = Object.freeze({ [identitySourceConsumerMaintenance]: true }) as IdentitySourceConsumerMaintenanceWork;
  const allowance: WorkAllowance = Object.freeze({
    reservationId: randomUUID(),
    remaining: Object.freeze({ ...config.library }) as WorkDimensions,
  });
  const frame: Frame = {
    token,
    pool: deps.pool,
    deadline: context.deadline,
    active: true,
    native: config.native,
    used: emptyNative(),
    library: new NativeCollectionWork(allowance, context.deadline),
  };
  frames.set(token, frame);
  const funded = Object.freeze({ deadline: context.deadline, identityConsumerWork: token });
  return current.run(frame, async () => {
    try {
      return await body(funded);
    } finally {
      frame.active = false;
      frame.library.close();
      frames.delete(token);
    }
  });
}

/** Presence is ancestry, never independent funding, including after the callback ends. */
export function isPrepaidIdentitySourceConsumerMaintenance(pool: Pool): boolean {
  const frame = current.getStore();
  return !!frame?.original && frame.pool === pool;
}

/** Irreversible private scheduling claim. Accounts has already committed
 * child_entered on this original before issuing the grant. That durable bit and
 * its spent original prevent a restart/new callback from minting this frame again;
 * this bit closes sequential/concurrent attempts INSIDE that one callback too.
 * No new durable Source ledger or caller identifier participates in the claim.
 */
export function claimIdentitySourceCustodyAdvancement(
  pool: Pool,
  work: IdentitySourceConsumerMaintenanceWork,
  deadline: number,
  barrier: Readonly<{ accountId: string; accountRoute: number; version: number; at: string }>,
): boolean {
  const frame = frames.get(work);
  if (!frame || !live(frame, pool, deadline)) return false;
  if (!frame.original) return true;
  const position = frame.original.parent.position;
  if (
    frame.custodyClaimed ||
    position.account_id !== barrier.accountId ||
    position.account_route !== barrier.accountRoute ||
    position.barrier_version !== barrier.version ||
    position.barrier_at !== barrier.at
  )
    return false;
  frame.custodyClaimed = true; // Unavailable, throw and rollback cannot cancel this claim.
  frame.reached = new Map();
  return true;
}

/** Closed per-callsite dispatch guard. A counter is spent before awaiting the
 * operation; escaped handles and absent scheduling claims cannot dispatch.
 */
function claimBoundedCall(pool: Pool, name: string, maximum: number): void {
  const frame = current.getStore();
  if (!frame || !live(frame, pool)) throw new IdentitySourceOriginalUnavailable('identity-source-original-ended');
  if (!frame.original) return;
  if (!frame.custodyClaimed || !frame.reached || !Number.isSafeInteger(maximum) || maximum < 0)
    throw new IdentitySourceOriginalUnavailable('identity-source-custody-step-not-claimed');
  const used = frame.reached.get(name) ?? 0;
  if (used >= maximum) throw new IdentitySourceOriginalUnavailable(`identity-source-schedule-exhausted:${name}`);
  frame.reached.set(name, used + 1);
}

/** Immutable accounting observation, never a scheduling claim or grant. */
export function identitySourceConsumerScheduleReceipt(
  pool: Pool,
  work: IdentitySourceConsumerMaintenanceWork,
  deadline: number,
): Readonly<{ claimed: boolean; calls: Readonly<Record<string, number>> }> | null {
  const frame = frames.get(work);
  if (!frame?.original || !live(frame, pool, deadline)) return null;
  return Object.freeze({
    claimed: frame.custodyClaimed === true,
    calls: Object.freeze(Object.fromEntries(frame.reached ?? [])),
  });
}

export function claimIdentitySourceScheduledCall(pool: Pool, operation: IdentitySourceScheduledOperation): void {
  if (!Object.hasOwn(IDENTITY_SOURCE_ORIGINAL_SCHEDULE.source, operation))
    throw new IdentitySourceOriginalUnavailable('identity-source-unknown-operation');
  claimBoundedCall(pool, `Source.${operation}`, IDENTITY_SOURCE_ORIGINAL_SCHEDULE.source[operation]);
}

export function claimIdentitySourceLibraryCall(pool: Pool, operation: IdentitySourceLibraryOperation): void {
  if (!Object.hasOwn(IDENTITY_SOURCE_ORIGINAL_SCHEDULE.library, operation))
    throw new IdentitySourceOriginalUnavailable('identity-source-unknown-library-operation');
  claimBoundedCall(pool, `Library.${operation}`, IDENTITY_SOURCE_ORIGINAL_SCHEDULE.library[operation]);
}

/** Adapt the genuine private Source partition to Core's delivered single-no-effect
 * executor. Core reserves effect AND cleanup atomically before checkout. Body SQL
 * remains separately priced at its exact callsite. Never use the historical
 * aggregate control reservation for this same command.
 */
export function withIdentitySourceNoEffectCommand<T>(pool: Pool, deadline: number, body: () => Promise<T>): Promise<T> {
  const frame = current.getStore();
  if (!frame || !live(frame, pool, deadline))
    throw new IdentitySourceOriginalUnavailable('identity-source-original-ended');
  if (!frame.original) return body();
  if (!frame.custodyClaimed) throw new IdentitySourceOriginalUnavailable('identity-source-custody-step-not-claimed');
  const { parent } = frame.original;
  return withCommandDispatchLifetime(
    pool,
    deadline,
    Object.freeze({
      original: parent.original,
      validate() {
        if (!live(frame, pool, deadline)) throw new IdentitySourceOriginalUnavailable('identity-source-original-ended');
      },
      reserve(allowance: typeof COMMAND_DISPATCH_ALLOWANCE) {
        if (allowance !== COMMAND_DISPATCH_ALLOWANCE || !live(frame, pool, deadline))
          throw new IdentitySourceOriginalUnavailable('identity-source-command-controls-changed');
        // One atomic reserve includes the independently held rollback. It stays
        // spent on expiry/revocation/failed COMMIT; Core owns same-client cleanup.
        const cost = allowance.total.work;
        if (
          !reserveIdentitySourceConsumerNativeWork(
            pool,
            frame.token,
            {
              rows: cost.nativeRows,
              points: cost.nativePoints,
              statements: cost.statements,
              bytes: cost.bytes,
              engineRequests: 0,
            },
            cost,
          )
        )
          throw new IdentitySourceOriginalUnavailable('identity-source-command-controls-exhausted');
      },
    }),
    body,
  );
}

/** The delivered event profile is distinct from noEffect. The selected immutable
 * barrier account, validator and atomic Source debit all come from the SAME
 * Accounts grant. Library body SQL remains on its existing Library partition.
 */
export function withIdentitySourceFenceCommand<T>(
  pool: Pool,
  deadline: number,
  accountId: string,
  body: () => Promise<T>,
): Promise<T> {
  const frame = current.getStore();
  if (!frame || !live(frame, pool, deadline))
    throw new IdentitySourceOriginalUnavailable('identity-source-original-ended');
  if (!frame.original) return body();
  if (!frame.custodyClaimed || accountId !== frame.original.parent.position.account_id)
    throw new IdentitySourceOriginalUnavailable('identity-source-custody-step-not-claimed');
  return withSourceFenceCommandDispatchLifetime(
    pool,
    deadline,
    Object.freeze({
      original: frame.original.parent.original,
      validate() {
        if (!live(frame, pool, deadline)) throw new IdentitySourceOriginalUnavailable('identity-source-original-ended');
      },
      reserve(allowance: typeof SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE) {
        if (allowance !== SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE || !live(frame, pool, deadline))
          throw new IdentitySourceOriginalUnavailable('identity-source-command-controls-changed');
        const cost = allowance.total.work;
        if (
          !reserveIdentitySourceConsumerNativeWork(
            pool,
            frame.token,
            {
              rows: cost.nativeRows,
              points: cost.nativePoints,
              statements: cost.statements,
              bytes: cost.bytes,
              engineRequests: 0,
            },
            cost,
          )
        )
          throw new IdentitySourceOriginalUnavailable('identity-source-command-controls-exhausted');
      },
    }),
    accountId,
    body,
  );
}

/** Actual owner receiving disposition. There is deliberately no successful
 * IDENTITY_HISTORY_ORIGINAL_SOURCE_DECLARATION export while these reached bodies
 * lack compatible eight-axis declarations. Accounts treats absence as unavailable,
 * rather than accepting total:null or a local-only price as whole-child funding. */
export async function readIdentitySourceOriginalCostDisposition() {
  const {
    IDENTITY_SOURCE_HISTORY_GUARD_DECLARATION,
    IDENTITY_SOURCE_LOCAL_READ_DECLARATIONS,
    IDENTITY_SOURCE_LOCAL_MUTATION_COMPONENTS,
    IDENTITY_SOURCE_LOCAL_CALLS,
    IDENTITY_SOURCE_WIDER_COMMAND_REQUIREMENTS,
  } = await import('./identity-source-consumer-custody.ts');
  const { scopeConsumerFootprint } = await import('./identity-scoped-observations.ts');
  const history = await import('../history/agent-identity-inventory-work.ts');
  const retirement = await import('../history/agent-identity-retirement.ts');
  const library = await import('../library/collection-source-work.ts');
  const effects = await import('../library/identity-scope-effects.ts');
  const ownValue = (module: object, name: string): unknown => {
    const field = Object.getOwnPropertyDescriptor(module, name);
    return field && 'value' in field ? field.value : undefined;
  };
  const libraryValue = ownValue(library, 'IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION');
  const libraryDeclaration =
    libraryValue === undefined
      ? null
      : (() => {
          const declaration = libraryValue as { work: WorkDimensions; engineRequests: 0 };
          // Validate the actual installed owner export, never a caller quotation.
          const checked = composeIdentitySourceReachedCosts([
            { name: 'LibraryAllReachedCalls', calls: 1, declaration },
          ]);
          if (checked.state !== 'complete') throw new TypeError('Installed Library declaration is incomplete');
          return Object.freeze({ work: checked.work, engineRequests: checked.engineRequests });
        })();
  const historyValue = ownValue(history, 'IDENTITY_HISTORY_ACCOUNTS_DECLARATION');
  const historyComponents =
    historyValue === undefined
      ? null
      : (() => {
          const value = historyValue as {
            version: number;
            interface: string;
            sourceReceiver: string;
            engineRequests: number;
            axes: readonly string[];
            local: Record<string, WorkDimensions>;
            sdk: Record<string, WorkDimensions>;
            multiplicities: object;
          };
          if (
            !value ||
            value.version !== 1 ||
            value.interface !== 'withPrepaidAgentIdentityHistoryUnit' ||
            value.sourceReceiver !== 'withPrepaidIdentitySourceConsumerMaintenance' ||
            value.engineRequests !== 0 ||
            JSON.stringify(value.axes) !== JSON.stringify(ORIGINAL_AXES) ||
            !value.local ||
            !value.sdk
          )
            throw new TypeError('Installed History component interface is incompatible');
          const copy = (parts: Record<string, WorkDimensions>) =>
            Object.freeze(
              Object.fromEntries(
                Object.entries(parts).map(([name, work]) => {
                  const vector = originalWorkVector(work);
                  return [
                    name,
                    Object.freeze(
                      Object.fromEntries(
                        ORIGINAL_AXES.map((axis, i) => [axis, vector[i]!]),
                      ) as unknown as WorkDimensions,
                    ),
                  ];
                }),
              ),
            );
          return Object.freeze({
            local: copy(value.local),
            sdk: copy(value.sdk),
            // Delivered prose describes repetitions; it is not an executable maximum.
            // Keep whole composition unavailable until those actual caller guards exist.
            multiplicities: 'requires executable reached History caller multiplicities' as const,
          });
        })();
  const whole = composeIdentitySourceReachedCosts([
    {
      name: 'AccountsLocalControl',
      calls: 1,
      declaration: { work: HISTORY_ORIGINAL_LOCAL_ALLOWANCE, engineRequests: 0 },
    },
    { name: 'SourceHistoryNativeAllReachedCalls', calls: 1, declaration: null },
    { name: 'LibraryAllReachedCalls', calls: 1, declaration: libraryDeclaration },
    {
      name: 'AdditionalOriginalTransferControl',
      calls: 1,
      declaration: { work: ADDITIONAL_ORIGINAL_TRANSFER_CONTROL, engineRequests: 0 },
    },
  ]);
  return Object.freeze({
    state: 'missing' as const,
    whole,
    accountsLocalControl: HISTORY_ORIGINAL_LOCAL_ALLOWANCE,
    additionalOriginalTransferControl: ADDITIONAL_ORIGINAL_TRANSFER_CONTROL,
    local: Object.freeze({
      sourceHistoryGuard: IDENTITY_SOURCE_HISTORY_GUARD_DECLARATION,
      scopeConsumerFootprint,
      reads: IDENTITY_SOURCE_LOCAL_READ_DECLARATIONS,
      mutations: IDENTITY_SOURCE_LOCAL_MUTATION_COMPONENTS,
      callsites: IDENTITY_SOURCE_LOCAL_CALLS,
      command: COMMAND_DISPATCH_ALLOWANCE,
    }),
    schedule: IDENTITY_SOURCE_ORIGINAL_SCHEDULE,
    widerExecutor: IDENTITY_SOURCE_WIDER_COMMAND_REQUIREMENTS,
    historyComponents,
    historyCallableInstalled: typeof ownValue(retirement, 'withPrepaidAgentIdentityHistoryUnit') === 'function',
    libraryDeclaration,
    librarySameWorkCallableInstalled: typeof ownValue(effects, 'readLibraryScopeEffectsPageWithWork') === 'function',
    missing: Object.freeze([
      'Source custody preparation/checkpoint/terminal: complete reached erasure-role, commit, event and binding child declarations',
      'Source current verification: binding/Account technical receiver and reversal settlement eight-axis declarations',
      'Source directory read and final cut: native population/preparePlan declarations',
      'History selected unit: initial stage, repeated H/G/A, inventory, released/current/final receiving, q<=2/c<=64 outbox and role-mutation declarations',
      'History SDK receiving/final progress: withPrepaidAgentIdentityHistoryUnit and SDK eight-axis declarations',
      ...(!libraryDeclaration
        ? [
            'LibraryAllReachedCalls: readLibraryScopeEffectsPageWithWork on the exact original ledger; complete bounded page/current/locked-plan/seal/six-driver declarations; IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION',
          ]
        : []),
      'Core wider executor profile: Source callback/association, custody preparation/checkpoint/finish',
    ]),
  });
}
