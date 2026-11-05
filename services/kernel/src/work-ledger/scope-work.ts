import type { WorkAllowance, WorkDimensions, WorkReceipt } from '../library/collection-source.ts';
import type { IdentityScopeWork } from '../semantic/identity-scope-types.ts';
import type { PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import type { LeafWork } from '../semantic/scope-leaf-evidence.ts';

export const scopeWorkAxes = [
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'emptySeeks',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
] as const;
export function zeroScopeWork(): WorkDimensions {
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
/** Compatibility ceilings are independent of the candidate reservation. They never grow on refill. */
export function scopeAllowance(keys: number, reservationId: string, remaining?: WorkDimensions): WorkAllowance {
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
export class ScopeWork {
  private spent = { ...zeroScopeWork() };
  private readonly root: WorkAllowance;
  constructor(root: WorkAllowance) {
    this.root = Object.freeze({ ...root, remaining: Object.freeze({ ...root.remaining }) });
    if (!root.reservationId) throw new RangeError('Missing scope reservation');
    for (const axis of scopeWorkAxes)
      if (!Number.isSafeInteger(root.remaining[axis]) || root.remaining[axis] < 0)
        throw new RangeError('Invalid scope reservation');
  }
  remaining(): WorkAllowance {
    const remaining = { ...zeroScopeWork() };
    for (const axis of scopeWorkAxes) remaining[axis] = this.root.remaining[axis] - this.spent[axis];
    return { reservationId: this.root.reservationId, remaining };
  }
  consume(used: WorkDimensions): void {
    for (const axis of scopeWorkAxes)
      if (!Number.isSafeInteger(used[axis]) || used[axis] < 0 || used[axis] > this.remaining().remaining[axis])
        throw new RangeError(`Native scope work exceeded ${axis}`);
    for (const axis of scopeWorkAxes) this.spent[axis] += used[axis];
  }
  receipt(): WorkReceipt {
    return { reservationId: this.root.reservationId, used: { ...this.spent } };
  }
  native(receipt: WorkReceipt): void {
    if (receipt.reservationId !== this.root.reservationId) throw new TypeError('Foreign scope reservation');
    this.consume(receipt.used);
  }
  identity(work: IdentityScopeWork): void {
    this.consume({
      ...zeroScopeWork(),
      identityMetadataRows: work.rows,
      nativePoints: work.points,
      statements: work.statements,
      bytes: work.bytes,
    });
  }
  public(cost: PublicFilterCost): void {
    // Public producers expose their own independent ceilings. Input keys and point work
    // still settle into this root; output slots cannot refund native candidate work.
    this.consume({
      ...zeroScopeWork(),
      candidateKeys: cost.inputKeys,
      nativePoints: cost.accessPoints + cost.dependencyPoints,
      statements:
        (cost as PublicFilterCost & { statements?: number }).statements ??
        cost.engineSearches + cost.resultWrites + cost.frontierWrites,
      nativeRows: (cost as PublicFilterCost & { rows?: number }).rows ?? 0,
      bytes: (cost as PublicFilterCost & { bytes?: number }).bytes ?? 0,
    });
  }
  leaf(used: LeafWork): void {
    this.consume({
      ...zeroScopeWork(),
      candidateKeys: used.keys,
      nativePoints: used.points,
      witnessKeys: used.witnesses,
      nativeRows: used.rows,
      bytes: used.bytes,
      emptySeeks: used.emptySeeks,
    });
  }
  leafBudget(): LeafWork | null {
    const r = this.remaining().remaining;
    const budget = {
      keys: Math.min(101, r.candidateKeys),
      points: r.nativePoints,
      witnesses: Math.min(100, r.witnessKeys),
      rows: r.nativeRows,
      bytes: r.bytes,
      emptySeeks: r.emptySeeks,
    };
    return Object.values(budget).every((value) => value > 0) ? budget : null;
  }
}
