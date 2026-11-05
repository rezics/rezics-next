/** Coordinates only. Admission and route/read lifetimes belong to the mounted current reader. */
export type SalesCoordinate = string | undefined;
export type SalesMovement = 'previous' | 'restart' | 'next';
export class CreatorSalesWindows {
  private predecessors: SalesCoordinate[] = [];
  current: SalesCoordinate;
  staged: { movement: SalesMovement; cursor: SalesCoordinate } | undefined;

  constructor(cursor: SalesCoordinate) {
    this.current = cursor;
  }
  get previous(): { cursor: SalesCoordinate } | undefined {
    return this.predecessors.length ? { cursor: this.predecessors.at(-1) } : undefined;
  }
  stage(movement: SalesMovement, cursor: SalesCoordinate) {
    this.staged = { movement, cursor };
  }
  /** Called only for the exact staged coordinate after current-reader ready admission. */
  accept() {
    const target = this.staged!;
    if (target.movement === 'previous') this.predecessors.pop();
    else if (target.movement === 'restart') this.predecessors = [];
    else this.predecessors = [...this.predecessors, this.current].slice(-8);
    this.current = target.cursor;
    this.staged = undefined;
  }
}
