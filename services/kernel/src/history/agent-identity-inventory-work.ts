import type { Pool } from 'pg';
import { noEffect, runCommand, withSingleCommandAttempt, type CommandTransaction } from '../command/command.ts';
import type { NativeStepWork } from '../semantic/identity-epoch-contract.ts';
import type { HistoryReceivingContext } from './receiving.ts';
import type { IdentitySourceConsumerMaintenanceContext } from '../semantic/identity-source-consumer-maintenance.ts';

export class IdentityHistoryWorkUnavailable extends Error {
  constructor() {
    super('identity-history-native-funding-unavailable');
  }
}

export const nativeWork = (rows: number, points: number, statements: number, bytes: number): NativeStepWork =>
  Object.freeze({ rows, points, statements, bytes, engineRequests: 0 });

/** Existing Source balance only. Failure and rollback never refund a reservation.
 * Outside that frame the installed History/Work owner remains responsible for its own
 * allocation. An explicit Source token or an active Source frame may never silently skip. */
export async function reserveIdentityHistoryWork(
  pool: Pool,
  amount: NativeStepWork,
  invocation?:
    | Pick<HistoryReceivingContext, 'deadline' | 'identityConsumerWork'>
    | IdentitySourceConsumerMaintenanceContext,
): Promise<void> {
  const owner = await import('../semantic/identity-source-consumer-maintenance.ts');
  const active = invocation?.identityConsumerWork ? invocation : owner.activeIdentitySourceConsumerMaintenance(pool);
  if (!active) return;
  const deadline = invocation?.deadline ?? active.deadline;
  if (
    deadline <= Date.now() ||
    !owner.isLiveIdentitySourceConsumerMaintenance(pool, active.identityConsumerWork, deadline) ||
    !owner.reserveIdentitySourceConsumerNativeWork(pool, active.identityConsumerWork, amount)
  )
    throw new IdentityHistoryWorkUnavailable();
}

// BEGIN, two local settings, time, final setting, native no-effect fence, COMMIT,
// and the failure ROLLBACK slot. No receipt, authorization, event or callback writes.
export const IDENTITY_HISTORY_COMMAND_CONTROL = nativeWork(3, 1, 8, 256);

/** One native attempt. Source and SDK locks belong to the real command transaction.
 * Domain writes here are internal History control state, never a public command receipt. */
export async function identityHistoryCommand<T>(
  pool: Pool,
  context: HistoryReceivingContext,
  body: (tx: CommandTransaction) => Promise<T>,
): Promise<T> {
  await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_COMMAND_CONTROL, context);
  return withSingleCommandAttempt(
    async () =>
      (await runCommand(pool, { partition: 0, deadline: context.deadline }, async (tx) => noEffect(await body(tx))))
        .value,
  );
}

// Closed native child bounds. Each touch has one erasure point, one fence upsert and its erasure FK,
// and at most nine coverage rows (the native definition CHECK has nine families).
export const HISTORY_FAMILY_TOUCH = nativeWork(12, 12, 4, 0);
export const HISTORY_WORK_INVALIDATION = nativeWork(1 + 65 + 65 * 12, 1 + 65 + 65 * 12, 1 + 65 * 4, 0);
export const HISTORY_WORK_WAKE = nativeWork(64 + 64, 1 + 64, 1 + 64, 0);
export const HISTORY_LOCATOR_INVALIDATION = nativeWork(
  12 + 2 * (65 + 64 * 12),
  12 + 2 * (65 + 64 * 12),
  4 + 2 * (1 + 64 * 4),
  0,
);
export const HISTORY_RECEIVING_INVALIDATION = nativeWork(12 + 65 + 64 * 12, 12 + 65 + 64 * 12, 4 + 1 + 64 * 4, 0);

export function addNativeWork(...parts: readonly NativeStepWork[]): NativeStepWork {
  return parts.reduce(
    (a, b) => nativeWork(a.rows + b.rows, a.points + b.points, a.statements + b.statements, a.bytes + b.bytes),
    nativeWork(0, 0, 0, 0),
  );
}
