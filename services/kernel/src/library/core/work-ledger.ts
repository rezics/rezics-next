/** Library-owned request ledger. Search's ScopeWork is a structural consumer, not the owner. */

import type { WorkAllowance, WorkDimensions, WorkReceipt } from '../contract/work-dimensions.ts';

export const WORK_AXES = [
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'emptySeeks',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
] as const satisfies readonly (keyof WorkDimensions)[];

export function zeroWorkDimensions(): WorkDimensions {
  return {
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  };
}

export function workAllowance(keys: number, reservationId: string, remaining?: WorkDimensions): WorkAllowance {
  return {
    reservationId,
    remaining: remaining ?? {
      candidateKeys: keys,
      nativeRows: 65536,
      identityMetadataRows: 16384,
      emptySeeks: 256,
      nativePoints: 4096,
      witnessKeys: 8192,
      statements: 8192,
      bytes: 4 * 1024 * 1024,
    },
  };
}

export class CollectionWorkLedger {
  private spent = { ...zeroWorkDimensions() };
  private readonly root: WorkAllowance;
  readonly plan: unknown;
  constructor(root: WorkAllowance, plan?: unknown) {
    this.root = Object.freeze({ ...root, remaining: Object.freeze({ ...root.remaining }) });
    this.plan = plan;
    if (!root.reservationId) throw new RangeError('Missing Collection work reservation');
    for (const axis of WORK_AXES)
      if (!Number.isSafeInteger(root.remaining[axis]) || root.remaining[axis] < 0)
        throw new RangeError('Invalid Collection work reservation');
  }
  remaining(): WorkAllowance {
    const remaining = { ...zeroWorkDimensions() };
    for (const axis of WORK_AXES) remaining[axis] = this.root.remaining[axis] - this.spent[axis];
    return { reservationId: this.root.reservationId, remaining };
  }
  consume(used: WorkDimensions): void {
    for (const axis of WORK_AXES)
      if (!Number.isSafeInteger(used[axis]) || used[axis] < 0 || used[axis] > this.remaining().remaining[axis])
        throw new RangeError(`Native Collection work exceeded ${axis}`);
    for (const axis of WORK_AXES) this.spent[axis] += used[axis];
  }
  receipt(): WorkReceipt {
    return { reservationId: this.root.reservationId, used: { ...this.spent } };
  }
  native(receipt: WorkReceipt): void {
    if (receipt.reservationId !== this.root.reservationId) throw new TypeError('Foreign Collection reservation');
    this.consume(receipt.used);
  }
}
