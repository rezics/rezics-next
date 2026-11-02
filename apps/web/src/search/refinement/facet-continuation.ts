/** Opaque facet cursors already consumed by the current refinement query. */
export class FacetContinuationLedger {
  private readonly consumed = new Map<string, Set<string>>();

  constructor(readonly queryIdentity: string) {}

  has(property: string, cursor: string) {
    return this.consumed.get(property)?.has(cursor) ?? false;
  }

  repeats(property: string, requested: string | undefined, next: string | null | undefined) {
    return (
      (requested !== undefined && this.has(property, requested)) ||
      (next !== null && next !== undefined && (next === requested || this.has(property, next)))
    );
  }

  consume(property: string, cursor: string) {
    const cursors = this.consumed.get(property) ?? new Set<string>();
    cursors.add(cursor);
    this.consumed.set(property, cursors);
  }
}
