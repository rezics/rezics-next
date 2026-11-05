/** Finite traversal history for one mounted result-kind query, including local restarts. */
export class KindContinuationLedger {
  private readonly consumed = new Set<string>();
  private readonly seen = new Set<string>();
  private successful = 0;

  constructor(private readonly initial: readonly string[]) {
    this.restart();
  }

  get limited() {
    return this.successful >= 32;
  }

  /** A local return to the accepted start does not renew the mounted query's read budget. */
  restart() {
    this.consumed.clear();
    this.seen.clear();
    for (const id of this.initial) this.seen.add(id);
  }

  accept(requested: string, ids: readonly string[], next: string | null) {
    if (this.limited) return false;
    this.successful++;
    if (
      ids.length > 8 ||
      (ids.length === 0 && next !== null) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => this.seen.has(id)) ||
      (next !== null && (next === requested || this.consumed.has(next)))
    )
      return false;
    this.consumed.add(requested);
    for (const id of ids) this.seen.add(id);
    return true;
  }
}
