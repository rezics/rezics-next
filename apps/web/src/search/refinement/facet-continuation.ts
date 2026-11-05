/** Opaque facet cursors already consumed by the current refinement query. */
export const MAX_CACHED_FACET_PROPERTIES = 8;
export const MAX_FACET_CONTINUATIONS = 64;

export class FacetContinuationLedger {
  private readonly consumed = new Map<string, Set<string>>();
  private readonly retained = new Set<string>();

  constructor(readonly queryIdentity: string) {}

  retain(properties: readonly string[]) {
    this.retained.clear();
    for (const property of properties.slice(0, MAX_CACHED_FACET_PROPERTIES)) this.retained.add(property);
    for (const property of this.consumed.keys()) if (!this.retained.has(property)) this.consumed.delete(property);
  }

  has(property: string, cursor: string) {
    return this.consumed.get(property)?.has(cursor) ?? false;
  }

  exhausted(property: string) {
    return (this.consumed.get(property)?.size ?? 0) >= MAX_FACET_CONTINUATIONS;
  }

  reset(property: string) {
    this.consumed.delete(property);
  }

  repeats(property: string, requested: string | undefined, next: string | null | undefined) {
    return (
      (requested !== undefined && this.has(property, requested)) ||
      (next !== null && next !== undefined && (next === requested || this.has(property, next)))
    );
  }

  consume(property: string, cursor: string) {
    if (!this.retained.has(property)) return;
    const cursors = this.consumed.get(property) ?? new Set<string>();
    if (cursors.size >= MAX_FACET_CONTINUATIONS && !cursors.has(cursor)) return;
    cursors.add(cursor);
    this.consumed.set(property, cursors);
  }
}
