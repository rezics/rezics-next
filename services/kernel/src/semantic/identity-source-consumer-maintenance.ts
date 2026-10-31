import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { KernelClock } from '../clock.ts';
import type { NativeStepWork } from './identity-epoch-contract.ts';
import type { WorkDimensions, WorkAllowance } from '../library/collection-source.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
import { readIdentitySourceMaintenanceConfig } from './identity-source-maintenance-config.ts';

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
};

const frames = new WeakMap<IdentitySourceConsumerMaintenanceWork, Frame>();
const current = new AsyncLocalStorage<Frame>();

function live(frame: Frame, pool: Pool, deadline?: number): boolean {
  return (
    frame.active &&
    current.getStore() === frame &&
    frame.pool === pool &&
    Number.isFinite(frame.deadline) &&
    Date.now() < frame.deadline &&
    (deadline === undefined || (Number.isFinite(deadline) && deadline > Date.now() && deadline <= frame.deadline))
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
): boolean {
  if (!work || typeof work !== 'object') return false;
  const frame = frames.get(work);
  if (!frame || !live(frame, pool)) return false;
  const keys = ['rows', 'points', 'statements', 'bytes', 'engineRequests'] as const;
  if (keys.some((key) => !Number.isSafeInteger(amount[key]) || amount[key] < 0)) return false;
  if (keys.some((key) => frame.used[key] + amount[key] > frame.native[key])) return false;
  for (const key of keys) frame.used[key] += amount[key];
  return true;
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

/** Current frame for a same-command Source verification whose public signature cannot change. */
export function currentIdentitySourceConsumerMaintenance(
  pool: Pool,
  deadline: number,
): IdentitySourceConsumerMaintenanceWork | null {
  const frame = current.getStore();
  if (!frame || !live(frame, pool, deadline)) return null;
  return frame.token;
}

function emptyNative(): NativeUsed {
  return { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 };
}

/** Source owns one configured frame for the entire actual default-maintenance callback. */
export function withIdentitySourceConsumerMaintenance<T>(
  deps: Readonly<{
    pool: Pool;
    env: Readonly<Record<string, string | undefined>>;
    clock?: KernelClock;
  }>,
  context: Readonly<{ deadline: number }>,
  body: (funded: IdentitySourceConsumerMaintenanceContext) => Promise<T>,
): Promise<T> {
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
      frames.delete(token);
    }
  });
}
