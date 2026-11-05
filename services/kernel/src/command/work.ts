import {
  AccessWorkAccounting,
  AccessWorkUnavailableError,
  type AccessWork,
  type AccessWorkSink,
} from '../work/access-work.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
import {
  currentCommandWorkAssociation,
  registerCommandWorkAssociation,
  type CommandWorkAssociation,
} from './work-context.ts';
export { currentCommandWorkAssociation, withCommandWorkAssociation } from './work-context.ts';
export type { CommandWorkAssociation, CommandWorkReservation } from './work-context.ts';

const sourceAxes = [
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'emptySeeks',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
] as const satisfies readonly (keyof WorkDimensions)[];

function copyDimensions(value: WorkDimensions | undefined): WorkDimensions | undefined {
  if (!value) return undefined;
  for (const axis of sourceAxes)
    if (!Number.isSafeInteger(value[axis]) || value[axis] < 0) throw new TypeError('Invalid command work bound');
  return Object.freeze(Object.fromEntries(sourceAxes.map((axis) => [axis, value[axis]]))) as unknown as WorkDimensions;
}

function zeroDimensions(): Record<keyof WorkDimensions, number> {
  return Object.fromEntries(sourceAxes.map((axis) => [axis, 0])) as Record<keyof WorkDimensions, number>;
}

function sourceWorkForAccess(work: AccessWork): WorkDimensions {
  return {
    candidateKeys: work.keys,
    nativeRows: work.rows,
    identityMetadataRows: 0,
    emptySeeks: work.emptySeeks,
    nativePoints: work.points,
    witnessKeys: work.witnesses,
    statements: 0,
    bytes: work.bytes,
  };
}

function sourceChargeForAccess(bound: AccessWork, actual: AccessWork): WorkDimensions {
  // Access owner receipts may omit branches that were not dispatched. Source's
  // nativeRows axis is a plan bound and cannot be refunded after dispatch.
  return { ...sourceWorkForAccess(actual), nativeRows: bound.rows };
}

function charge(bound: WorkDimensions, actual: Partial<WorkDimensions> | undefined): WorkDimensions {
  const charged = { ...bound, ...actual };
  for (const axis of sourceAxes)
    if (!Number.isSafeInteger(charged[axis]) || charged[axis] < 0 || charged[axis] > bound[axis])
      throw new TypeError('Command work exceeds its admitted frame');
  if (charged.nativeRows !== bound.nativeRows) throw new TypeError('Dispatched Source row bounds cannot be refunded');
  return charged;
}

/**
 * Associate one original request with its already-derived finite Source envelope.
 * The complete envelope is reserved and dispatched before the caller can begin
 * Collection Access preparation. Every child reservation is drawn from that same
 * envelope, and close settles the root exactly once.
 */
export function createCommandWorkAssociation(
  native: NativeCollectionWork,
  deadline: number,
  envelope: WorkDimensions | undefined,
): CommandWorkAssociation {
  if (
    !(native instanceof NativeCollectionWork) ||
    native.deadlineAt !== deadline ||
    !Number.isFinite(deadline) ||
    Date.now() >= deadline
  )
    throw new TypeError('Invalid original native command work frame or deadline');
  const bound = copyDimensions(envelope);
  if (!bound) throw new AccessWorkUnavailableError('Collection command work envelope');
  const requiredBound = bound;

  native.assertReady();
  const root = native.reserve(requiredBound);
  root.dispatch();

  const used = zeroDimensions();
  const held = zeroDimensions();
  const pending = new Map<number, () => void>();
  let nextReservation = 0;
  let open = true;
  let closeFailure: Error | undefined;

  function reserveFrame(operation: string, candidate: WorkDimensions | undefined) {
    if (!open || currentCommandWorkAssociation() !== association)
      throw new AccessWorkUnavailableError(`${operation}: command work frame`);
    if (typeof operation !== 'string' || operation.length === 0) throw new TypeError('Invalid command work operation');
    native.assertReady();
    if (!Number.isFinite(deadline) || Date.now() >= deadline)
      throw new AccessWorkUnavailableError(`${operation}: deadline`);
    const child = copyDimensions(candidate);
    if (!child) throw new AccessWorkUnavailableError(operation);
    for (const axis of sourceAxes) {
      if (used[axis] + held[axis] + child[axis] > requiredBound[axis])
        throw new AccessWorkUnavailableError(`${operation}: command work capacity`);
    }
    for (const axis of sourceAxes) held[axis] += child[axis];

    const id = nextReservation++;
    let settled = false;
    const finish = (actual: Partial<WorkDimensions> | undefined) => {
      if (settled) throw new TypeError('Command work reservation settled more than once');
      const charged = charge(child, actual);
      for (const axis of sourceAxes) {
        held[axis] -= child[axis];
        used[axis] += charged[axis];
      }
      settled = true;
      pending.delete(id);
    };
    pending.set(id, () => finish(undefined));
    return Object.freeze({ settle: (actual?: Partial<WorkDimensions>) => finish(actual) });
  }

  let association: CommandWorkAssociation;
  const sink: AccessWorkSink = Object.freeze({
    reserve(operation, child) {
      const reservation = reserveFrame(operation, sourceWorkForAccess(child));
      return Object.freeze({
        settle: (actual: AccessWork) => reservation.settle(sourceChargeForAccess(child, actual)),
      });
    },
  });

  association = Object.freeze({
    deadline,
    access: new AccessWorkAccounting(sink, deadline),
    reserve(operation, child) {
      return reserveFrame(operation, child);
    },
    async run<T>(
      operation: string,
      child: WorkDimensions | undefined,
      dispatch: () => Promise<T>,
      actual?: (value: T) => Partial<WorkDimensions> | undefined,
    ): Promise<T> {
      const reservation = association.reserve(operation, child);
      let settled = false;
      try {
        const value = await dispatch();
        reservation.settle(actual?.(value));
        settled = true;
        return value;
      } catch (error) {
        if (!settled) reservation.settle();
        throw error;
      }
    },
    receipt: () => native.receipt(),
    close() {
      if (!open) return closeFailure;
      open = false;
      if (pending.size) {
        closeFailure = new AccessWorkUnavailableError('Collection command work has unsettled dispatched operations');
        for (const finish of [...pending.values()]) finish();
      }
      const actual = { ...used, nativeRows: bound.nativeRows };
      try {
        // Source rows are charged at the admitted outer plan bound. Other axes
        // report the actual child work; untouched reservation capacity is released.
        root.settle(actual);
      } catch (error) {
        closeFailure ??= error instanceof Error ? error : new Error('Failed to settle Collection command work');
      }
      return closeFailure;
    },
  });
  registerCommandWorkAssociation(association);
  return association;
}
