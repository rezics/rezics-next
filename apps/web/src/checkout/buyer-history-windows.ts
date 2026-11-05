/** Navigation coordinates only. Admission and private data stay with the current reader. */
export type BuyerHistoryList = 'orders' | 'entitlements';
export type BuyerHistoryCursor = string | null;
export type BuyerHistoryMovement = 'next' | 'previous' | 'first';
export type BuyerHistoryIntent = Readonly<{
  list: BuyerHistoryList;
  cursor: BuyerHistoryCursor;
  movement: BuyerHistoryMovement;
}>;

type Path = {
  current: BuyerHistoryCursor | undefined;
  predecessors: BuyerHistoryCursor[];
  pending: BuyerHistoryIntent | undefined;
};

export type BuyerHistoryWindow = Readonly<{
  current: BuyerHistoryCursor | undefined;
  previous: BuyerHistoryCursor | undefined;
  predecessorCount: number;
  pending: BuyerHistoryIntent | undefined;
}>;

const emptyPath = (): Path => ({ current: undefined, predecessors: [], pending: undefined });
export const BUYER_HISTORY_PREDECESSORS = 8;

/**
 * One instance belongs to one admitted visit, never a module cache or browser storage.
 * The receiving owner calls admit only after its exact current-reader ready response.
 * No method reads, authorizes, settles a command, or retains a former list body.
 */
export class BuyerHistoryWindows {
  private paths: Record<BuyerHistoryList, Path> = { orders: emptyPath(), entitlements: emptyPath() };
  private retired = false;

  window(list: BuyerHistoryList): BuyerHistoryWindow {
    const path = this.paths[list];
    return {
      current: path.current,
      previous: path.predecessors.at(-1),
      predecessorCount: path.predecessors.length,
      pending: path.pending,
    };
  }

  /** A direct later entry has a current coordinate but no invented predecessor. */
  admitEntry(list: BuyerHistoryList, cursor: BuyerHistoryCursor): boolean {
    const path = this.paths[list];
    if (this.retired || path.pending || path.current === cursor) return false;
    path.predecessors = [];
    path.current = cursor;
    return true;
  }

  /** Stage before dispatch/navigation. Failure keeps this same ticket for explicit Retry. */
  stage(list: BuyerHistoryList, movement: BuyerHistoryMovement, next: BuyerHistoryCursor = null) {
    const path = this.paths[list];
    if (this.retired || path.current === undefined || path.pending) return undefined;
    const cursor = movement === 'previous' ? path.predecessors.at(-1) : movement === 'first' ? null : next;
    if (cursor === undefined) return undefined;
    const intent: BuyerHistoryIntent = Object.freeze({ list, cursor, movement });
    path.pending = intent;
    return intent;
  }

  /**
   * Only the initiating ticket can commit. A late success after cancellation, replacement
   * or another movement must not pop/branch a path. Rejected reads never call this method.
   */
  admit(intent: BuyerHistoryIntent): boolean {
    const path = this.paths[intent.list];
    if (this.retired || path.pending !== intent) return false;
    if (intent.movement === 'first') path.predecessors = [];
    else if (intent.movement === 'previous') path.predecessors.pop();
    else if (path.current !== undefined) {
      path.predecessors.push(path.current);
      if (path.predecessors.length > BUYER_HISTORY_PREDECESSORS) path.predecessors.shift();
    }
    path.current = intent.cursor;
    path.pending = undefined;
    return true;
  }

  /** Cancellation consumes the ticket; it does not admit its requested coordinate. */
  cancel(intent: BuyerHistoryIntent): void {
    const path = this.paths[intent.list];
    if (path.pending === intent) path.pending = undefined;
  }

  /** Called synchronously by the existing visit owner for every replacement or disposal. */
  retire(): void {
    this.retired = true;
    this.paths = { orders: emptyPath(), entitlements: emptyPath() };
  }
}
