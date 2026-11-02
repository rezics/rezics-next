import type { NativeStepWork } from '../semantic/identity-epoch-contract.ts';
import type { SearchIdentityReceivingContext } from './identity-receiving-native-contract.ts';

const axes = ['rows', 'points', 'statements', 'bytes', 'engineRequests'] as const;
export const searchNativeReceivingZero: NativeStepWork = Object.freeze({
  rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0,
});

/** Refusals preserve the original frame's consumed/reserved work, including failed SQL. */
export class SearchNativeReceivingError extends Error {
  constructor(
    readonly status: 'changed' | 'draining' | 'unavailable',
    detail: string,
    readonly work: NativeStepWork,
    options?: ErrorOptions,
  ) { super(detail, options); }
}

/** Logical row/point upper bounds for the named, keyed SQL, including joined witnesses.
 * Byte bounds cover inputs and returned operational JSON; no engine requests occur here.
 */
export const searchNativeReceivingSqlCost = Object.freeze({
  owner: [1, 1, 256], plan: [3, 3, 20480], prepare: [2, 4, 20480],
  document: [1, 1, 512], lock: [1, 1, 512], writer: [2, 2, 4096],
  action: [1, 1, 1064960], receipt: [1, 1, 1064960],
  hold: [1, 1, 1024], peekHold: [1, 1, 1024], accept: [1, 2, 1024], accepted: [4, 4, 12288],
  bindAcceptance: [1, 1, 512], operation: [4, 4, 12288], dispatch: [1, 2, 10240],
  visible: [1, 1, 1024], apply: [1, 1, 4096], applied: [4, 4, 4096],
  copies: [300, 201, 256256], insertCopies: [100, 100, 256256], copy: [3, 3, 4096], copyLast: [1, 1, 256],
  copyOwner: [4, 4, 4096], reconcile: [1, 1, 4096], pending: [1, 1, 256],
  control: [5, 5, 4096], release: [2, 2, 1024], releaseProof: [2, 2, 1024], drain: [1, 1, 512], drainGate: [1, 1, 512],
} satisfies Record<string, readonly [number, number, number]>);
export type SearchNativeReceivingSql = keyof typeof searchNativeReceivingSqlCost;

export class SearchNativeReceivingWork {
  private used = { ...searchNativeReceivingZero };
  readonly context: SearchIdentityReceivingContext;
  constructor(context: SearchIdentityReceivingContext) {
    // Preserve the original reservation across awaits; caller mutation cannot refill it or extend its deadline.
    const deadline = context.deadline;
    const allowance = Object.freeze({ ...context.allowance });
    if (!Number.isFinite(deadline) || axes.some((axis) =>
      !Number.isSafeInteger(allowance[axis]) || allowance[axis] < 0))
      throw new SearchNativeReceivingError('unavailable', 'Invalid original native work frame', this.snapshot());
    this.context = Object.freeze({ deadline, allowance });
  }
  snapshot(): NativeStepWork { return Object.freeze({ ...this.used }); }
  /** Settle a child that already reserved before dispatch. Expiry cannot erase consumed work. */
  settle(cost: NativeStepWork): void {
    if (axes.some((axis) => !Number.isSafeInteger(cost[axis]) || cost[axis] < 0 ||
      this.used[axis] + cost[axis] > this.context.allowance[axis]))
      this.fail('unavailable', 'Native child exceeded its original reservation');
    for (const axis of axes) this.used[axis] += cost[axis];
  }
  fail(status: SearchNativeReceivingError['status'], message: string): never {
    throw new SearchNativeReceivingError(status, message, this.snapshot());
  }
  reserve(cost: NativeStepWork): void {
    if (Date.now() >= this.context.deadline || axes.some((axis) =>
      !Number.isSafeInteger(cost[axis]) || cost[axis] < 0 ||
      this.used[axis] + cost[axis] > this.context.allowance[axis]))
      this.fail('unavailable', 'Original native work frame or deadline exhausted');
    for (const axis of axes) this.used[axis] += cost[axis];
  }
  sql(name: SearchNativeReceivingSql): void {
    const [rows, points, bytes] = searchNativeReceivingSqlCost[name];
    this.reserve({ rows, points, bytes, statements: 1, engineRequests: 0 });
  }
  page(name: 'copies' | 'insertCopies', count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > 100) this.fail('changed', 'Invalid raw native page size');
    this.reserve({ rows: name === 'copies' ? 3 * count : count,
      points: name === 'copies' ? 1 + 2 * count : count, bytes: 256 + 2560 * count,
      statements: 1, engineRequests: 0 });
  }
  /** BEGIN, SET LOCAL, COMMIT and a possible failed-COMMIT ROLLBACK are reserved before acquisition. */
  readTransaction(): void { this.reserve({ ...searchNativeReceivingZero, statements: 4 }); }
  /** Reserve rollback before any transactional writes, even if the caller catches a refusal. */
  rollback(): void { this.reserve({ ...searchNativeReceivingZero, statements: 1 }); }
  /** The existing executor callback inserts exactly one native commit row. */
  nativeCommit(): void { this.reserve({ rows: 1, points: 1, bytes: 128, statements: 1, engineRequests: 0 }); }
}
