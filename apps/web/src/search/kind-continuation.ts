/** Opaque cursors traversed by one result-kind directory query. */
export class KindContinuationLedger {
  private readonly consumed = new Set<string>();

  repeats(requested: string, next: string | null) {
    return next !== null && (next === requested || this.consumed.has(next));
  }

  consume(cursor: string) {
    this.consumed.add(cursor);
  }
}
